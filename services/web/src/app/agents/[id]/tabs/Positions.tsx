/**
 * Positions — what is open, and what is watching it.
 *
 * THIS TAB EXISTS BECAUSE OF A SPECIFIC FAILURE. An owner who asked for "get me
 * out if it drops 0.15%" ended up with a stop 15% away. Both are legitimate
 * levels; the record stated the one that was armed; and nobody was ever shown
 * the two side by side. So every level here is printed in BOTH scales — the
 * fraction the engine stores and the percent a person reads.
 *
 * A POSITION WITH NO GUARD IS THE HEADLINE, NOT A FOOTNOTE. It is coloured as
 * unprotected and carries the smallest level its pool would have accepted, so
 * "why isn't there a stop on this" is answered on the row that raises it.
 *
 * THREE KINDS OF MISSING PRICE ARE KEPT APART: the market could not be read,
 * the snapshot has no quote for this symbol, or there is a price. Collapsing the
 * first two would hide an outage behind a missing symbol. None of them is zero.
 *
 * P&L IS NULL UNLESS BOTH HALVES EXIST. An entry price only exists where a guard
 * recorded one — the record does not pair a buy to the position it opened — and
 * a P&L computed from one half of a subtraction is a number nobody can check.
 */
import { agent } from '@/lib/api';
import { frac, money, num, utc } from '@/lib/format';
import { Key, Num, Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed, Unavailable } from '@/components/ds/states';

/**
 * `levels: 'withheld'` is a PRIVATE agent's armed or refused guard: which
 * position is watched is public, the level it sits at is a risk rule and is not.
 * The level fields are absent then, not null — nothing was measured as zero.
 */
type Protection =
  | {
      state: 'armed';
      levels?: 'withheld';
      note?: string;
      stop_loss?: number | null;
      stop_loss_fraction?: number | null;
      stop_loss_percent?: number | null;
      take_profit?: number | null;
      take_profit_fraction?: number | null;
      take_profit_percent?: number | null;
      set_at?: string | null;
      held_back_since: string | null;
      held_back_because?: string | null;
    }
  | {
      state: 'refused';
      levels?: 'withheld';
      note?: string;
      smallest_accepted_fraction?: number | null;
      smallest_accepted_percent?: number | null;
      because?: string | null;
    }
  | { state: 'none'; because: string };

type OpenPosition = {
  symbol: string;
  quantity: number | null;
  entry_price: number | null;
  entry_known: boolean;
  /** fills = average cost of the recorded fills (0051); guard = a protective level's entry; null = unknown. */
  entry_source?: 'fills' | 'guard' | null;
  entry_note: string | null;
  price: number | null;
  price_status: 'unavailable' | 'symbol_not_in_snapshot' | 'from_snapshot';
  price_note: string;
  value: number | null;
  pnl: number | null;
  pnl_pct: number | null;
  protection: Protection;
};

type PositionsResp = {
  as_of: string | null;
  nav: number | null;
  cash: number | null;
  prices: { snapshot_ref: string | null; tick_time: string | null; available: boolean; reason: string | null; source: string };
  open: OpenPosition[];
  trades?: Trade[];
  trade_totals?: {
    closed: number;
    with_known_result: number;
    realized_pnl: number | null;
    gas_usd: number | null;
    net_pnl: number | null;
    winners: number;
    note: string;
  };
  closed: Array<{
    symbol: string;
    status: string;
    entry_price: number | null;
    stop_loss: number | null;
    stop_loss_percent: number | null;
    take_profit: number | null;
    take_profit_percent: number | null;
    set_at: string | null;
  }>;
  note: string | null;
};

/** A finished position: flat to flat, and what it made (0051). */
export type Trade = {
  symbol: string;
  episode: number;
  opened_at: string | null;
  closed_at: string | null;
  quantity: number | null;
  avg_entry: number | null;
  avg_exit: number | null;
  realized_pnl: number | null;
  gas_usd: number | null;
  net_pnl: number | null;
  net_pct: number | null;
  fills: number;
  reconstructed: boolean;
  note: string | null;
};

/** Small money: a $0.0053 result must not print as $0.01. */
const usd = (v: number | null | undefined, dp = 4) =>
  v === null || v === undefined || !Number.isFinite(v) ? null : `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(dp)}`;

