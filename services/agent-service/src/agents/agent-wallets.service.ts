import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentWallet } from './agent-wallet.entity';

/**
 * Agent wallets — two paths, and the second one changes what the platform can
 * assume about its own records.
 *
 * DEFAULT: ARCANA derives the key from its master seed. The user never handles
 * key material and there is nothing for them to lose. They can ask for it at
 * any time, because a wallet whose owner can never take possession of it is
 * not the owner's wallet — it is the platform's wallet with the owner's name
 * written on it.
 *
 * OPTIONAL: the user imports a key they already control. Some people will not
 * hand a platform sole control of an address, and that is a reasonable
 * position to hold.
 *
 * THE CONSEQUENCE OF EITHER, once taken: the key exists in two places, and the
 * owner can move funds without going through ARCANA — including while the
 * agent has an open position. This is not an edge case to be defended against;
 * it is the owner using a key that is legitimately theirs. So it is not
 * treated as corruption. What it is treated as is a reason the database's idea
 * of a balance stops being authoritative, which is what `reconcile()` below is
 * for.
 *
 * ARCANA NEVER RECEIVES A LOGIN WALLET'S KEY. SIWE proves an identity with a
 * signature; the key stays with the user. An agent wallet is a different
 * address for a different purpose, and the two are deliberately not the same.
 */
@Injectable()
export class AgentWalletsService {
  private readonly logger = new Logger(AgentWalletsService.name);
  private readonly signerUrl: string;
  private readonly internalKey: string;

  constructor(
    @InjectRepository(AgentWallet)
    private readonly wallets: Repository<AgentWallet>,
    config: ConfigService,
  ) {
    this.signerUrl = config.get<string>('SIGNER_URL') ?? 'http://127.0.0.1:8085';
    this.internalKey = config.get<string>('INTERNAL_API_KEY') ?? '';
  }

  /** The wallet on file, or null. Reading is not creating. */
  async find(agentId: string): Promise<AgentWallet | null> {
    return this.wallets.findOne({ where: { agentId } });
  }

  /**
   * The agent's wallet, creating the derived one on first ask.
   *
   * Idempotent, and it has to be: the address is a pure function of the agent
   * id under the signer's HKDF derivation, so asking twice cannot produce two
   * different answers. That is also why there is no "create wallet" action for
   * a user to forget to perform — the wallet exists the moment the agent does,
   * and this only writes down what it already is.
   */
  async ensure(agentId: string): Promise<AgentWallet> {
    const existing = await this.find(agentId);
    if (existing) return existing;

    const { address } = await this.signer<{ address: string }>(
      'GET',
      `/internal/v1/signer/wallets/${agentId}`,
    );

    const row = this.wallets.create({
      agentId,
      address: address.toLowerCase(),
      provenance: 'derived',
      keyCustody: 'platform_only',
      exportedAt: null,
      importedAt: null,
    });

    try {
      return await this.wallets.save(row);
    } catch (e) {
      // Two concurrent first-asks both derive the same address and both try to
      // insert; the UNIQUE constraint settles it. The loser re-reads rather
      // than failing, because both were right about what the address is.
      const again = await this.find(agentId);
      if (again) return again;
      throw e;
    }
  }

  /**
   * Hand the private key to the agent's owner. Once, and irreversibly in terms
   * of what the platform may assume afterwards.
   *
   * The custody flag is written FIRST, before the key is returned. If the
   * order were reversed and the write failed, the owner would hold a key the
   * platform still believed only it could use — and every balance check after
   * that would trust a record that had become fiction. Recording a shared
   * custody that did not happen is harmless; failing to record one that did is
   * not.
   */
  async exportKey(agentId: string): Promise<{
    address: string;
    private_key: string;
    custody: string;
    warning: string;
  }> {
    const wallet = await this.require(agentId);

    if (wallet.provenance === 'imported') {
      throw new BadRequestException({
        code: 'cannot_export_imported_key',
        message:
          'This agent uses a key you imported. You already hold it — ARCANA has ' +
          'nothing to give you that you did not give it.',
      });
    }

    await this.wallets.update(
      { agentId },
      { keyCustody: 'shared', exportedAt: wallet.exportedAt ?? new Date() },
    );

    const res = await this.signer<{
      address: string;
      private_key: string;
      custody: string;
      warning: string;
    }>('POST', `/internal/v1/signer/wallets/${agentId}/export`);

    this.logger.warn(
      `key exported for agent ${agentId} (${wallet.address}) — custody is now shared`,
    );
    return res;
  }

  /**
   * Adopt a key the owner already controls.
   *
   * The address comes back FROM THE SIGNER, derived from the key itself. It is
   * never taken from the request: if a caller could state the address, this
   * table would say one thing while the signer signed for another, and the
   * divergence would surface only when funds went somewhere nobody expected.
   *
   * Refuses if the agent already has a wallet holding anything, because
   * switching addresses silently strands whatever is at the old one with
   * nothing in the system pointing at it any more.
   */
  async importKey(
    agentId: string,
    privateKey: string,
  ): Promise<{ address: string; custody: string; warning: string }> {
    const existing = await this.find(agentId);
    if (existing && existing.provenance === 'imported') {
      throw new BadRequestException({
        code: 'wallet_already_imported',
        message:
          `Agent ${agentId} already uses an imported key at ${existing.address}. ` +
          'Replacing it would leave anything held at that address unreachable through ' +
          'this platform. Create a new agent for a different wallet.',
      });
    }
    if (existing && existing.keyCustody === 'shared') {
      throw new BadRequestException({
        code: 'wallet_already_exported',
        message:
          `Agent ${agentId} has already had its derived key exported to you. Importing a ` +
          'different key now would leave funds at the exported address with nothing in ' +
          'ARCANA pointing at them. Create a new agent for the wallet you want to import.',
      });
    }

    const res = await this.signer<{
      address: string;
      custody: string;
      warning: string;
    }>('POST', `/internal/v1/signer/wallets/${agentId}/import`, { private_key: privateKey });

    const address = res.address.toLowerCase();
    if (existing) {
      await this.wallets.update(
        { agentId },
        {
          address,
          provenance: 'imported',
          keyCustody: 'shared',
          importedAt: new Date(),
        },
      );
    } else {
      await this.wallets.save(
        this.wallets.create({
          agentId,
          address,
          provenance: 'imported',
          keyCustody: 'shared',
          importedAt: new Date(),
          exportedAt: null,
        }),
      );
    }

    this.logger.warn(
      `key imported for agent ${agentId} (${address}) — jointly held from the start`,
    );
    return res;
  }

