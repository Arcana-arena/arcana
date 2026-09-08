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

  constructor(config: ConfigService) {
    const rawAddress = config.get<string>('ARCA_TOKEN_ADDRESS');
    const rpc = config.get<string>('ARCA_RPC_URL');
    this.chainName = config.get<string>('ARCA_CHAIN_NAME') ?? 'robinhood';

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