export function TradesTable({ trades, limit }: { trades: Trade[]; limit?: number }) {
  const rows = typeof limit === 'number' ? trades.slice(0, limit) : trades;
  return (
    <div className="scroll-x">
      <table className="table" style={{ marginTop: 8 }}>
        <thead>
          <tr>
            <th style={{ width: 150 }}>Closed</th>
            <th style={{ width: 80 }}>Symbol</th>
            <th className="r">Quantity</th>
            <th className="r">Entry → exit</th>
            <th className="r">Realized</th>
            <th className="r">Gas</th>
            <th className="r">Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={`${t.symbol}-${t.episode}`}>
              <td className="mono m2" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
                {t.closed_at ? utc(t.closed_at) : '—'}
              </td>
              <td className="mono">{t.symbol}</td>
              <td className="r mono">{num(t.quantity, 8)}</td>
              <td className="r mono" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
                {t.avg_entry === null ? '—' : num(t.avg_entry, 4)} → {t.avg_exit === null ? '—' : num(t.avg_exit, 4)}
              </td>
              <td className={`r mono ${t.realized_pnl === null ? 'm3' : t.realized_pnl > 0 ? 'up' : t.realized_pnl < 0 ? 'dn' : ''}`} title={t.note ?? undefined}>
                {usd(t.realized_pnl) ?? 'unknown'}
              </td>
              <td className="r mono m2" title={t.gas_usd === null ? t.note ?? undefined : undefined}>
                {usd(t.gas_usd) ?? 'unpriced'}
              </td>
              <td className={`r mono ${t.net_pnl === null ? 'm3' : t.net_pnl > 0 ? 'up' : t.net_pnl < 0 ? 'dn' : ''}`} title={t.note ?? undefined}>
                {usd(t.net_pnl) ?? 'unknown'}
                {t.net_pct !== null ? <div className="m3" style={{ fontSize: 10 }}>{num(t.net_pct, 2)}%</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export async function PositionsTab({ id }: { id: string }) {
  const r = await agent<PositionsResp>(`/v1/agents/${id}/positions`);
  if (!r.ok) return <Failed what="The positions" error={r} />;
  const d = r.data;

  const unguarded = d.open.filter((p) => p.protection.state !== 'armed');
  const heldBack = d.open.filter(
    (p) => p.protection.state === 'armed' && (p.protection as { held_back_since: string | null }).held_back_since,
  );

  return (
    // minmax(0, 1fr): an implicit grid track is as wide as the table inside
    // it, so on a phone this tab was 796px and .scroll-x never got to scroll.
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 26 }}>
      {heldBack.length > 0 ? (
        <Callout tone="bad">
          <strong>
            {heldBack.length} position{heldBack.length === 1 ? '' : 's'} crossed a level and the exit was not taken.
          </strong>{' '}
          A level that is armed but held back is worse than no level, because its owner believes the position is
          covered.
        </Callout>
      ) : null}

      {unguarded.length > 0 ? (
        <Callout tone="warn">
          <strong>
            {unguarded.length} of {d.open.length} open position{d.open.length === 1 ? '' : 's'} {unguarded.length === 1 ? 'has' : 'have'} no armed level.
          </strong>{' '}
          Nothing is watching {unguarded.length === 1 ? 'it' : 'them'} between ticks. That is not a failure — a level
          is armed only when one is asked for — but it is the state of the book.
        </Callout>
      ) : null}

      <section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
          <Key>Open positions</Key>
          <span className="mono m3" style={{ fontSize: 10.5 }}>
            book read {utc(d.as_of)} · NAV {money(d.nav)} · cash {money(d.cash)}
          </span>
        </div>

        {d.open.length === 0 ? (
          <div style={{ marginTop: 10 }}>
            <Empty title="The book holds nothing">
              {d.note ?? 'The last recorded snapshot left the portfolio all in cash. This is a recorded zero, not a missing reading.'}
            </Empty>
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table" style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Symbol</th>
                  <th className="r" style={{ width: 110 }}>Quantity</th>
                  <th className="r" style={{ width: 110 }}>Entry</th>
                  <th className="r" style={{ width: 110 }}>Price now</th>
                  <th className="r" style={{ width: 110 }}>Value</th>
                  <th className="r" style={{ width: 130 }}>P&amp;L</th>
                  <th style={{ width: 180 }}>Protection</th>
                  <th>Level · price / fraction / %</th>
                </tr>
              </thead>
              <tbody>
                {d.open.map((p) => (
                  <tr key={p.symbol}>
                    <td className="mono">{p.symbol}</td>
                    <td className="r"><Num value={num(p.quantity, 6)} /></td>
                    <td className="r">
                      {p.entry_known ? (
                        <span title={p.entry_note ?? undefined}>
                          <Num value={money(p.entry_price)} />
                          <div className="mono m3" style={{ fontSize: 10 }}>
                            {p.entry_source === 'fills' ? 'avg cost' : p.entry_source === 'guard' ? 'from guard' : ''}
                          </div>
                        </span>
                      ) : (
                        <span className="mono m3" title={p.entry_note ?? undefined}>unknown</span>
                      )}
                    </td>
                    <td className="r">
                      {p.price_status === 'from_snapshot' ? (
                        <Num value={money(p.price)} />
                      ) : p.price_status === 'unavailable' ? (
                        <Unavailable reason={p.price_note} />
                      ) : (
                        <span className="mono m3" title={p.price_note}>not quoted</span>
                      )}
                    </td>
                    <td className="r">
                      {p.value === null ? <span className="mono m3">—</span> : <Num value={money(p.value)} />}
                    </td>
                    <td className="r">
                      {p.pnl === null ? (
                        <span className="mono m3" title={p.entry_known ? p.price_note : p.entry_note ?? undefined}>
                          not computable
                        </span>
                      ) : (
                        <>
                          <Num value={money(p.pnl)} tone={p.pnl > 0 ? 'up' : p.pnl < 0 ? 'dn' : 'flat'} />
                          <div className="mono m3" style={{ fontSize: 10.5 }}>{num(p.pnl_pct, 2)}%</div>
                        </>
                      )}
                    </td>
                    <td>
                      {p.protection.state === 'armed' ? (
                        (p.protection as { held_back_since: string | null }).held_back_since ? (
                          <Tag tone="red">ARMED · HELD BACK</Tag>
                        ) : (
                          <Tag tone="accent">ARMED</Tag>
                        )
                      ) : p.protection.state === 'refused' ? (
                        <Tag tone="red">REFUSED</Tag>
                      ) : (
                        <Tag tone="amber" title={p.protection.because}>NOTHING IS WATCHING</Tag>
                      )}
                    </td>
                    <td className="m2" style={{ fontSize: 12 }}>
                      {p.protection.state !== 'none' && p.protection.levels === 'withheld' ? (
                        // PRIVATE, NOT MISSING. The position is watched; the level
                        // is the owner's risk rule and is not published.
                        <span className="m3" title={p.protection.note}>
                          <span className="tag tag-outline">PRIVATE</span> level withheld
                          {p.protection.state === 'armed' && p.protection.held_back_since ? (
                            <div className="dn" style={{ fontSize: 11, marginTop: 3 }}>
                              crossed and NOT taken since {utc(p.protection.held_back_since)}
                            </div>
                          ) : null}
                        </span>
                      ) : p.protection.state === 'armed' ? (
                        <Levels
                          g={{
                            stop_loss: p.protection.stop_loss ?? null,
                            stop_loss_fraction: p.protection.stop_loss_fraction ?? null,
                            stop_loss_percent: p.protection.stop_loss_percent ?? null,
                            take_profit: p.protection.take_profit ?? null,
                            take_profit_fraction: p.protection.take_profit_fraction ?? null,
                            take_profit_percent: p.protection.take_profit_percent ?? null,
                            held_back_since: p.protection.held_back_since,
                            held_back_because: p.protection.held_back_because ?? null,
                          }}
                        />
                      ) : p.protection.state === 'refused' ? (
                        <>
                          {p.protection.because ?? 'the guard was refused and no reason was recorded'}
                          {p.protection.smallest_accepted_percent != null ? (
                            <div className="mono m3" style={{ fontSize: 11, marginTop: 2 }}>
                              smallest this pool accepts: {frac(p.protection.smallest_accepted_fraction ?? null, 6)} ={' '}
                              {num(p.protection.smallest_accepted_percent, 4)}%
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <span className="m3">{p.protection.because}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mono m3" style={{ fontSize: 10.5, marginTop: 8 }}>
          prices: {d.prices.available ? d.prices.source : `unavailable — ${d.prices.reason ?? 'no reason given'}`}
          {d.prices.snapshot_ref ? ` · ${d.prices.snapshot_ref}` : ''}
          {d.prices.tick_time ? ` · snapshot taken ${utc(d.prices.tick_time)}` : ''}
        </div>
      </section>

      {/* WHAT EACH FINISHED POSITION MADE. Recorded from its fills when they
          happened, not worked out on this page. */}
      <section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
          <Key>Closed positions · what each made</Key>
          {d.trade_totals && d.trade_totals.closed > 0 ? (
            <span className="mono m2" style={{ fontSize: 11 }} title={d.trade_totals.note}>
              {d.trade_totals.closed} closed · net{' '}
              <span className={(d.trade_totals.net_pnl ?? 0) > 0 ? 'up' : (d.trade_totals.net_pnl ?? 0) < 0 ? 'dn' : ''}>
                {usd(d.trade_totals.net_pnl) ?? '—'}
              </span>{' '}
              after {usd(d.trade_totals.gas_usd) ?? '—'} gas · {d.trade_totals.winners} of {d.trade_totals.with_known_result} positive
            </span>
          ) : null}
        </div>
        {!d.trades || d.trades.length === 0 ? (
          <div className="m3" style={{ fontSize: 12, marginTop: 8 }}>
            No position has been opened and closed again on record. A counted zero.
          </div>
        ) : (
          <>
            <TradesTable trades={d.trades} />
            <div className="m3" style={{ fontSize: 10.5, marginTop: 8, lineHeight: 1.45 }}>
              Average cost: the entry is the volume-weighted price of the buys since the position was last flat; realized
              is exit minus that, times what was sold. Prices are as filled, so a pool fee is already inside them; gas is
              not, and is subtracted for the net.
              {d.trades.some((t) => t.reconstructed)
                ? ' Positions closed before fills were stored were rebuilt from the executions and snapshots on record.'
                : ''}
            </div>
          </>
        )}
      </section>

      <section>
        <Key>Protective levels · history</Key>
        {d.closed.length === 0 ? (
          <div className="m3" style={{ fontSize: 12, marginTop: 8 }}>
            No position has been closed out with a recorded guard. The platform keeps a closing record only where a
            protective level existed, so this is what it can show rather than the whole trading history.
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Symbol</th>
                  <th style={{ width: 120 }}>Ended as</th>
                  <th className="r" style={{ width: 120 }}>Entry</th>
                  <th className="r" style={{ width: 190 }}>Stop · price / %</th>
                  <th className="r" style={{ width: 190 }}>Target · price / %</th>
                  <th style={{ width: 180 }}>Armed at</th>
                </tr>
              </thead>
              <tbody>
                {d.closed.map((c, i) => (
                  <tr key={`${c.symbol}-${c.set_at}-${i}`}>
                    <td className="mono">{c.symbol}</td>
                    <td><Tag tone="outline">{c.status.toUpperCase()}</Tag></td>
                    <td className="r"><Num value={money(c.entry_price)} /></td>
                    {(c as { levels?: string }).levels === 'withheld' ? (
                      <td className="r m3" colSpan={2} style={{ fontSize: 11.5 }}>
                        <span className="tag tag-outline">PRIVATE</span> levels withheld
                      </td>
                    ) : (
                      <>
                        <td className="r mono" style={{ fontSize: 11.5 }}>
                          {money(c.stop_loss)} <span className="m3">({num(c.stop_loss_percent, 4)}%)</span>
                        </td>
                        <td className="r mono" style={{ fontSize: 11.5 }}>
                          {money(c.take_profit)} <span className="m3">({num(c.take_profit_percent, 4)}%)</span>
                        </td>
                      </>
                    )}
                    <td className="mono m3" style={{ fontSize: 11 }}>{utc(c.set_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * A level in both scales.
 *
 * The price is what will actually fire. The fraction is what the engine stores
 * and what a mandate should be written in. The percent is what a person reads.
 * Printing any one alone is how 0.15 became 15%.
 */
function Levels({
  g,
}: {
  g: {
    stop_loss: number | null;
    stop_loss_fraction: number | null;
    stop_loss_percent: number | null;
    take_profit: number | null;
    take_profit_fraction: number | null;
    take_profit_percent: number | null;
    held_back_since: string | null;
    held_back_because: string | null;
  };
}) {
  return (
    <span className="mono" style={{ fontSize: 11.5 }}>
      {g.stop_loss === null && g.stop_loss_fraction === null ? (
        <span className="m3">no stop armed</span>
      ) : (
        <>
          stop {money(g.stop_loss)} <span className="m3">({frac(g.stop_loss_fraction, 6)} = {num(g.stop_loss_percent, 4)}%)</span>
        </>
      )}
      <br />
      {g.take_profit === null && g.take_profit_fraction === null ? (
        <span className="m3">no target armed</span>
      ) : (
        <>
          target {money(g.take_profit)} <span className="m3">({frac(g.take_profit_fraction, 6)} = {num(g.take_profit_percent, 4)}%)</span>
        </>
      )}
      {g.held_back_since ? (
        <div className="dn" style={{ fontSize: 11, marginTop: 3 }}>
          crossed and NOT taken since {utc(g.held_back_since)} — {g.held_back_because ?? 'no reason recorded'}
        </div>
      ) : null}
    </span>
  );
}