  /**
   * Reconcile a recorded balance against what the chain says, and record any
   * divergence.
   *
   * WHY THE CHAIN ALWAYS WINS. Not because the database is untrustworthy, but
   * because the chain is what the NEXT TRADE WILL EXECUTE AGAINST. A portfolio
   * that says 100 USDG against an address holding 40 does not cause a wrong
   * number in a report — it causes a swap that reverts after the gas is spent,
   * or worse, one that succeeds for an amount the owner did not intend to
   * commit. Reconciling to the chain is the only version that makes the next
   * action correct.
   *
   * WHY IT IS NOT AN ERROR. For a `shared` wallet the owner can move funds
   * whenever they like. That is what "your capital, your risk" means when the
   * user holds the key too. Treating it as corruption would mean the platform
   * halting on a user doing something they are entitled to do.
   *
   * WHY IT IS STILL RECORDED. An unexplained balance change is the single
   * hardest thing to reconstruct after the fact, and this is the only moment
   * both numbers exist in one place.
   *
   * Positive drift — funds ARRIVED — is recorded too. An owner topping up
   * their agent from outside is normal, and a system that only notices money
   * leaving will eventually trade with capital it does not know it has.
   */
  async reconcile(
    agentId: string,
    expected: bigint,
    observed: bigint,
    opts: { tokenAddress?: string | null; symbol?: string | null; canHonourPositions?: boolean } = {},
  ): Promise<{ drifted: boolean; delta: bigint; resolution: string }> {
    const delta = observed - expected;
    if (delta === 0n) return { drifted: false, delta: 0n, resolution: 'in_sync' };

    // 'halted' when the shortfall leaves the agent unable to honour what it
    // has already committed to. Standing an agent down is a real outcome and
    // says so; trading on a balance that is not there is not an alternative.
    const resolution =
      opts.canHonourPositions === false && delta < 0n ? 'halted' : 'reconciled';

    await this.wallets.manager.query(
      `INSERT INTO custody_drift
         (agent_id, token_address, symbol, expected, observed, delta, resolution, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        agentId,
        opts.tokenAddress ?? null,
        opts.symbol ?? null,
        expected.toString(),
        observed.toString(),
        delta.toString(),
        resolution,
        delta < 0n
          ? 'funds left this wallet outside ARCANA; the owner holds the key'
          : 'funds arrived from outside ARCANA',
      ],
    );

    this.logger.warn(
      `custody drift on agent ${agentId}${opts.symbol ? ` (${opts.symbol})` : ''}: ` +
        `recorded ${expected}, chain says ${observed}, delta ${delta} — ${resolution}`,
    );
    return { drifted: true, delta, resolution };
  }

  private async require(agentId: string): Promise<AgentWallet> {
    const w = await this.find(agentId);
    if (!w) {
      throw new NotFoundException({
        code: 'no_wallet',
        message: `Agent ${agentId} has no wallet yet. GET /v1/agents/${agentId}/wallet creates it.`,
      });
    }
    return w;
  }

  /**
   * Call the signer.
   *
   * An unreachable signer is a 503 that says nothing was done, never a 500 and
   * never a silent null — the same shape as auth's `auth_unavailable` and the
   * claim path's `payment_verification_unavailable`. For import in particular
   * the distinction matters more than usual: "we could not store your key" and
   * "your key was rejected" call for completely different actions from the
   * user, and only one of them means try again.
   */
  private async signer<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.internalKey) {
      throw new ServiceUnavailableException({
        code: 'signer_unavailable',
        message:
          'INTERNAL_API_KEY is not configured, so agent-service cannot talk to the signer. ' +
          'Nothing was done.',
      });
    }
    let res: Response;
    try {
      res = await fetch(`${this.signerUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': this.internalKey,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      this.logger.error(`signer unreachable at ${this.signerUrl}${path}: ${e}`);
      throw new ServiceUnavailableException({
        code: 'signer_unavailable',
        message: 'The signer could not be reached. Nothing was done — try again shortly.',
      });
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { message: text.slice(0, 200) };
    }

    if (!res.ok) {
      const p = parsed as { error?: { code?: string; message?: string }; message?: string };
      const code = p.error?.code ?? 'signer_error';
      const message = p.error?.message ?? p.message ?? `signer returned ${res.status}`;
      // 5xx is "we could not"; 4xx is "you cannot". Preserved rather than
      // flattened, because the caller's next step differs.
      if (res.status >= 500) {
        throw new ServiceUnavailableException({ code, message });
      }
      throw new BadRequestException({ code, message });
    }
    return parsed as T;
  }
}
