import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SubscriptionsService } from './subscriptions.service';

/**
 * What a creator has actually been paid, and by whom.
 *
 * EVERY FIGURE IS A SUM OVER `payment_claims`, which is the table the chain
 * verification writes. Not over `subscriptions`: a subscription is access and a
 * claim is money, and the two diverge in both directions — a subscription
 * granted by a migration has no payment behind it, and a renewal is a second
 * payment against one row of access. Counting access as revenue would report
 * money that never moved.
 *
 * PAID IN BASE UNITS, CONVERTED ONCE. Every claim records the token it was paid
 * in, and this platform settles in one token today — but the column exists
 * because that has already changed once. Claims in a token whose decimals this
 * service cannot read are reported SEPARATELY and are not summed into the
 * total, because adding a number at the wrong scale is off by a power of ten
 * and looks like success.
 *
 * NOTHING PROJECTS. There is no "annualised", no "run rate", no forecast. A
 * creator with four weeks of history has four weeks of history.
 */
@Injectable()
export class EarningsService {
  constructor(
    private readonly db: DataSource,
    private readonly subs: SubscriptionsService,
  ) {}

  async forCreator(creatorId: string, decimals: number | null, tokenAddress: string | null) {
    const rows = await this.db.query(
      `SELECT id::text, handle, wallet_address FROM creators WHERE id = $1`,
      [creatorId],
    );
    if (rows.length === 0) throw new NotFoundException(`Creator ${creatorId} not found`);
    const creator = rows[0];

    if (!creator.wallet_address) {
      // NOT ZERO EARNINGS. A creator with no payee address has never been
      // payable, so there is nothing that could have arrived — a different
      // fact from having earned nothing, and the one that tells them what to
      // fix.
      return {
        creator: { id: creator.id, handle: creator.handle, wallet_address: null },
        payable: false,
        payable_note:
          'This creator has no wallet address on record, so no listing of theirs can be bought and no ' +
          'payment could ever have arrived. This is not earnings of zero — it is a payee that does not exist.',
        totals: null,
        by_week: [],
        recent: [],
        subscribers: null,
        as_of: new Date().toISOString(),
      };
    }

    const wallet = String(creator.wallet_address).toLowerCase();

    const [totals, byWeek, recent, subs, mismatched] = await Promise.all([
      this.db.query(
        `SELECT count(*)::int AS payments,
                coalesce(sum(amount), 0)::text AS base_units,
                min(block_time) AS first_payment,
                max(block_time) AS last_payment,
                count(*) FILTER (WHERE block_time > now() - interval '30 days')::int AS payments_30d,
                coalesce(sum(amount) FILTER (WHERE block_time > now() - interval '30 days'), 0)::text AS base_units_30d
           FROM payment_claims
          WHERE lower(creator_wallet) = $1
            AND ($2::text IS NULL OR lower(token_address) = $2)`,
        [wallet, tokenAddress],
      ),
      // WEEKS THAT HAPPENED, not a dense series. A week with no payment is
      // absent rather than present as zero: the bars a dashboard draws should
      // not imply the platform was running and earning nothing in a week
      // before the creator existed.
      this.db.query(
        `SELECT date_trunc('week', block_time) AS week,
                count(*)::int AS payments,
                coalesce(sum(amount), 0)::text AS base_units
           FROM payment_claims
          WHERE lower(creator_wallet) = $1
            AND ($2::text IS NULL OR lower(token_address) = $2)
            AND block_time > now() - interval '12 weeks'
          GROUP BY 1 ORDER BY 1`,
        [wallet, tokenAddress],
      ),
      this.db.query(
        `SELECT pc.tx_hash, pc.buyer_wallet, pc.amount::text AS amount, pc.block_time,
                pc.block_number::text AS block_number, pc.listing_id::text AS listing_id,
                a.name AS agent_name, a.id::text AS agent_id
           FROM payment_claims pc
           LEFT JOIN marketplace_listings l ON l.id = pc.listing_id
           LEFT JOIN agents a ON a.id = l.agent_id
          WHERE lower(pc.creator_wallet) = $1
          ORDER BY pc.block_time DESC LIMIT 20`,
        [wallet],
      ),
      this.db.query(
        `SELECT count(*) FILTER (WHERE s.status = 'active')::int AS active,
                count(*) FILTER (WHERE s.status = 'grace')::int  AS grace,
                count(*)::int                                     AS ever,
                count(DISTINCT s.user_wallet)::int                AS wallets
           FROM subscriptions s
           JOIN marketplace_listings l ON l.id = s.listing_id
           JOIN agents a ON a.id = l.agent_id
          WHERE a.creator_id = $1`,
        // ONE PLACEHOLDER, ONE PARAMETER. This passed [wallet, creatorId] and
        // used only $2, so Postgres could not type $1 and refused the query —
        // "could not determine data type of parameter $1", a 500 for every
        // creator with a wallet, from 2026-09-13 until this line.
        [creatorId],
      ),
      // Claims in some OTHER token. Counted and named, never added in.
      tokenAddress
        ? this.db.query(
            `SELECT token_address, count(*)::int AS payments
               FROM payment_claims
              WHERE lower(creator_wallet) = $1 AND lower(token_address) <> $2
              GROUP BY token_address`,
            [wallet, tokenAddress],
          )
        : Promise.resolve([]),
    ]);

    const t = totals[0] ?? {};
    const human = (base: string | null) =>
      decimals === null || base === null ? null : this.fromBase(base, decimals);

    return {
      creator: { id: creator.id, handle: creator.handle, wallet_address: wallet },
      payable: true,
      payable_note: null,
      totals: {
        payments: Number(t.payments ?? 0),
        base_units: String(t.base_units ?? '0'),
        amount: human(String(t.base_units ?? '0')),
        payments_30d: Number(t.payments_30d ?? 0),
        base_units_30d: String(t.base_units_30d ?? '0'),
        amount_30d: human(String(t.base_units_30d ?? '0')),
        first_payment: t.first_payment ? new Date(t.first_payment).toISOString() : null,
        last_payment: t.last_payment ? new Date(t.last_payment).toISOString() : null,
        token: tokenAddress,
        decimals,
        decimals_note:
          decimals === null
            ? 'The token decimals could not be read, so only base units are reported. A human figure ' +
              'assembled from a guessed scale would be wrong by a power of ten.'
            : null,
      },
      by_week: byWeek.map((w: Record<string, any>) => ({
        week: new Date(w.week).toISOString().slice(0, 10),
        payments: Number(w.payments),
        base_units: String(w.base_units),
        amount: human(String(w.base_units)),
      })),
      by_week_note:
        'Weeks with no payment are absent from this array rather than present with a total of zero. A ' +
        'dense series would draw an empty bar for a week before this creator existed.',
      recent: recent.map((r: Record<string, any>) => ({
        tx_hash: r.tx_hash,
        buyer_wallet: r.buyer_wallet,
        base_units: String(r.amount),
        amount: human(String(r.amount)),
        block_time: r.block_time ? new Date(r.block_time).toISOString() : null,
        block_number: r.block_number,
        listing_id: r.listing_id,
        agent_id: r.agent_id,
        agent_name: r.agent_name,
      })),
      subscribers: {
        active: Number(subs[0]?.active ?? 0),
        grace: Number(subs[0]?.grace ?? 0),
        ever: Number(subs[0]?.ever ?? 0),
        distinct_wallets: Number(subs[0]?.wallets ?? 0),
        note:
          'Counted from subscriptions against this creator’s listings. A subscriber is access; a ' +
          'payment is money. The two are counted separately here because a renewal is a second payment ' +
          'against one subscription, and a subscription can exist with no payment behind it.',
      },
      other_tokens: (mismatched as Array<Record<string, any>>).map((m) => ({
        token_address: m.token_address,
        payments: Number(m.payments),
      })),
      other_tokens_note:
        (mismatched as unknown[]).length === 0
          ? null
          : 'Payments recorded in a token other than the one this service settles in. They are NOT included ' +
            'in the totals above: their decimals are unknown here, and adding a figure at the wrong scale ' +
            'is wrong by a power of ten while looking like a larger number.',
      as_of: new Date().toISOString(),
    };
  }

  /** Base units to a human figure, exactly, without floating point. */
  private fromBase(v: string, decimals: number): string {
    const neg = v.startsWith('-');
    const abs = (neg ? v.slice(1) : v).padStart(decimals + 1, '0');
    const whole = abs.slice(0, abs.length - decimals);
    const frac = decimals === 0 ? '' : `.${abs.slice(abs.length - decimals)}`;
    return `${neg ? '-' : ''}${whole}${frac}`;
  }
}
