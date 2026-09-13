import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, http, parseAbiItem } from 'viem';

/**
 * Read-only client for ONE ERC-20 token on Robinhood Chain.
 *
 * TWO TOKENS NOW, AND THEY ARE NOT THE SAME THING.
 *
 * There used to be one `ARCA_TOKEN_ADDRESS`, read by both the marketplace
 * payment path and the $ARCA entitlement gate, because both happened to be
 * $ARCA. They stopped being the same on 2026-09-11:
 *
 *   PAYMENT  — what a buyer sends a creator for a listing. Now USDG, which
 *              exists on chain today and which the phase-11 verification was
 *              already driven against, using real transfers other people made.
 *   GATING   — what a creator must HOLD to create, compete, evolve or enter a
 *              premium arena. Still $ARCA, still unlaunched.
 *
 * One variable for both is how they get swapped by accident: a day comes when
 * somebody sets it for one purpose and silently changes the other. So this
 * class takes its address as a CONSTRUCTOR ARGUMENT and is registered twice,
 * under two names, from two variables. Nothing reads a token address from the
 * environment any more except the two providers at the bottom of this file.
 *
 * Only reads — Transfer logs, receipts, block numbers, balances. arca-service
 * never deploys or writes contracts.
 */
export class Erc20Reader {
  private readonly logger: Logger;
  readonly tokenAddress: `0x${string}` | null;
  private readonly client;
  readonly chainName: string;
  /**
   * The chain this reader is pointed at.
   *
   * Needed because a payment URI has to name it: a wallet handed an ERC-20
   * transfer without a chain id will offer it on whichever network happens to
   * be selected, and the same token address on another chain is a different
   * contract — or nothing at all.
   */
  readonly chainId: number | null;
  /** Which variable this instance came from, for boot logs and refusals. */
  readonly configVar: string;
  /** What this token is FOR, so a refusal can say which one is missing. */
  readonly purpose: string;
  /**
   * Token decimals, once read FROM THE CHAIN. Null until then.
   *
   * It used to be `ARCA_TOKEN_DECIMALS`, defaulting to 18 because "18 is the
   * ERC-20 convention" — and USDG, the token this chain actually settles in,
   * uses **6**. That guess scales every price check by a factor of a trillion,
   * silently, in whichever direction it is wrong.
   *
   * `decimals()` is a view function on the token itself. Whatever token is
   * configured, the chain will say. So it is no longer configuration, and
   * there is deliberately no fallback: a token that cannot be asked is a token
   * that cannot be verified against, which is a 503, not a guess.
   */
  private decimalsCache: number | null = null;

  constructor(config: ConfigService, configVar: string, purpose: string) {
    this.configVar = configVar;
    this.purpose = purpose;
    this.logger = new Logger(`Erc20Reader(${purpose})`);

    const rawAddress = config.get<string>(configVar);
    const rpc = config.get<string>('ARCA_RPC_URL');
    this.chainName = config.get<string>('ARCA_CHAIN_NAME') ?? 'robinhood';
    // NOT DEFAULTED. A guessed chain id in a payment URI would send a wallet to
    // the wrong network with a straight face; unset means no URI is offered.
    const cid = Number(config.get<string>('ARCA_CHAIN_ID'));
    this.chainId = Number.isFinite(cid) && cid > 0 ? cid : null;

    // VALIDATED AS AN ADDRESS, never trusted as a name. A malformed value
    // becomes null — which disables this reader loudly — rather than being
    // passed to the chain to see what happens.
    this.tokenAddress = rawAddress?.match(/^0x[a-fA-F0-9]{40}$/)
      ? (rawAddress.toLowerCase() as `0x${string}`)
      : null;

    if (!rpc) {
      this.logger.warn(`ARCA_RPC_URL not set — ${purpose} token reads are disabled`);
      this.client = null;
      return;
    }
    this.client = createPublicClient({ transport: http(rpc) });
  }

  get enabled(): boolean {
    return this.client != null && this.tokenAddress != null;
  }

  /**
   * The token's own `decimals()`, read once and cached for the process.
   *
   * Throws when the token cannot be asked — no RPC, no address, or an address
   * with no contract behind it. Callers turn that into
   * `payment_verification_unavailable`, because not knowing the scale of an
   * amount means the amount was never checked.
   *
   * Cached because decimals is immutable for every ERC-20 worth accepting: it
   * is set at construction and has no setter in the standard. A token that
   * changed it would be a token that renumbered everyone's balance.
   */
  async getDecimals(): Promise<number> {
    if (this.decimalsCache != null) return this.decimalsCache;
    if (!this.client || !this.tokenAddress) {
      throw new Error(
        `cannot read decimals(): ARCA_RPC_URL or ${this.configVar} not set ` +
        `(this is the ${this.purpose} token)`);
    }
    // 0x313ce567 = keccak("decimals()")[0:4]. Called raw rather than through an
    // ABI helper so a token that returns a short word still decodes.
    const res = await this.client.call({
      to: this.tokenAddress,
      data: '0x313ce567' as `0x${string}`,
    });
    const raw = res?.data;
    if (!raw || raw === '0x') {
      throw new Error(`decimals() returned nothing for ${this.tokenAddress} — is it a token?`);
    }
    const value = Number(BigInt(raw));
    if (!Number.isInteger(value) || value < 0 || value > 36) {
      throw new Error(`decimals() returned an implausible ${value} for ${this.tokenAddress}`);
    }
    this.decimalsCache = value;
    this.logger.log(`token ${this.tokenAddress} reports decimals=${value} (read from chain)`);
    return value;
  }

