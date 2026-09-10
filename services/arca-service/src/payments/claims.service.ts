import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { PaymentClaim } from './payment-claim.entity';
import { ListingRef } from './listing-ref.entity';
import { ArcaTokenService } from './arca-token.service';
import { SubscriptionsService } from './subscriptions.service';

/**
 * Verifying that a marketplace payment happened, from a transaction hash.
 *
 * THE SHAPE OF THE PROBLEM. ARCANA never receives the money: the buyer pays the
 * creator directly and then tells us a hash. So every fact this service acts on
 * has to come from the CHAIN, and nothing may come from the claim itself except
 * the hash and the listing.
 *
 * That inverts who is trusted. Under §10 the deposit address was ours, so a
 * payment could only arrive somewhere we controlled and a stranger could not
 * submit one. Here a transaction hash is public the moment it is mined, and the
 * two attacks that follow are free to mount:
 *
 *   - claiming somebody ELSE'S payment (the sender check answers this)
 *   - spending ONE payment on MANY listings (the UNIQUE on tx_hash answers it)
 *
 * Neither needs any access to ARCANA, so neither is treated as unlikely.
 */
@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);

  /**
   * How many blocks before a payment counts.
   *
   * NOT 12. That default came from `ARCA_CONFIRMATIONS`, which is Ethereum's
   * convention — 12 blocks at ~12 seconds each, about two and a half minutes.
   * Robinhood Chain produces a block every **0.100 seconds** (measured across
   * 100, 1,000, 10,000 and 100,000 blocks, all agreeing). The same 12 there is
   * **1.2 seconds** here: the identical number carrying roughly a hundred and
   * twenty-fifth of the protection, while looking like a considered choice.
   *
   * 600 blocks is about 60 seconds. Chosen in wall-clock terms because that is
   * the thing a reorg happens in; the block count is derived from it, not the
   * other way round. The service logs both at boot so nobody has to redo this
   * arithmetic to know what the setting means.
   */
  private readonly minConfirmations: number;

  /**
   * How old a payment may be and still buy something.
   *
   * Without a bound, ANY historical transfer from a buyer to a creator becomes
   * a claim — a tip, an unrelated trade, last year's subscription. The buyer
   * genuinely sent that money to that creator, so every other check passes.
   * Only recency separates "this payment was for this" from "these two people
   * have transacted before".
   */
  private readonly maxAgeSeconds: number;

  constructor(
    @InjectRepository(PaymentClaim) private readonly claims: Repository<PaymentClaim>,
    @InjectRepository(ListingRef) private readonly listings: Repository<ListingRef>,
    private readonly token: ArcaTokenService,
    private readonly subs: SubscriptionsService,
    private readonly db: DataSource,
    config: ConfigService,
  ) {
    this.minConfirmations = parseInt(
      config.get<string>('ARCA_CLAIM_MIN_CONFIRMATIONS') ?? '600', 10);
    this.maxAgeSeconds = parseInt(
      config.get<string>('ARCA_CLAIM_MAX_AGE_HOURS') ?? '24', 10) * 3600;

    const seconds = (this.minConfirmations * 0.1).toFixed(1);
    this.logger.log(
      `payment claims: ${this.minConfirmations} confirmations (~${seconds}s at 0.100 s/block), ` +
      `payments accepted up to ${this.maxAgeSeconds / 3600}h old`);
  }

  /**
   * Verify a payment and grant access.
   *
   * `claimant` is the signed-in wallet, taken from the session by the caller —
   * never from the request body. The whole point of the sender check is that it
   * compares the chain against an identity somebody proved.
   */
  async claim(claimant: string, listingId: string, txHash: string): Promise<{
    granted: true; listing_id: string; tx_hash: string; amount: string;
    confirmations: number; expires_at: Date;
  }> {
    const hash = (txHash ?? '').trim().toLowerCase();

    // 1. Shape. Rejected before anything is looked up, so a malformed hash
    //    never reaches the chain or the database.
    if (!/^0x[0-9a-f]{64}$/.test(hash)) {
      throw new BadRequestException({
        code: 'malformed_tx_hash',
        message: 'A transaction hash is 0x followed by 64 hexadecimal characters.',
      });
    }

    // 2. ALREADY CLAIMED. Checked first among the real checks, deliberately:
    //    replay is the attack this whole design turns on, and a replay attempt
    //    should cost an index lookup rather than three RPC round trips.
    //
    //    This is an optimisation, not the guard. Two simultaneous claims of the
    //    same hash both pass here; the UNIQUE constraint settles it at insert.
    const seen = await this.claims.findOne({ where: { txHash: hash } });
    if (seen) {
      throw new ConflictException({
        code: 'tx_already_claimed',
        message:
          `Transaction ${hash} has already been used to claim listing ${seen.listingId}. ` +
          'A payment buys one thing.',
      });
    }

    // 3. The listing, and the wallet the money had to reach.
    const listing = await this.listings.findOne({ where: { id: listingId, active: true } });
    if (!listing) {
      throw new NotFoundException({
        code: 'listing_not_found', message: `Listing ${listingId} not found or inactive`,
      });
    }
    if (listing.arcaGateAmount == null) {
      throw new BadRequestException({
        code: 'listing_has_no_price',
        message: `Listing ${listingId} has no arca_gate_amount; there is no amount to check against.`,
      });
    }

    const creatorWallet = await this.creatorWalletFor(listing.agentId);
    if (!creatorWallet) {
      // Refusing is the only honest answer: with no wallet on file there is no
      // address the payment could have been verified against, and accepting
      // would mean believing the claim instead of the chain.
      throw new BadRequestException({
        code: 'creator_has_no_wallet',
        message:
          `The creator of listing ${listingId} has no wallet_address on file, so there is ` +
          'nothing to verify a payment against.',
      });
    }

    // 4. CAN WE CHECK AT ALL? An unreadable chain is not a rejection and not an
    //    acceptance. Same shape as auth's 503 and the entitlement layer's
    //    `enforced: null`: "could not find out" is its own answer.
    if (!this.token.enabled) {
      throw new ServiceUnavailableException({
        code: 'payment_verification_unavailable',
        message:
          'Payment verification is not configured (ARCA_TOKEN_ADDRESS / ARCA_RPC_URL). ' +
          'This is not a judgement about your transaction — nothing was checked.',
      });
    }

    let receipt: Awaited<ReturnType<ArcaTokenService['getReceipt']>>;
    let head: bigint;
    try {
      [receipt, head] = await Promise.all([
        this.token.getReceipt(hash as `0x${string}`),
        this.token.getBlockNumber(),
      ]);
    } catch (e) {
      this.logger.error(`chain unreadable while verifying ${hash}: ${e}`);
      throw new ServiceUnavailableException({
        code: 'payment_verification_unavailable',
        message:
          'The chain could not be read, so this transaction was not checked. Try again shortly. ' +
          'Nothing about your payment has been judged.',
      });
    }

    // 5. Does it exist yet? A transaction that is pending is not a fraudulent
    //    one, and telling the two apart is the difference between "wait" and
    //    "that never happened".
    if (!receipt) {
      const pending = await this.token.transactionExists(hash as `0x${string}`);
      throw new BadRequestException(
        pending
          ? { code: 'tx_pending', message: `Transaction ${hash} has not been mined yet. Try again once it confirms.` }
          : { code: 'tx_not_found', message: `No transaction ${hash} exists on this chain.` },
      );
    }

    // 6. DID IT SUCCEED? A reverted transaction has a hash, a receipt, a block
    //    and a gas bill — and moved nothing. Every other check below would pass
    //    on the logs it does not have, so this one has to come first.
    if (receipt.status !== 'success') {
      throw new BadRequestException({
        code: 'tx_reverted',
        message: `Transaction ${hash} reverted. It cost gas and transferred nothing.`,
      });
    }

    // 7. Confirmations.
    const confirmations = Number(head - receipt.blockNumber) + 1;
    if (confirmations < this.minConfirmations) {
      throw new BadRequestException({
        code: 'insufficient_confirmations',
        message:
          `Transaction ${hash} has ${confirmations} confirmations; ${this.minConfirmations} ` +
          `are required (about ${(this.minConfirmations * 0.1).toFixed(0)} seconds on this chain).`,
      });
    }

    // 8. THE TOKEN, BY ADDRESS. Never by symbol().
    //
    //    On a permissionless chain anyone can deploy a token calling itself
    //    ARCA — one token on this chain reports a symbol several thousand
    //    characters long — and a transfer of it would satisfy every other check
    //    here. The configured address is the only thing that cannot be forged,
    //    so it is the only thing consulted.
    //
    //    All matching transfers in the transaction are summed rather than the
    //    first taken: a payer splitting the amount across two transfers in one
    //    transaction has still paid.
    const transfers = this.token.transfersIn(receipt).filter(
      (t) =>
        t.token.toLowerCase() === this.token.tokenAddress!.toLowerCase() &&
        t.to.toLowerCase() === creatorWallet.toLowerCase(),
    );
    if (transfers.length === 0) {
      throw new BadRequestException({
        code: 'no_matching_transfer',
        message:
          `Transaction ${hash} contains no transfer of the $ARCA token to the creator's wallet ` +
          `${creatorWallet}. Transfers of other tokens, and to other addresses, do not count.`,
      });
    }

    // 9. THE SENDER. The claimant must be who paid.
    //
    //    Without this, a transaction hash — public the moment it is mined —
    //    lets anybody watching the chain claim a payment somebody else made.
    const fromClaimant = transfers.filter(
      (t) => t.from.toLowerCase() === claimant.toLowerCase());
    if (fromClaimant.length === 0) {
      throw new BadRequestException({
        code: 'sender_is_not_claimant',
        message:
          `Transaction ${hash} was not sent by ${claimant}. A payment can only be claimed by ` +
          'the wallet that made it.',
      });
    }

    // 10. Amount.
    const paid = fromClaimant.reduce((sum, t) => sum + t.value, 0n);
    const required = this.baseUnits(listing.arcaGateAmount);
    if (paid < required) {
      throw new BadRequestException({
        code: 'insufficient_amount',
        message:
          `Transaction ${hash} transferred ${paid} base units; listing ${listingId} costs ` +
          `${required}. Underpayment does not grant access.`,
      });
    }

    // 11. Freshness. See maxAgeSeconds.
    let blockTime: Date;
    try {
      blockTime = await this.token.getBlockTime(receipt.blockNumber);
    } catch (e) {
      this.logger.error(`chain unreadable reading block time for ${hash}: ${e}`);
      throw new ServiceUnavailableException({
        code: 'payment_verification_unavailable',
        message: 'The chain could not be read while dating this transaction. Nothing was judged.',
      });
    }
    const ageSeconds = Math.floor((Date.now() - blockTime.getTime()) / 1000);
    if (ageSeconds > this.maxAgeSeconds) {
      throw new BadRequestException({
        code: 'tx_too_old',
        message:
          `Transaction ${hash} is ${Math.floor(ageSeconds / 3600)}h old; payments must be claimed ` +
          `within ${this.maxAgeSeconds / 3600}h. An older transfer between the same two wallets ` +
          'is not evidence that it was meant for this listing.',
      });
    }

    // 12. Record, then grant. In that order, and the order matters.
    //
    //     The INSERT is where replay is actually stopped: two concurrent claims
    //     of one hash both reach here, and exactly one survives the UNIQUE
    //     constraint. Granting first would let the loser of that race grant
    //     access before losing.
    try {
      await this.claims.insert({
        txHash: hash,
        listingId,
        buyerWallet: fromClaimant[0].from.toLowerCase(),
        creatorWallet: creatorWallet.toLowerCase(),
        tokenAddress: this.token.tokenAddress!.toLowerCase(),
        amount: paid.toString(),
        blockNumber: receipt.blockNumber.toString(),
        blockTime,
        confirmations,
        claimedBy: claimant.toLowerCase(),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/duplicate key|unique/i.test(msg)) {
        // Lost the race. The other claim is the real one.
        throw new ConflictException({
          code: 'tx_already_claimed',
          message: `Transaction ${hash} has already been used to claim a listing.`,
        });
      }
      throw e;
    }

    const sub = await this.subs.grant(claimant, listingId);
    this.logger.log(
      `payment verified ${hash}: ${claimant} -> listing ${listingId}, ${paid} units, ` +
      `${confirmations} confirmations`);

    return {
      granted: true,
      listing_id: listingId,
      tx_hash: hash,
      amount: paid.toString(),
      confirmations,
      expires_at: sub.expiresAt,
    };
  }

  /** The creator's wallet for a listing, via its agent. */
  private async creatorWalletFor(agentId: string): Promise<string | null> {
    const rows: Array<{ wallet_address: string | null }> = await this.db.query(
      `SELECT c.wallet_address FROM agents a
         JOIN creators c ON c.id = a.creator_id
        WHERE a.id = $1`,
      [agentId],
    );
    return rows[0]?.wallet_address ?? null;
  }

  /**
   * `arca_gate_amount` is NUMERIC(20,8) — a human amount. Converted to base
   * units with the token's decimals, using string arithmetic rather than
   * floating point: a price is money, and 0.1 + 0.2 is a bad way to hold it.
   */
  private baseUnits(human: string): bigint {
    const decimals = this.token.decimals;
    const [whole, frac = ''] = human.trim().split('.');
    const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
    return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
  }
}
