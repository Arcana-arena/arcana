import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository } from 'typeorm';
import { Subscription } from './subscription.entity';

/**
 * Grants and inspects content-access subscriptions (§10.5).
 *
 * There is no per-listing duration column in §7, so the subscription period is
 * SUBSCRIPTION_DAYS (default 30) — a deliberate V1 constant, overridable via
 * env SUBSCRIPTION_DAYS. Revisit if listings grow a duration field.
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);
  private readonly durationDays: number;
  private readonly graceHours_: number;

  constructor(
    @InjectRepository(Subscription)
    private readonly subs: Repository<Subscription>,
    config: ConfigService,
  ) {
    const d = parseInt(config.get<string>('SUBSCRIPTION_DAYS') ?? '30', 10);
    this.durationDays = Number.isFinite(d) && d > 0 ? d : 30;
    // Same default as ReminderService — the two must agree or access would be
    // revoked on a different clock than the one that flips the status.
    const g = parseInt(config.get<string>('ARCA_GRACE_HOURS') ?? '48', 10);
    this.graceHours_ = Number.isFinite(g) && g > 0 ? g : 48;
  }

  /** How long one payment buys, in days. Published in the quote before paying. */
  get termDays(): number {
    return this.durationDays;
  }

  /** How long access outlives expiry. Published beside the term, for the same reason. */
  get graceHours(): number {
    return this.graceHours_;
  }

  /** Start of the grace window: subscriptions expiring after this still count. */
  graceCutoff(now = new Date()): Date {
    return new Date(now.getTime() - this.graceHours_ * 3600 * 1000);
  }

  /**
   * Activate (or extend) a subscription after a confirmed payment.
   *
   * IT BINDS THE AGENT, and that line is the whole reason a subscription does
   * anything. The fan-out finds who to trade for with
   * `WHERE agent_id = $1 AND status = 'active' ...`, so a subscription that
   * does not carry the agent is one the agent never trades for — the customer
   * pays, every other part works, and nothing happens in their wallet.
   *
   * It comes from the LISTING, never from the caller: which agent trades for
   * you is a property of what was bought.
   *
   * It is set on renewal too, not only on create. A renewal is the repair path
   * for a row written before this existed, and repairing it silently is better
   * than leaving a paying customer untraded-for until somebody notices.
   */
  async grant(userWallet: string, listingId: string): Promise<Subscription> {
    const agentId = await this.agentOfListing(listingId);
    // A renew arriving during the grace window must revive that row, not open a
    // second one — otherwise the user ends up with two subscriptions.
    const existing = await this.subs.findOne({
      where: { userWallet, listingId, status: In(['active', 'grace']) },
    });

    // Extension: keep the current expiry and add the period on top; otherwise
    // start from now.
    const base = existing?.expiresAt && existing.expiresAt > new Date()
      ? existing.expiresAt
      : new Date();
    const expiresAt = new Date(
      base.getTime() + this.durationDays * 24 * 3600 * 1000,
    );

    if (existing) {
      existing.expiresAt = expiresAt;
      existing.status = 'active';
      existing.lastReminderStage = null;
      existing.updatedAt = new Date();
      if (!existing.agentId && agentId) existing.agentId = agentId;
      return this.subs.save(existing);
    }

    const sub = this.subs.create({
      userWallet,
      listingId,
      agentId,
      expiresAt,
      status: 'active',
    });
    this.logger.log(
      `granted ${userWallet} -> listing ${listingId} (agent ${agentId ?? 'NONE'}) until ` +
      `${expiresAt.toISOString()}`);
    if (!agentId) {
      // NOT AN ERROR, AND NOT SILENT. A listing with no agent sells access to
      // nothing that trades, which is a listing problem rather than a payment
      // one — the payment was real and the subscription is real. But a buyer
      // who will never be traded for must not be created quietly.
      this.logger.warn(
        `listing ${listingId} names no agent, so subscription for ${userWallet} will never be ` +
        'traded for. The payment succeeded; the listing is the thing to look at');
    }
    return this.subs.save(sub);
  }

  /** The agent a listing sells. Null when the listing names none. */
  private async agentOfListing(listingId: string): Promise<string | null> {
    const rows = await this.subs.manager.query(
      'SELECT agent_id::text AS agent_id FROM marketplace_listings WHERE id = $1',
      [listingId],
    );
    return rows[0]?.agent_id ?? null;
  }

  /**
   * True while the user still holds access to the listing.
   *
   * Access outlives `expires_at` by the grace window (§10.4: 24-48h after
   * expiry before access is revoked). Cutting access exactly at expiry would
   * make the grace period meaningless — it would only delay a status label
   * while the user was already locked out.
   */
  async hasAccess(userWallet: string, listingId: string): Promise<boolean> {
    const sub = await this.subs.findOne({
      where: {
        userWallet,
        listingId,
        status: In(['active', 'grace']),
        expiresAt: MoreThanOrEqual(this.graceCutoff()),
      },
    });
    return !!sub;
  }

  /**
   * GET /v1/subscriptions/:user_wallet — all subscriptions of a user.
   *
   * IT SAYS WHETHER THE AGENT IS ACTUALLY TRADING FOR YOU, and if not, what is
   * missing. The four conditions are the same ones the fan-out applies, stated
   * rather than left to be inferred from a status column that only answers one
   * of them: a buyer whose wallet was never derived, or who paused themselves,
   * reads `active` and concludes something untrue.
   */
  async forUser(userWallet: string) {
    const rows = await this.subs.find({
      where: { userWallet },
      order: { updatedAt: 'DESC' },
    });
    const extra = await this.decorate(rows, userWallet);
    const now = new Date();
    const graceCut = this.graceCutoff(now);

    return rows.map((s) => {
      const expired = s.expiresAt <= now;
      const d = extra.get(s.id) ?? null;

      // AN AGENT THAT IS NOT DECIDING IS NOT TRADING FOR ANYBODY, and this card
      // used to say it was. `trading` was derived from the subscription row
      // alone — paid, not paused, not expired, wallet bound — none of which is
      // a fact about the agent. Retire the agent and every one of those stays
      // true, so a buyer whose wallet had stopped moving was told "the agent is
      // trading for this wallet" indefinitely. The decision engine already
      // refuses to decide for anything but an active agent, so this is not a
      // new rule; it is the buyer's card finally agreeing with what the engine
      // does. Unknown agent leaves the old answer alone: absent is not stopped.
      const agentStatus = (d?.agent as { status?: string } | null)?.status ?? null;
      const agentDeciding = agentStatus === null || agentStatus === 'active';
      const trading =
        s.status === 'active' && !s.tradingPaused && !expired && !!s.walletAddress && agentDeciding;

      // THE THREE PHASES OF A TERM, DERIVED IN ONE PLACE.
      //
      // A page that works these out from expires_at ends up with its own idea
      // of when grace ends, and grace is precisely the window where a wrong
      // answer costs a customer their access. `phase` is the same arithmetic
      // hasAccess() applies, said out loud.
      const graceEnds = new Date(s.expiresAt.getTime() + this.graceHours_ * 3600 * 1000);
      const phase: 'active' | 'grace' | 'ended' = !expired
        ? 'active'
        : s.expiresAt >= graceCut
          ? 'grace'
          : 'ended';

      return {
        ...s,
        trading,
        phase,
        grace_ends_at: graceEnds.toISOString(),
        // Whole days and whole hours, both, because "0d left" and "expired" are
        // different states and a day count alone cannot tell them apart.
        days_remaining: phase === 'active' ? Math.floor((s.expiresAt.getTime() - now.getTime()) / 86400000) : null,
        hours_remaining: phase === 'active' ? Math.floor((s.expiresAt.getTime() - now.getTime()) / 3600000) : null,
        grace_hours_remaining:
          phase === 'grace' ? Math.max(0, Math.floor((graceEnds.getTime() - now.getTime()) / 3600000)) : null,
        term_days: this.durationDays,
        grace_hours: this.graceHours_,
        agent: d?.agent ?? null,
        listing: d?.listing ?? null,
        // The RECEIPT the buyer paid with. Absent for a subscription granted by
        // something other than a verified payment — which is a real state, not
        // a missing field, and the note says which.
        receipt: d?.receipt ?? null,
        receipt_note: d?.receipt
          ? null
          : 'No verified payment claim is recorded against this subscription. It was granted by ' +
            'something other than an on-chain payment — a migration or an operator action — rather ' +
            'than by a transfer this platform checked.',
        wallet_pnl: d?.pnl ?? {
          computable: false,
          reason:
            'No snapshot of this subscription wallet has been recorded, so there is no pair of values ' +
            'to subtract. This is not a profit and loss of zero.',
          first_nav: null,
          last_nav: null,
          pnl: null,
          pnl_pct: null,
          points: 0,
        },
        // WHAT HAPPENS TO A TERM WHOSE AGENT STOPPED, stated on the card rather
        // than left to be noticed. The term is not cut short — it was paid for,
        // and a paused agent can come back — so the only thing that changes is
        // that no new subscription can be bought and nothing is mirrored while
        // it is stopped.
        agent_standing:
          agentStatus === null || agentStatus === 'active'
            ? null
            : {
                status: agentStatus,
                access_ends_at: s.expiresAt.toISOString(),
                note:
                  agentStatus === 'paused'
                    ? 'This agent is paused by its creator and is making no decisions. Your access is not cut ' +
                      'short — it runs to the date above, and mirroring resumes by itself if the agent does. ' +
                      'While it is paused the listing is off the marketplace, so it cannot be renewed or bought.'
                    : agentStatus === 'retired'
                      ? 'This agent has been retired and will make no further decisions. Your access is not cut ' +
                        'short — it runs to the date above — but nothing will be mirrored into your wallet for ' +
                        'the rest of it, and it cannot be renewed. Your positions and your key remain yours: ' +
                        'read the book, and export the key whenever you like.'
                      : `This agent is '${agentStatus}' and is making no decisions. Your access runs to the date above.`,
              },
        next_step: this.nextStep(s, trading, expired, agentStatus),
      };
    });
  }

  /**
   * The facts a subscription list needs that are not on the subscription row.
   *
   * ONE QUERY PER FACT FOR THE WHOLE PAGE, not one per row: this list is
   * rendered as cards and an N+1 here would be four round trips per card.
   *
   * THE RENEWAL PRICE IS TODAY'S, NOT THE ONE THAT WAS PAID. They differ — the
   * mockup's own example has a creator who raised the price mid-term — and a
   * renew button quoting the old figure would send the buyer to underpay,
   * which is the one failure this platform cannot undo.
   */
  private async decorate(rows: Subscription[], userWallet: string) {
    const out = new Map<string, {
      agent: Record<string, unknown> | null;
      listing: Record<string, unknown> | null;
      receipt: Record<string, unknown> | null;
      pnl: Record<string, unknown> | null;
    }>();
    if (rows.length === 0) return out;

    const ids = rows.map((r) => r.id);
    const listingIds = rows.map((r) => r.listingId).filter(Boolean) as string[];
    const agentIds = rows.map((r) => r.agentId).filter(Boolean) as string[];

    const [listings, agents, receipts, pnls] = await Promise.all([
      listingIds.length
        ? this.subs.manager.query(
            `SELECT l.id::text AS id, l.price_usd::float8 AS price_usd, l.active,
                    l.access_type, l.arca_gate_amount::float8 AS arca_gate_amount
               FROM marketplace_listings l WHERE l.id = ANY($1::uuid[])`,
            [listingIds],
          )
        : Promise.resolve([]),
      agentIds.length
        ? this.subs.manager.query(
            `SELECT a.id::text AS id, a.name, a.version, a.status, a.strategy_type,
                    a.asset_universe, c.handle AS creator_handle, c.id::text AS creator_id
               FROM agents a LEFT JOIN creators c ON c.id = a.creator_id
              WHERE a.id = ANY($1::uuid[])`,
            [agentIds],
          )
        : Promise.resolve([]),
      listingIds.length
        ? this.subs.manager.query(
            `SELECT DISTINCT ON (listing_id) listing_id::text AS listing_id, tx_hash,
                    amount, block_number::text AS block_number, block_time, confirmations
               FROM payment_claims
              WHERE listing_id = ANY($1::uuid[]) AND lower(buyer_wallet) = lower($2)
              ORDER BY listing_id, block_time DESC`,
            [listingIds, userWallet],
          )
        : Promise.resolve([]),
      // WALLET P&L OVER THE TERM, from the subscription's own snapshots — the
      // buyer's wallet, not the agent's. Null with a reason when there are
      // fewer than two snapshots, because one reading is not a change.
      this.subs.manager.query(
        `SELECT subscription_id::text AS id,
                count(*)::int AS points,
                (array_agg(nav ORDER BY ts ASC))[1]::float8  AS first_nav,
                (array_agg(nav ORDER BY ts DESC))[1]::float8 AS last_nav
           FROM subscription_snapshots
          WHERE subscription_id = ANY($1::uuid[]) AND nav IS NOT NULL
          GROUP BY subscription_id`,
        [ids],
      ),
    ]);

    const byListing = new Map<string, any>(listings.map((l: any) => [l.id, l]));
    const byAgent = new Map<string, any>(agents.map((a: any) => [a.id, a]));
    const byReceipt = new Map<string, any>(receipts.map((r: any) => [r.listing_id, r]));
    const byPnl = new Map<string, any>(pnls.map((p: any) => [p.id, p]));

    for (const s of rows) {
      const l = s.listingId ? byListing.get(s.listingId) : null;
      const a = s.agentId ? byAgent.get(s.agentId) : null;
      const rc = s.listingId ? byReceipt.get(s.listingId) : null;
      const pn = byPnl.get(s.id);

      const first = pn?.first_nav === null || pn?.first_nav === undefined ? null : Number(pn.first_nav);
      const last = pn?.last_nav === null || pn?.last_nav === undefined ? null : Number(pn.last_nav);
      const points = Number(pn?.points ?? 0);
      const computable = points >= 2 && first !== null && last !== null && first !== 0;

      out.set(s.id, {
        agent: a
          ? {
              id: a.id,
              name: a.name,
              version: a.version,
              status: a.status,
              strategy_type: a.strategy_type,
              asset_universe: a.asset_universe,
              creator: a.creator_id ? { id: a.creator_id, handle: a.creator_handle } : null,
            }
          : null,
        listing: l
          ? {
              id: l.id,
              // TODAY'S price, labelled as today's. See the note above.
              price_usd_now: l.price_usd === null ? null : Number(l.price_usd),
              active: l.active === true,
              access_type: l.access_type,
              arca_gate_amount: l.arca_gate_amount === null ? null : Number(l.arca_gate_amount),
            }
          : null,
        receipt: rc
          ? {
              tx_hash: rc.tx_hash,
              amount_base_units: String(rc.amount),
              block_number: rc.block_number,
              block_time: rc.block_time ? new Date(rc.block_time).toISOString() : null,
              confirmations: rc.confirmations,
            }
          : null,
        pnl: {
          computable,
          reason: computable
            ? null
            : points === 0
              ? 'No snapshot of this subscription wallet has been recorded, so there is no pair of ' +
                'values to subtract. This is not a profit and loss of zero.'
              : points === 1
                ? 'Only one snapshot of this wallet exists. One reading is a value, not a change.'
                : 'The opening value of this wallet was zero or unreadable, so a percentage cannot be ' +
                  'formed from it.',
          first_nav: first,
          last_nav: last,
          pnl: computable ? Number((last! - first!).toFixed(2)) : null,
          pnl_pct: computable ? Number((((last! - first!) / first!) * 100).toFixed(4)) : null,
          points,
        },
      });
    }
    return out;
  }

  /** One sentence the buyer can act on. Never "everything is fine" when it is not. */
  private nextStep(s: Subscription, trading: boolean, expired: boolean, agentStatus?: string | null): string {
    if (!s.agentId) {
      return 'This listing names no agent, so nothing trades for this subscription. Your payment ' +
        'went through — the listing is the thing to look at.';
    }
    if (!s.walletAddress) {
      return 'Create your trading wallet with the button on this card (POST /v1/subscriptions/' + s.id +
        '/wallet), then fund it with USDG to trade and ETH for gas. The agent never spends anybody ' +
        'else’s money, so until you fund it nothing happens.';
    }
    if (s.tradingPaused) {
      return 'You have paused trading. The agent decides as usual and executes nothing for you. ' +
        'PATCH /v1/subscriptions/' + s.id + ' with tradingPaused=false to resume.';
    }
    if (expired || s.status !== 'active') {
      return 'The agent has stopped trading for this wallet. Whatever it holds stays where it is: ' +
        'read it at GET /v1/subscriptions/' + s.id + '/book, and take the key with ' +
        'POST /v1/subscriptions/' + s.id + '/wallet/export whenever you like.';
    }
    // The term is still running; the agent is not. Checked BEFORE `trading`,
    // which is now false for exactly this reason — without a branch here the
    // card would fall through to "not being traded for, and that is a bug".
    if (agentStatus === 'retired') {
      return 'This agent has been retired. Your access runs to the end of the term you paid for, but ' +
        'nothing more will be mirrored into this wallet, and it cannot be renewed. Read what it holds ' +
        'at GET /v1/subscriptions/' + s.id + '/book, and take the key with POST /v1/subscriptions/' +
        s.id + '/wallet/export whenever you like.';
    }
    if (agentStatus === 'paused') {
      return 'This agent is paused by its creator, so nothing is being mirrored into this wallet right now. ' +
        'Your term keeps running and mirroring resumes by itself if the agent does. What it already holds ' +
        'stays where it is — read it at GET /v1/subscriptions/' + s.id + '/book.';
    }
    if (trading) {
      return 'The agent is trading for this wallet. Your own limits size every position; the ' +
        'creator chooses only the direction. Read it at GET /v1/subscriptions/' + s.id + '/book.';
    }
    return 'This subscription is not being traded for, and the reason is not one this endpoint ' +
      'recognises. That is a bug — please report it rather than assuming it is fine.';
  }
}