  get transferEventTopic(): string {
    // Transfer(address indexed from, address indexed to, uint256 value)
    return '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  }

  /**
   * Latest block height on the chain.
   *
   * cacheTime 0 because viem caches getBlockNumber for its polling interval
   * (4s by default) and this height is recorded as a deposit's scan floor. A
   * stale value errs low, which is safe — it only widens a later scan — but it
   * makes created_at_block wrong for addresses issued seconds apart, and the
   * audit then judges their age against a height they never had.
   */
  async getBlockNumber(): Promise<bigint> {
    if (!this.client) throw new Error('ARCA_RPC_URL not configured');
    return this.client.getBlockNumber({ cacheTime: 0 });
  }

  /**
   * The receipt for one transaction, or null when there is none yet.
   *
   * null is deliberately not an error: a transaction that has been broadcast
   * but not mined has no receipt, and that is a different answer from "no such
   * transaction". The caller tells the two apart with transactionExists().
   */
  async getReceipt(hash: `0x${string}`) {
    if (!this.client) throw new Error('ARCA_RPC_URL not configured');
    try {
      return await this.client.getTransactionReceipt({ hash });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not be found|not found/i.test(msg)) return null;
      throw e;   // a real transport failure must NOT read as "no receipt"
    }
  }

  /** Whether the node knows the transaction at all, mined or pending. */
  async transactionExists(hash: `0x${string}`): Promise<boolean> {
    if (!this.client) throw new Error('ARCA_RPC_URL not configured');
    try {
      await this.client.getTransaction({ hash });
      return true;
    } catch {
      return false;
    }
  }

  /** When a block was mined. */
  async getBlockTime(blockNumber: bigint): Promise<Date> {
    if (!this.client) throw new Error('ARCA_RPC_URL not configured');
    const block = await this.client.getBlock({ blockNumber });
    return new Date(Number(block.timestamp) * 1000);
  }

