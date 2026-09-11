import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { unrecognisedRiskKeys } from '../agents/risk-profile';

/**
 * A subscription's own trading wallet, book, and key.
 *
 * WHAT A SUBSCRIPTION BUYS. The agent's decisions executed against the buyer's
 * money for thirty days. One agent, one mandate, several wallets. Ownership
 * does not move: there is still one agent and it still belongs to its creator.
 *
 * WHY THE WALLET IS DERIVED RATHER THAN THE BUYER'S OWN ADDRESS. The platform
 * signs, and it cannot sign for an address whose key it does not hold. So the
 * signer derives a wallet from the SUBSCRIPTION ID, exactly as it derives one
 * from an agent id — and every rule it already enforces applies unchanged. The
 * most important is that the signer takes no recipient: it COMPUTES one from
 * the id it is given. A subscriber cannot direct execution into somebody else's
 * wallet because there is no field in which to say so.
 *
 * EVERYTHING HERE IS THE BUYER'S, AND ONLY THE BUYER'S. Every method asserts
 * the session wallet is the `user_wallet` on the subscription, and none of them
 * requires the subscription to be active — a lapsed buyer must still be able to
 * read what they hold and take the key. A position that cannot be reached
 * because a subscription ended would be funds locked up by an expiry date,
 * which is not a thing this platform is allowed to do.
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);
  private readonly signerUrl: string;
  private readonly internalKey: string;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    config: ConfigService,
  ) {
    this.signerUrl = config.get<string>('SIGNER_URL') ?? 'http://127.0.0.1:8085';
    this.internalKey = config.get<string>('INTERNAL_API_KEY') ?? '';
  }

  /**
   * The subscription, if this wallet owns it.
   *
   * NOT SCOPED BY STATUS. An expired subscription is still yours, and the thing
   * you most need after it expires is to reach your own money.
   */
  private async own(subId: string, wallet: string) {
    const rows = await this.db.query(
      `SELECT s.id::text, s.user_wallet, s.listing_id::text, s.agent_id::text,
              s.wallet_address, s.status, s.expires_at, s.trading_paused,
              coalesce(s.risk_profile, '{}'::jsonb) AS risk_profile
         FROM subscriptions s WHERE s.id = $1`,
      [subId],
    );
    if (rows.length === 0) throw new NotFoundException(`Subscription ${subId} not found`);
    const s = rows[0];
    if (String(s.user_wallet).toLowerCase() !== wallet.toLowerCase()) {
      // NOT FOUND RATHER THAN FORBIDDEN would hide it better, but this platform
      // already tells an owner plainly when they are not one, and a subscription
      // id is not a secret worth pretending about.
      throw new ForbiddenException({
        code: 'not_your_subscription',
        message: 'This subscription belongs to another wallet.',
      });
    }
    return s;
  }

  /**
   * Derive and bind this subscription's trading wallet.
   *
   * IDEMPOTENT. Asking twice returns the same address, because the signer
   * derives deterministically from the subscription id — there is no second
   * wallet to end up with.
   *
   * It also binds the agent, read from the listing rather than taken from the
   * caller: which agent trades for this subscription is a property of what was
   * bought, not of what the buyer asks for.
   */
  async bindWallet(subId: string, wallet: string) {
    const s = await this.own(subId, wallet);
    if (s.wallet_address) {
      return this.describe(await this.own(subId, wallet));
    }
    if (!this.internalKey) {
      throw new ServiceUnavailableException({
        code: 'signer_unavailable',
        message:
          'INTERNAL_API_KEY is not configured, so agent-service cannot ask the signer for this ' +
          'subscription’s wallet. Nothing was done.',
      });
    }

    const { address } = await this.signer<{ address: string }>(
      'GET', `/internal/v1/signer/wallets/${subId}`);

    await this.db.query(
      `UPDATE subscriptions
          SET wallet_address = $2,
              agent_id = COALESCE(agent_id, (SELECT agent_id FROM marketplace_listings WHERE id = $3))
        WHERE id = $1 AND wallet_address IS NULL`,
      [subId, address.toLowerCase(), s.listing_id],
    );
    this.logger.log(`subscription ${subId} bound to ${address}`);
    return this.describe(await this.own(subId, wallet));
  }

  /** The buyer's own limits, and their own stop. */
  async update(subId: string, wallet: string, dto: { riskProfile?: string; tradingPaused?: boolean }) {
    await this.own(subId, wallet);

    let profile: Record<string, unknown> | undefined;
    if (dto.riskProfile !== undefined) {
      try {
        profile = JSON.parse(dto.riskProfile);
      } catch {
        throw new BadRequestException({
          code: 'invalid_risk_profile', message: 'riskProfile must be a JSON object.',
        });
      }
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        throw new BadRequestException({
          code: 'invalid_risk_profile', message: 'riskProfile must be a JSON object.',
        });
      }
    }

    await this.db.query(
      `UPDATE subscriptions
          SET risk_profile  = COALESCE($2::jsonb, risk_profile),
              trading_paused = COALESCE($3::boolean, trading_paused),
              updated_at = now()
        WHERE id = $1`,
      [subId, profile === undefined ? null : JSON.stringify(profile), dto.tradingPaused ?? null],
    );

    const out = await this.describe(await this.own(subId, wallet));
    // The same courtesy the agent endpoints give: nothing is refused, and
    // nothing is silent. A key the engine will not read is named back rather
    // than accepted into a profile that then does nothing.
    const unknown = unrecognisedRiskKeys(out.risk_profile);
    return unknown.length === 0 ? out : {
      ...out,
      risk_profile_unrecognised: unknown,
      risk_profile_note:
        `${unknown.length} key(s) in risk_profile are not read by the decision engine and will ` +
        `have no effect: ${unknown.join(', ')}. Nothing was refused and the values are stored as ` +
        'given; see docs/agents.md for the keys that are read.',
    };
  }

  /**
   * What this subscription holds, and whether the agent is still trading for it.
   *
   * READABLE AFTER EXPIRY, deliberately. The positions an agent leaves behind
   * are the buyer's, and the first thing a lapsed buyer needs is to see them.
   */
  async book(subId: string, wallet: string) {
    const s = await this.own(subId, wallet);
    const snap = await this.db.query(
      `SELECT ts, nav::float8 AS nav, cash::float8 AS cash, holdings, decision_id
         FROM subscription_snapshots WHERE subscription_id = $1 ORDER BY ts DESC LIMIT 1`,
      [subId],
    );
    const executions = await this.db.query(
      `SELECT id, ts, intent_action, symbol, status, tx_hash,
              filled_out::text, slippage_bps::float8 AS slippage_bps,
              gas_cost_usd::float8 AS gas_cost_usd, pool_fee_usd::float8 AS pool_fee_usd,
              guard_id
         FROM executions
        WHERE subscription_id = $1
        ORDER BY id DESC LIMIT 50`,
      [subId],
    );

    // WHAT IS WATCHING THIS WALLET, AND WHAT IS NOT.
    //
    // The absence of a stop loss is the fact worth surfacing, not the presence
    // of one. A level the pool refused, or one stood down when the subscription
    // ended, leaves an open position with nothing watching it — and a buyer who
    // is never told reads the silence as protection. So refusals are listed
    // beside armed levels, in the same shape, with the smallest level that pool
    // would have accepted: the choice has to be TAKEN, not discovered.
    const guards = await this.db.query(
      `SELECT id, symbol, status,
              entry_price::float8  AS entry_price,
              entry_qty::float8    AS entry_qty,
              take_profit::float8  AS take_profit,
              stop_loss::float8    AS stop_loss,
              take_profit_pct::float8 AS take_profit_pct,
              stop_loss_pct::float8   AS stop_loss_pct,
              min_acceptable_pct::float8 AS min_acceptable_pct,
              set_at, triggered_at, triggered_side,
              triggered_price::float8 AS triggered_price,
              last_refusal_at, last_refusal_reason, note
         FROM position_guards
        WHERE subscription_id = $1 AND status IN ('armed', 'refused')
        ORDER BY set_at DESC`,
      [subId],
    );
    const armed = guards.filter((g: any) => g.status === 'armed');
    const unprotected = guards.filter((g: any) => g.status === 'refused');

    return {
      ...this.describe(s),
      book: snap[0]
        ? { as_of: snap[0].ts, nav: snap[0].nav, cash: snap[0].cash,
            holdings: snap[0].holdings ?? {}, after_decision: snap[0].decision_id }
        : null,
      executions,
      protection: {
        armed,
        unprotected,
        // Never omitted when empty: `[]` states that nothing is watching, which
        // is different from a field that is missing because nobody looked.
        note: this.protectionNote(armed, unprotected),
      },
      // Said out loud rather than left to be inferred from `trading`.
      note: this.tradingNote(s),
    };
  }

  /**
   * Take possession of the subscription's key.
   *
   * The same shape as an agent's export and for the same reason: this is the
   * buyer's money, and the platform holding the only key to it is a custody
   * arrangement they must be able to end. Available whatever the subscription's
   * status — most of all after it has ended.
   */
  async exportKey(subId: string, wallet: string) {
    const s = await this.own(subId, wallet);
    if (!s.wallet_address) {
      throw new BadRequestException({
        code: 'no_wallet_yet',
        message:
          'This subscription has no trading wallet yet. Derive one with ' +
          'POST /v1/subscriptions/:id/wallet first.',
      });
    }
    const res = await this.signer<{ address: string; private_key: string }>(
      'POST', `/internal/v1/signer/wallets/${subId}/export`);
    return {
      address: res.address,
      private_key: res.private_key,
      custody: 'shared',
      warning:
        'ARCANA still holds this key and will keep signing with it while the subscription is ' +
        'active. Holding it yourself means you can move these funds at any time — including ' +
        'after the subscription ends, which is the point: an expired subscription stops the ' +
        'agent trading for you, it does not close your positions or lock you out of them.',
    };
  }

  /**
   * One sentence a buyer can act on, about protection rather than about trades.
   *
   * A held-back level is named as held back. A refused one names the smallest
   * the pool would have taken, so the answer is "ask for this instead" rather
   * than only "that was wrong".
   */
  private protectionNote(armed: any[], unprotected: any[]): string {
    const held = armed.filter((g) => g.last_refusal_at);
    const parts: string[] = [];
    if (armed.length > 0) {
      parts.push(
        `${armed.length} position(s) have protective levels watching: ${armed
          .map((g) => g.symbol)
          .join(', ')}. The watcher prices them every 15 seconds and spends gas only when a level ` +
          'is actually crossed.',
      );
    }
    if (held.length > 0) {
      parts.push(
        `${held.length} of those crossed a level and the exit was NOT taken: ` +
          held.map((g) => `${g.symbol} (${g.last_refusal_reason})`).join('; ') +
          '. The level stays armed and will be acted on once the condition clears.',
      );
    }
    if (unprotected.length > 0) {
      parts.push(
        `${unprotected.length} position(s) are OPEN AND UNPROTECTED: ` +
          unprotected
            .map(
              (g) =>
                `${g.symbol}${
                  g.min_acceptable_pct
                    ? ` — the smallest level this pool accepts is ${(g.min_acceptable_pct * 100).toFixed(3)}%`
                    : ''
                }`,
            )
            .join('; ') +
          '. Nothing is watching them. They are still yours and still in your wallet.',
      );
    }
    if (parts.length === 0) {
      return 'No protective levels are set for this subscription. That is not a failure — the ' +
        'agent only arms a stop or a target when it asks for one — but nothing is watching these ' +
        'positions.';
    }
    return parts.join(' ');
  }

  private tradingNote(s: any): string {
    if (!s.wallet_address) {
      return 'No trading wallet yet. Derive one with POST /v1/subscriptions/:id/wallet, then fund ' +
        'it with USDG to trade and ETH for gas — the agent never spends anyone else’s.';
    }
    if (s.trading_paused) {
      return 'You have paused trading. The agent decides as usual and executes nothing for you.';
    }
    if (s.status !== 'active' || new Date(s.expires_at) <= new Date()) {
      return 'The agent has stopped trading for this wallet. Whatever it holds stays where it is: ' +
        'the positions are yours, you can read them here, and you can take the key with ' +
        'POST /v1/subscriptions/:id/wallet/export and move them whenever you like.';
    }
    return 'The agent is trading for this wallet. Your own limits size every position; the ' +
      'creator chooses only the direction.';
  }

  private describe(s: any) {
    const expired = new Date(s.expires_at) <= new Date();
    return {
      id: s.id,
      status: s.status,
      expires_at: s.expires_at,
      agent_id: s.agent_id,
      listing_id: s.listing_id,
      wallet_address: s.wallet_address,
      risk_profile: s.risk_profile ?? {},
      trading_paused: s.trading_paused,
      // TRADING AND ACCESS ARE DIFFERENT THINGS, and they end at different
      // moments. Grace keeps a lapsed buyer READING the record, which costs
      // nothing. It does not keep spending their money on a subscription that
      // has not been paid for.
      trading: s.status === 'active' && !s.trading_paused && !expired && !!s.wallet_address,
    };
  }

  private async signer<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.signerUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Internal-Key': this.internalKey },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      this.logger.error(`signer unreachable at ${this.signerUrl}${path}: ${e}`);
      throw new ServiceUnavailableException({
        code: 'signer_unavailable',
        message: 'The signer could not be reached. Nothing was done.',
      });
    }
    const text = await res.text();
    if (!res.ok) {
      this.logger.error(`signer ${path} -> ${res.status} ${text.slice(0, 200)}`);
      throw new ServiceUnavailableException({
        code: 'signer_refused',
        message: `The signer refused: ${text.slice(0, 200)}`,
      });
    }
    return JSON.parse(text) as T;
  }
}
