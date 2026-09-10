import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, http, parseAbiItem } from 'viem';

/**
 * Read-only client for the $ARCA ERC-20 token on the (permissioned) chain.
 * Only reads Transfer events + block numbers — arca-service never deploys or
 * writes contracts (constraint of §10).
 */
@Injectable()
export class ArcaTokenService {
  private readonly logger = new Logger(ArcaTokenService.name);
  readonly tokenAddress: `0x${string}` | null;
  private readonly client;
  readonly chainName: string;
  /**
   * Token decimals. A DOCUMENTED ASSUMPTION until the token exists: 18 is
   * the ERC-20 convention and USDG, the only comparable token on this chain,
   * uses 6. Getting it wrong scales every price check by a factor of a
   * trillion in one direction or the other, so it is configuration rather
   * than a constant, and arca-go-live.md flags verifying it against the real
   * token before anyone can pay.
   */
  readonly decimals: number;

  constructor(config: ConfigService) {
    const rawAddress = config.get<string>('ARCA_TOKEN_ADDRESS');
    const rpc = config.get<string>('ARCA_RPC_URL');
    this.chainName = config.get<string>('ARCA_CHAIN_NAME') ?? 'robinhood';
    this.decimals = parseInt(config.get<string>('ARCA_TOKEN_DECIMALS') ?? '18', 10);

    this.tokenAddress = rawAddress?.match(/^0x[a-fA-F0-9]{40}$/)
      ? (rawAddress.toLowerCase() as `0x${string}`)
      : null;

    if (!rpc) {
      this.logger.warn('ARCA_RPC_URL not set — token reads are disabled');
      this.client = null;
      return;
    }
    this.client = createPublicClient({ transport: http(rpc) });
  }

  get enabled(): boolean {
    return this.client != null && this.tokenAddress != null;
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
    if (!this.tokenAddress) throw new Error('ARCA_TOKEN_ADDRESS not configured');

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
   * Token balance of an address. Used by the deposit audit pass to answer the
   * question a log scan cannot: did money actually arrive at this address,
   * regardless of whether any scan ever covered its block?
   */
  async balanceOf(address: string): Promise<bigint> {
    if (!this.client) throw new Error('ARCA_RPC_URL not configured');
    if (!this.tokenAddress) throw new Error('ARCA_TOKEN_ADDRESS not configured');
    return this.client.readContract({
      address: this.tokenAddress,
      abi: [parseAbiItem('function balanceOf(address) view returns (uint256)')],
      functionName: 'balanceOf',
      args: [address as `0x${string}`],
    }) as Promise<bigint>;
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