  /**
   * Every ERC-20 Transfer in a receipt, decoded from its logs.
   *
   * FROM THE LOGS, not from the transaction's `to` and `value`. An ERC-20
   * transfer does not move native value and its recipient is a function
   * argument, so reading the transaction envelope would see a call to a
   * contract with a value of zero and learn nothing about who was paid.
   *
   * The token is returned per-log so the caller can filter by ADDRESS. It is
   * not filtered here, because a caller that wants "transfers of our token"
   * should have to say so.
   */
  transfersIn(receipt: { logs: readonly { address: string; topics: readonly string[]; data: string }[] }) {
    const out: Array<{ token: string; from: string; to: string; value: bigint }> = [];
    for (const log of receipt.logs) {
      // Transfer(address,address,uint256): topic0 + two indexed addresses.
      if (log.topics[0]?.toLowerCase() !== this.transferEventTopic) continue;
      if (log.topics.length < 3) continue;
      out.push({
        token: log.address.toLowerCase(),
        from: ('0x' + log.topics[1].slice(-40)).toLowerCase(),
        to: ('0x' + log.topics[2].slice(-40)).toLowerCase(),
        value: BigInt(log.data === '0x' ? '0x0' : log.data),
      });
    }
    return out;
  }
  /**
   * Fetch raw Transfer logs for the token between fromBlock..toBlock.
   * Returns minimal { txHash, blockNumber, from, to, value } entries.
   */
  async getTransferLogs(
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<Array<{ txHash: string; blockNumber: bigint; from: string; to: string; value: bigint }>> {
    if (!this.client) throw new Error('ARCA_RPC_URL not configured');
    if (!this.tokenAddress) throw new Error(`${this.configVar} not configured`);

    const logs = await this.client.getLogs({
      address: this.tokenAddress,
      event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
      fromBlock,
      toBlock,
    });

    return logs.map((l) => ({
      txHash: l.transactionHash,
      blockNumber: l.blockNumber,
      from: (l.args.from ?? '').toLowerCase(),
      to: (l.args.to ?? '').toLowerCase(),
      value: l.args.value ?? 0n,
    }));
  }

  /**
   * Transfers between two specific addresses in a block range.
   *
   * FILTERED BY THE NODE, not by us. `from` and `to` are indexed parameters of
   * the Transfer event, so they become topics and the node returns only the
   * matching logs. Pulling every transfer in the range and filtering here
   * would move the same work onto a machine somebody else pays for, and would
   * scale with the token's whole traffic rather than with one buyer's.
   *
   * Returns the raw shape the caller needs — hash and data — rather than a
   * decoded convenience object, because the caller compares a uint256 and a
   * decoded number would be the wrong type for that comparison.
   */
  async transfersBetween(
    fromBlock: bigint,
    toBlock: bigint,
    from: string,
    to: string,
  ): Promise<Array<{ transactionHash: string; data: string }>> {
    if (!this.client) throw new Error('ARCA_RPC_URL not configured');
    if (!this.tokenAddress) throw new Error(`${this.configVar} not configured`);

    const logs = await this.client.getLogs({
      address: this.tokenAddress,
      event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
      args: { from: from as `0x${string}`, to: to as `0x${string}` },
      fromBlock,
      toBlock,
    });
    return logs.map((l) => ({ transactionHash: l.transactionHash, data: l.data }));
  }

  /**
   * Token balance of an address. Used by the deposit audit pass to answer the
   * question a log scan cannot: did money actually arrive at this address,
   * regardless of whether any scan ever covered its block?
   */
  async balanceOf(address: string): Promise<bigint> {
    if (!this.client) throw new Error('ARCA_RPC_URL not configured');
    if (!this.tokenAddress) throw new Error(`${this.configVar} not configured`);
    return this.client.readContract({
      address: this.tokenAddress,
      abi: [parseAbiItem('function balanceOf(address) view returns (uint256)')],
      functionName: 'balanceOf',
      args: [address as `0x${string}`],
    }) as Promise<bigint>;
  }

  /**
   * The address's NATIVE balance — the gas, not the money.
   *
   * Kept beside balanceOf() because a wallet screen needs both and they fail
   * differently: the token balance needs a configured token address, this needs
   * only an RPC. An agent with a full book and no ETH cannot sell, and cannot
   * fire a stop either, so "how much gas is left" is not a footnote on that
   * screen — it is the thing that decides whether the protection works.
   */
  async nativeBalanceOf(address: string): Promise<bigint> {
    if (!this.client) throw new Error('ARCA_RPC_URL not configured');
    return this.client.getBalance({ address: address as `0x${string}` });
  }

  /**
   * Estimate ETH needed for a token transfer (gas estimation), so callers can
   * warn users about gas before they move funds. Uses a static call against the
   * token's transfer().
   */
  async estimateGasEth(from: `0x${string}`, to: `0x${string}`, amount: bigint, gasPrice?: bigint): Promise<bigint> {
    if (!this.client || !this.tokenAddress) return 0n;
    // erc20Abi from viem includes transfer; we estimate via a raw call with
    // the standard transfer selector on the token contract.
    const data = `0xa9059cbb${to.slice(2).padStart(64, '0')}${amount.toString(16).padStart(64, '0')}` as `0x${string}`;
    const est = await this.client.estimateGas({
      account: from,
      to: this.tokenAddress,
      data,
    });
    const price = gasPrice ?? (await this.client.getGasPrice());
    return est * price;
  }
}

// ---------------------------------------------------------------------------
// The two tokens, and the two names everything else asks for.
// ---------------------------------------------------------------------------
//
// DI TOKENS RATHER THAN TWO SUBCLASSES. A subclass would let a consumer that
// asks for the base type receive either one, which is exactly the confusion
// this split exists to prevent. Asking for PAYMENT_TOKEN can only ever get the
// payment token.

/** What a buyer sends a creator for a listing. USDG today. */
export const PAYMENT_TOKEN = 'ARCANA_PAYMENT_TOKEN';

/** What a creator must HOLD to create, compete, evolve, or enter a premium arena. */
export const GATING_TOKEN = 'ARCANA_GATING_TOKEN';

export const paymentTokenProvider = {
  provide: PAYMENT_TOKEN,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new Erc20Reader(config, 'MARKETPLACE_PAYMENT_TOKEN', 'marketplace payment'),
};

export const gatingTokenProvider = {
  provide: GATING_TOKEN,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new Erc20Reader(config, 'ARCA_TOKEN_ADDRESS', '$ARCA gating'),
};

/**
 * Kept as an alias so nothing outside this module had to be renamed in the
 * same change that split the tokens.
 *
 * It resolves to the GATING token, which is what `ArcaTokenService` always
 * meant: the $ARCA balance an entitlement is checked against. The payment path
 * was moved to PAYMENT_TOKEN explicitly rather than left on this name — a
 * consumer that keeps working while silently pointing at a different token is
 * the failure this whole split is against.
 */
export type ArcaTokenService = Erc20Reader;
