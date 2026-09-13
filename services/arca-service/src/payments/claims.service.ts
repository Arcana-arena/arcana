import {
  BadRequestException,
  ConflictException,
  Inject,
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
import { Erc20Reader, PAYMENT_TOKEN } from './arca-token.service';
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
    // THE PAYMENT TOKEN, named explicitly. This path verifies what a buyer
    // actually sent a creator, which is USDG — not the token an entitlement
    // is gated on. Asking for PAYMENT_TOKEN can only ever get the payment
    // token; a bare type could have received either.
    @Inject(PAYMENT_TOKEN) private readonly token: Erc20Reader,
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

    // NAMES THE TOKEN AT BOOT. The marketplace is paid in one token and gated
    // on another, and the single most expensive mistake available here is the
    // two being swapped without anyone noticing. An operator reading the
    // journal should not have to infer which is which from a variable name.
    if (this.token.enabled) {
      this.logger.log(
        `payments are settled in the token at ${this.token.tokenAddress} ` +
        `(from ${this.token.configVar}). Its decimals are read from the chain, never assumed.`);
    } else {
      this.logger.warn(
        `payment claims INACTIVE: ${this.token.configVar} or ARCA_RPC_URL is not set. ` +
        'Every claim will refuse with 503 payment_verification_unavailable, which is ' +
        'correct — nothing is being judged.');
    }
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
      throw new ConflictException(await this.alreadyClaimed(seen, hash));
    }

    // 3. The listing, the wallet the money had to reach, and the amount.
    //
    // resolvePayable() — the SAME call the quote endpoint makes. See its
    // comment: two implementations of "who gets paid and how much" is how a
    // buyer is shown one address and verified against another.
    const { creatorWallet } = await this.resolvePayable(listingId);

    // 4. CAN WE CHECK AT ALL? An unreadable chain is not a rejection and not an
    //    acceptance. Same shape as auth's 503 and the entitlement layer's
    //    `enforced: null`: "could not find out" is its own answer.
    if (!this.token.enabled) {
      throw new ServiceUnavailableException({
        code: 'payment_verification_unavailable',
        message:
          `Payment verification is not configured (${this.token.configVar} / ARCA_RPC_URL). ` +
          'This is not a judgement about your transaction — nothing was checked.',
      });
    }

    let receipt: Awaited<ReturnType<Erc20Reader['getReceipt']>>;
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
      const remaining = this.minConfirmations - confirmations;
      throw new BadRequestException({
        code: 'insufficient_confirmations',
        message:
          `Transaction ${hash} has ${confirmations} confirmations; ${this.minConfirmations} ` +
          `are required (about ${(this.minConfirmations * 0.1).toFixed(0)} seconds on this chain).`,
        // NOT A REFUSAL — A WAIT, and the difference has to be legible to
        // whatever is drawing a progress bar. These fields let a caller show
        // how far along the transaction is instead of an error, which is the
        // truth: nothing is wrong with this payment yet.
        pending: true,
        confirmations,
        required_confirmations: this.minConfirmations,
        remaining_confirmations: remaining,
        estimated_seconds_remaining: Math.ceil(remaining * 0.1),
        block_number: receipt.blockNumber.toString(),
        chain_head: head.toString(),
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
      // WHERE THE MONEY ACTUALLY WENT, not just where it should have gone.
      //
      // "No matching transfer" is true and almost useless: the buyer cannot
      // tell whether they paid the wrong address, sent the wrong token, or
      // pasted the hash of something unrelated. Those are three different
      // mistakes with three different next steps, and the receipt already in
      // hand distinguishes them. So the actual recipients and tokens are
      // listed — ARCANA cannot recover the money either way, and the least it
      // can do is say where it went.
      const all = this.token.transfersIn(receipt);
      const expected = creatorWallet.toLowerCase();
      const wanted = this.token.tokenAddress!.toLowerCase();
      const decimals = await this.token.getDecimals().catch(() => null);
      const sent = all.map((t) => ({
        to: t.to.toLowerCase(),
        from: t.from.toLowerCase(),
        token: t.token.toLowerCase(),
        amount_base_units: t.value.toString(),
        amount: decimals === null ? null : this.human(t.value, decimals),
        right_token: t.token.toLowerCase() === wanted,
        right_recipient: t.to.toLowerCase() === expected,
      }));
      const rightTokenWrongPayee = sent.filter((t) => t.right_token && !t.right_recipient);
      throw new BadRequestException({
        code: 'no_matching_transfer',
        message:
          rightTokenWrongPayee.length > 0
            ? `Transaction ${hash} transferred the payment token to ` +
              `${rightTokenWrongPayee.map((t) => t.to).join(', ')}, not to the creator's wallet ` +
              `${expected}. ARCANA does not control the receiving address and cannot recover it.`
            : `Transaction ${hash} contains no transfer of the payment token to the creator's wallet ` +
              `${expected}. Transfers of other tokens, and to other addresses, do not count.`,
        expected_recipient: expected,
        expected_token: wanted,
        // Empty means the transaction moved no ERC-20 at all — a different
        // fact from "it moved some to the wrong place", and the caller can
        // tell which from the array rather than from the prose.
        transfers: sent,
        wrong_recipient: rightTokenWrongPayee.length > 0,
        decimals,
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
    //
    // requiredBaseUnits() — THE SAME CALL THE QUOTE MAKES. A buyer is shown a
    // figure and then verified against one, and if those came from two
    // conversions they would agree until the day they did not: the scale here
    // is a power of ten read from the token, so a divergence is not a rounding
    // error, it is a factor of a million. One implementation, two callers.
    const paid = fromClaimant.reduce((sum, t) => sum + t.value, 0n);
    const required = await this.requiredBaseUnits(listingId, hash);
    if (paid < required) {
      // THE SHORTFALL, IN THE UNITS THE BUYER TYPED.
      //
      // "transferred 39950000 base units; costs 40000000" is arithmetic the
      // person who just lost money should not have to do. Base units stay in
      // the body because they are what the chain carries and what a support
      // conversation needs, but the human figures are stated beside them, and
      // so is the difference — which is the only number that tells the buyer
      // what to send next.
      const decimals = await this.token.getDecimals().catch(() => null);
      throw new BadRequestException({
        code: 'insufficient_amount',
        message:
          decimals === null
            ? `Transaction ${hash} transferred ${paid} base units; listing ${listingId} costs ` +
              `${required}. Underpayment does not grant access.`
            : `Transaction ${hash} transferred ${this.human(paid, decimals)}; this listing costs ` +
              `${this.human(required, decimals)}. It is short by ${this.human(required - paid, decimals)}. ` +
              'The creator has received what was sent — ARCANA never held it and cannot refund it.',
        paid_base_units: paid.toString(),
        required_base_units: required.toString(),
        shortfall_base_units: (required - paid).toString(),
        paid: decimals === null ? null : this.human(paid, decimals),
        required: decimals === null ? null : this.human(required, decimals),
        shortfall: decimals === null ? null : this.human(required - paid, decimals),
        decimals,
        tx_hash: hash,
        // THE REMEDY, STATED AS IT ACTUALLY WORKS AND NOT AS IT OUGHT TO.
        //
        // Every claim is verified against ONE transaction: the amount check
        // sums the transfers inside that receipt and nothing outside it. So a
        // top-up sent afterwards is a second transaction that is also short,
        // and claiming it fails the same way. Telling a buyer "send the
        // difference and the two will be matched" would be describing a
        // feature that does not exist, to somebody who has already lost money
        // once by trusting this page.
        remedy:
          'Each claim is checked against one transaction, and the sum inside it. A top-up sent ' +
          'afterwards is a separate transfer and will be short on its own, so it cannot complete this ' +
          'one. To buy the listing, send the full amount in a single transfer and claim that hash ' +
          `within ${this.maxAgeSeconds / 3600}h. The amount already sent is the creator's; recovering ` +
          'it is between you and them.',
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

  /**
   * A hash that has already bought something — and WHAT it bought.
   *
   * The bare refusal named a listing id and nothing else, which leaves the
   * buyer unable to tell an honest mistake (pasting the hash of last month's
   * renewal) from a real problem (somebody else used their transaction). Both
   * end in the same 409, so the body has to carry the difference: which
   * listing, which agent, when, by which wallet, and whether that term is still
   * running. Nothing here is private — it is all about the caller's own hash,
   * and a hash is public the moment it is mined.
   */
  private async alreadyClaimed(seen: PaymentClaim, hash: string) {
    let bought: {
      listing_id: string;
      agent_id: string | null;
      agent_name: string | null;
      creator_handle: string | null;
    } | null = null;
    try {
      const rows = await this.db.query(
        `SELECT l.id::text AS listing_id, a.id::text AS agent_id, a.name AS agent_name,
                c.handle AS creator_handle
           FROM marketplace_listings l
           LEFT JOIN agents a   ON a.id = l.agent_id
           LEFT JOIN creators c ON c.id = a.creator_id
          WHERE l.id = $1`,
        [seen.listingId],
      );
      bought = rows[0] ?? null;
    } catch (e) {
      // The refusal itself does not depend on this lookup. A failure to
      // decorate must not turn a correct 409 into a 500.
      this.logger.warn(`could not describe the earlier claim on ${hash}: ${e}`);
    }

    let term: { expires_at: string; status: string; in_grace: boolean } | null = null;
    try {
      const rows = await this.db.query(
        `SELECT expires_at, status FROM subscriptions
          WHERE listing_id = $1 AND lower(user_wallet) = lower($2)
          ORDER BY expires_at DESC LIMIT 1`,
        [seen.listingId, seen.buyerWallet],
      );
      if (rows[0]) {
        const expires = new Date(rows[0].expires_at);
        term = {
          expires_at: expires.toISOString(),
          status: rows[0].status,
          in_grace: expires <= new Date() && expires >= this.subs.graceCutoff(),
        };
      }
    } catch (e) {
      this.logger.warn(`could not read the term bought by ${hash}: ${e}`);
    }

    return {
      code: 'tx_already_claimed',
      message:
        `Transaction ${hash} has already been used to claim ` +
        (bought?.agent_name ? `${bought.agent_name} ` : `listing ${seen.listingId} `) +
        `on ${new Date(seen.blockTime ?? seen.claimedAt ?? new Date()).toISOString().slice(0, 10)}. ` +
        'A payment buys one thing. Nothing was charged now.',
      tx_hash: hash,
      claimed_listing_id: seen.listingId,
      claimed_agent_id: bought?.agent_id ?? null,
      claimed_agent_name: bought?.agent_name ?? null,
      claimed_creator_handle: bought?.creator_handle ?? null,
      claimed_by_wallet: seen.buyerWallet,
      // The buyer is nearly always the same person, and saying so out loud
      // turns an alarming refusal into an ordinary one.
      claimed_at: (seen.blockTime ?? seen.claimedAt ?? null)
        ? new Date((seen.blockTime ?? seen.claimedAt) as Date).toISOString()
        : null,
      term,
      remedy:
        'To renew, make a new transfer for the current quote and claim that hash. Nothing was charged ' +
        'by this attempt.',
    };
  }

  /** Base units to the human figure, exactly, without floating point. */
  private human(v: bigint, decimals: number): string {
    const neg = v < 0n;
    const abs = neg ? -v : v;
    const s = abs.toString().padStart(decimals + 1, '0');
    const whole = s.slice(0, s.length - decimals);
    const frac = decimals === 0 ? '' : `.${s.slice(s.length - decimals)}`;
    return `${neg ? '-' : ''}${whole}${frac}`;
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
   *
   * `decimals` is READ FROM THE TOKEN, not configured. See
   * ArcaTokenService.getDecimals().
   */
  /**
   * WHO GETS PAID, FOR ONE LISTING. The single source.
   *
   * THE ATTACK THIS CLOSES. Until now nothing in the API told a buyer which
   * address to send to, so the answer came from outside the platform — a chat
   * message, a screenshot, a website. That is exactly how payment redirection
   * works: anyone who can substitute an address in that path takes the money,
   * and ARCANA's verification then refuses their claim **correctly, after the
   * money is gone**. A refusal that arrives after the loss is not a defence.
   *
   * So the listing states its own payee, and it states it from the row the
   * VERIFICATION reads — not from a parallel query that happens to agree
   * today. `claim()` and `quote()` both call this. Two lookups of "who gets
   * paid" is the same failure as two definitions of the access rule, which
   * this project has already had once and which drifted.
   *
   * Every refusal here is one a buyer must see BEFORE paying rather than
   * after, which is the whole reason this method is reachable from a read.
   */
  async resolvePayable(listingId: string): Promise<{
    listing: ListingRef;
    creatorWallet: string;
  }> {
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
      //
      // Reaching this from a QUOTE is the point. A buyer now learns the
      // listing is unbuyable before sending anything, instead of after.
      throw new BadRequestException({
        code: 'creator_has_no_wallet',
        message:
          `The creator of listing ${listingId} has no wallet_address on file, so there is ` +
          'nothing to verify a payment against. This listing cannot be bought — do not send ' +
          'anything for it.',
      });
    }
    return { listing, creatorWallet };
  }

  /**
   * HOW MUCH, in base units, for one listing. The single source.
   *
   * `hashForLog` is only used to make an unreadable-token error name the claim
   * it happened during; a quote passes nothing.
   */
  async requiredBaseUnits(listingId: string, hashForLog?: string): Promise<bigint> {
    const { listing } = await this.resolvePayable(listingId);
    let decimals: number;
    try {
      decimals = await this.token.getDecimals();
    } catch (e) {
      this.logger.error(
        `cannot read decimals()${hashForLog ? ` while verifying ${hashForLog}` : ''}: ${e}`);
      throw new ServiceUnavailableException({
        code: 'payment_verification_unavailable',
        message:
          "The token's decimals could not be read, so no amount could be established. " +
          'Nothing has been judged — do not send a payment until this endpoint answers.',
      });
    }
    return this.baseUnits(listing.arcaGateAmount!, decimals);
  }

  /**
   * The rules every subscription is sold under, from the values in force.
   *
   * READ FROM THE SAME FIELDS THE VERIFICATION USES, not from a documentation
   * page that was accurate when it was written. Every number a buyer is quoted
   * about the term, the grace window, the claim deadline and the confirmation
   * depth comes from here, so a change to any of them changes the docs in the
   * same deploy.
   *
   * `payments_configured: false` is not "payments are free" and not "there is
   * no token" — it is this service saying it cannot verify anything right now,
   * and the terms it can still state are stated anyway.
   */
  terms() {
    return {
      term_days: this.subs.termDays,
      grace_hours: this.subs.graceHours,
      claim_within_hours: this.maxAgeSeconds / 3600,
      min_confirmations: this.minConfirmations,
      // Wall-clock, because block counts mean nothing without the block time —
      // this chain produces one every 0.100s and the same 12 that is two and a
      // half minutes on Ethereum is 1.2 seconds here.
      approx_confirmation_seconds: Math.round(this.minConfirmations * 0.1),
      payments_configured: this.token.enabled,
      payment_token: this.token.enabled ? this.token.tokenAddress : null,
      payment_token_source: this.token.configVar,
      chain: this.token.chainName,
      refundable: false,
      refund_note:
        'A buyer pays the creator directly. ARCANA never receives the money and therefore cannot ' +
        'refund it, reverse it, or recover it from a wrong address or a wrong amount. This is a ' +
        'consequence of taking no fee and holding no funds, and it is stated before payment rather ' +
        'than after.',
      unconfigured_note: this.token.enabled
        ? null
        : `Payments are not configured (${this.token.configVar} / ARCA_RPC_URL), so no payment can be ` +
          'verified at all right now. Every claim refuses with 503 — which is correct: nothing is ' +
          'being judged.',
    };
  }

  /**
   * Everything a buyer needs BEFORE paying, from the rows the check reads.
   *
   * Deliberately assembled from resolvePayable() and requiredBaseUnits()
   * rather than from its own queries — the property being sold here is that
   * the quote cannot disagree with the verification, and that property is only
   * real if they are literally the same code.
   */
  async quote(listingId: string): Promise<{
    listing_id: string;
    pay_to: string;
    token: string;
    amount: string;
    amount_base_units: string;
    decimals: number;
    claim_within_hours: number;
    min_confirmations: number;
    term_days: number;
    grace_hours: number;
    warning: string;
  }> {
    const { listing, creatorWallet } = await this.resolvePayable(listingId);
    if (!this.token.enabled) {
      throw new ServiceUnavailableException({
        code: 'payment_verification_unavailable',
        message:
          `Payments are not configured (${this.token.configVar} / ARCA_RPC_URL), so no ` +
          'amount or payee can be stated. Do not send anything.',
      });
    }
    const decimals = await this.token.getDecimals();
    const required = await this.requiredBaseUnits(listingId);

    return {
      listing_id: listing.id,
      // THE ADDRESS THE CHECK WILL LOOK FOR. Same lookup, same row.
      pay_to: creatorWallet.toLowerCase(),
      token: this.token.tokenAddress!.toLowerCase(),
      // The human figure and the base-unit figure come from ONE conversion, so
      // a client that displays the first and a chain that carries the second
      // cannot describe different amounts.
      amount: listing.arcaGateAmount!,
      amount_base_units: required.toString(),
      decimals,
      claim_within_hours: this.maxAgeSeconds / 3600,
      min_confirmations: this.minConfirmations,
      // WHAT THE MONEY BUYS, quoted beside what it costs. The term and the
      // grace window are the other half of the price and they used to be
      // readable only from the code — a buyer was shown an amount and an
      // address and had to guess how long it lasted.
      term_days: this.subs.termDays,
      grace_hours: this.subs.graceHours,
      // SAID BEFORE THE MONEY MOVES, not after. ARCANA never receives this
      // payment and therefore cannot return it — that is a direct consequence
      // of a fee-free P2P marketplace and it is the right trade, but a buyer
      // is entitled to know it while they can still decide.
      warning:
        'You are paying the creator DIRECTLY. ARCANA never receives this money and ' +
        'therefore cannot refund it, reverse it, or recover it if you send it to the ' +
        'wrong address or send the wrong amount. Send exactly this token to exactly ' +
        `this address, then submit the transaction hash within ${this.maxAgeSeconds / 3600} ` +
        'hours. An underpayment is not refunded and does not grant access.',
    };
  }

  /**
   * Transfers this buyer already made to this listing's creator, unclaimed.
   *
   * THE CASE. Somebody pays, then closes the tab before submitting the hash.
   * The money is theirs and on chain; the platform knows nothing about it. It
   * looks lost, the 24-hour window is running, and the only remedy today is a
   * support message.
   *
   * IT GRANTS NOTHING, and that is why it opens no new surface. It reads the
   * chain for transfers whose SENDER is the caller's own proven wallet and
   * whose RECIPIENT is this listing's creator, and returns candidate hashes.
   * Claiming one still goes through claim() unchanged — the sender check, the
   * confirmations, the freshness window and the UNIQUE on tx_hash all apply
   * exactly as before. It reveals transactions involving the caller's own
   * wallet, which they can already see, and the creator's address, which the
   * quote states anyway.
   *
   * THE BOUND, STATED RATHER THAN HIDDEN. eth_getLogs ranges are capped by
   * every public RPC and they do not agree on the cap, and the freshness
   * window is 24 hours — 864,000 blocks at 0.100 s/block. Scanning that per
   * request is not something to do to a node somebody else pays for. So this
   * looks back a bounded distance and SAYS how far it looked. It answers "I
   * paid a few minutes ago and lost the tab", which is the case that actually
   * happens; it does not answer "I paid yesterday", and the response says so
   * rather than returning an empty list that reads as "no payment found".
   */
  async findUnclaimed(userWallet: string, listingId: string): Promise<{
    listing_id: string;
    searched_blocks: number;
    searched_minutes: number;
    candidates: Array<{ tx_hash: string; amount_base_units: string; sufficient: boolean }>;
    note: string;
  }> {
    const { creatorWallet } = await this.resolvePayable(listingId);
    if (!this.token.enabled) {
      throw new ServiceUnavailableException({
        code: 'payment_verification_unavailable',
        message: 'The chain is not configured, so nothing could be looked for.',
      });
    }
    const from = userWallet.toLowerCase();
    const to = creatorWallet.toLowerCase();
    const required = await this.requiredBaseUnits(listingId);

    // ~30 minutes at 0.100 s/block, in chunks a public node will serve.
    const CHUNK = 4096;
    const CHUNKS = 5;
    const head = await this.token.getBlockNumber();

    const candidates: Array<{ tx_hash: string; amount_base_units: string; sufficient: boolean }> = [];
    let scanned = 0;
    for (let i = 0; i < CHUNKS; i++) {
      const toBlock = head - BigInt(i * CHUNK);
      const fromBlock = toBlock - BigInt(CHUNK) + 1n;
      if (fromBlock < 0n) break;
      let logs: Array<{ transactionHash: string; data: string }>;
      try {
        logs = await this.token.transfersBetween(fromBlock, toBlock, from, to);
      } catch (e) {
        // A refused range is not "no payment". Stop and say how far we got,
        // rather than reporting a shorter search as a complete one.
        this.logger.warn(`unclaimed scan stopped at chunk ${i}: ${e}`);
        break;
      }
      scanned += CHUNK;
      for (const log of logs) {
        const value = BigInt(log.data === '0x' ? '0x0' : log.data);
        // Already-claimed hashes are excluded here rather than offered and
        // then refused: offering a hash that cannot work is worse than not
        // finding it, because the buyer acts on it.
        const seen = await this.claims.findOne({ where: { txHash: log.transactionHash.toLowerCase() } });
        if (seen) continue;
        candidates.push({
          tx_hash: log.transactionHash.toLowerCase(),
          amount_base_units: value.toString(),
          sufficient: value >= required,
        });
      }
    }

    const minutes = Math.round((scanned * 0.1) / 60);
    return {
      listing_id: listingId,
      searched_blocks: scanned,
      searched_minutes: minutes,
      candidates,
      note:
        `Searched the last ${scanned} blocks (about ${minutes} minutes). This is a bounded ` +
        'search, not the whole freshness window: an older payment will not appear here even ' +
        'though it is still claimable. If you paid longer ago than that, find the transaction ' +
        'hash in your own wallet and submit it directly — it will still be accepted for ' +
        `${this.maxAgeSeconds / 3600} hours.`,
    };
  }

  /**
   * Can this agent's creator receive a payment at all?
   *
   * Answered by `creatorWalletFor()` — THE SAME LOOKUP the verification uses,
   * not a query that happens to resolve the same way. The marketplace calls
   * this before publishing a listing, so "can this be paid for" has one
   * definition rather than one per caller.
   *
   * Takes an AGENT id rather than a listing id, because it is asked before the
   * listing exists. That is the whole point: a listing without a payee should
   * never be created, not created and then found unbuyable.
   */
  async isPayable(agentId: string): Promise<{ payable: boolean; pay_to: string | null }> {
    const wallet = await this.creatorWalletFor(agentId);
    return { payable: wallet != null, pay_to: wallet ? wallet.toLowerCase() : null };
  }

  private baseUnits(human: string, decimals: number): bigint {
    const [whole, frac = ''] = human.trim().split('.');
    const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
    return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
  }
}
