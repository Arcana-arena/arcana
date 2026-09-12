/**
 * Decisions — every tick, including the ones where nothing happened.
 *
 * A HOLD IS A DECISION AND IT IS LISTED. Filtering to trades only would turn a
 * cautious agent into a quiet one and make the record look shorter than it is.
 *
 * `price_status` IS PRINTED, NEVER SUBSTITUTED. A row can carry `price: null`
 * with a status saying why — `no_symbol` on a hold, `unavailable` when the
 * snapshot had no quote. Printing 0.00 there would invent a price of zero for a
 * share of a real company. So a null price shows the STATUS, not a number.
 *
 * WHO DECIDED IS ON EVERY ROW. `decider` and `reason_code` come back as the
 * columns hold them, and `decided_by` is the backend's reading of the pair. A
 * sale a stop loss took is marked as one, and is not the agent's trade.
 *
 * THE DISTINCTION THAT IS EASY TO GET WRONG, and which this table does not:
 * `decider = 'protective'` does not mean a level fired. Most protective rows on
 * this platform are HOLDS carrying `cost_budget_exceeded` — written when a level
 * WAS crossed and the exit was NOT taken because the cost meter refused it. That
 * is a stop that did not fire, and it is rendered in red as the warning it is,
 * not as an exit.
 */
import { agent } from '@/lib/api';
import { int, money, num, utc } from '@/lib/format';
import { ActionTag, Key, Num, Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed, Unavailable } from '@/components/ds/states';
import { Pager } from '@/components/ds/nav';
import type { DecidedBy, DecisionsResponse, Passport } from '../shapes';

const PAGE_SIZE = 25;

export async function DecisionsTab({ id, p, page }: { id: string; p: Passport | null; page: string }) {
  const r = await agent<DecisionsResponse>(
    `/v1/agents/${id}/decisions?page=${encodeURIComponent(page)}&page_size=${PAGE_SIZE}`,
  );

  if (!r.ok) return <Failed what="The decision log" error={r} />;
  const d = r.data;

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
        <Key>
          Decisions · <span className="mono">{int(d.total_decisions)}</span> recorded
        </Key>
        {d.prices ? (
          <span className="mono m3" style={{ fontSize: 10.5 }}>
            prices: {d.prices.status}
            {d.prices.reason ? ` — ${d.prices.reason}` : ''}
            {d.prices.missing_refs?.length ? ` · ${d.prices.missing_refs.length} snapshot refs missing` : ''}
          </span>
        ) : null}
      </div>

      {p?.decided_by ? (
        <Callout tone="note">
          <strong>Every row says who decided it.</strong> Across this agent&rsquo;s whole record,{' '}
          <span className="mono">{int(p.decided_by.own)}</span> trades were its own,{' '}
          <span className="mono">{int(p.decided_by.protective)}</span> were exits a protective level took, and{' '}
          <span className="mono">{int(p.decided_by.unattributed)}</span> predate the{' '}
          <span className="mono">decider</span> column and do not say. A trade the platform took is never counted as
          the agent&rsquo;s.
        </Callout>
      ) : null}

      {d.decisions.length === 0 ? (
        <Empty title="No decisions on this page">
          {d.total_decisions === 0
            ? 'This agent has never recorded a decision. Nothing has been withheld — there is nothing.'
            : `The agent has ${d.total_decisions} decisions, but page ${d.page} holds none of them.`}
        </Empty>
      ) : (
        <>
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 168 }}>Time (UTC)</th>
                  <th style={{ width: 62 }}>Action</th>
                  <th style={{ width: 150 }} title="Read from decisions.decider and decisions.reason_code. A trade a protective level took is not the agent's decision.">
                    Decided by
                  </th>
                  <th style={{ width: 78 }}>Symbol</th>
                  <th className="r" style={{ width: 96 }}>
                    Quantity
                  </th>
                  <th className="r" style={{ width: 110 }}>
                    Price
                  </th>
                  <th className="r" style={{ width: 110 }}>
                    Notional
                  </th>
                  <th style={{ minWidth: 280 }}>Rationale</th>
                  <th style={{ width: 150 }}>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {d.decisions.map((row, i) => (
                  <tr key={`${row.ts}-${i}`}>
                    <td className="mono m2" style={{ fontSize: 11.5 }}>
                      {utc(row.ts)}
                    </td>
                    <td>
                      <ActionTag action={row.action} />
                    </td>
                    <td>
                      <DecidedByCell d={row.decided_by ?? null} />
                    </td>
                    <td className="mono">
                      {row.symbol ? (
                        row.symbol
                      ) : (
                        <span className="m3" title="A hold with no symbol: the decision was about the book as a whole.">
                          —
                        </span>
                      )}
                    </td>
                    <td className="r">
                      <Num value={num(row.quantity, 4)} />
                    </td>
                    <td className="r">
                      {row.price === null || row.price === undefined ? (
                        <PriceAbsent status={row.price_status} />
                      ) : (
                        <Num value={money(row.price)} />
                      )}
                    </td>
                    <td className="r">
                      {row.notional === null || row.notional === undefined ? (
                        <PriceAbsent status={row.price_status} />
                      ) : (
                        <Num value={money(row.notional)} />
                      )}
                    </td>
                    <td className="m2" style={{ fontSize: 12 }}>
                      {row.rationale || <span className="m3">no rationale recorded</span>}
                      {row.resulting_allocation && Object.keys(row.resulting_allocation).length > 0 ? (
                        <div className="mono m3" style={{ fontSize: 10.5, marginTop: 3 }}>
                          after:{' '}
                          {Object.entries(row.resulting_allocation)
                            .map(([sym, v]) => `${sym} ${num(v, 2)}%`)
                            .join(' · ')}
                        </div>
                      ) : null}
                    </td>
                    <td className="mono m3" style={{ fontSize: 10.5 }}>
                      {row.evidence?.market_snapshot_ref ? (
                        <span title={`content hash ${row.evidence.content_hash ?? 'not recorded'}`}>
                          {row.evidence.market_snapshot_ref}
                          <br />
                          {row.evidence.source ?? '—'}
                          {row.evidence.ingest_mode ? ` · ${row.evidence.ingest_mode}` : ''}
                        </span>
                      ) : (
                        <span title="No market snapshot reference on this row.">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pager
            page={d.page}
            pageSize={d.page_size}
            total={d.total_decisions}
            totalPages={d.total_pages}
            unit="decisions"
            hrefFor={(n) => `/agents/${id}?tab=decisions&page=${Math.max(1, n)}`}
          />
        </>
      )}
    </div>
  );
}

/**
 * Who decided this row.
 *
 * FIVE STATES, FIVE APPEARANCES, because they are five different facts:
 *
 *   agent                 the agent's own call — plain, since it is the norm
 *   protective_exit       a level fired and sold — amber, and it says which level
 *   protective_held_back  a level was crossed and NOTHING sold — RED, because a
 *                         stop that did not fire is more dangerous than no stop:
 *                         the position is open and its owner believes it is not
 *   protective_other      marked protective, reason unrecognised — shown as-is
 *   unattributed          the row does not say. Dashed and muted, never folded
 *                         into the agent's column
 *
 * The label and the sentence are the backend's. Nothing is decided here.
 */
function DecidedByCell({ d }: { d: DecidedBy | null }) {
  if (!d) {
    return (
      <span className="mono m3" style={{ fontSize: 10.5 }} title="This response carried no decided_by for the row.">
        not reported
      </span>
    );
  }
  const tone =
    d.category === 'protective_held_back'
      ? 'red'
      : d.category === 'protective_exit'
        ? 'amber'
        : d.category === 'protective_other'
          ? 'amber'
          : d.category === 'unattributed'
            ? 'dashed'
            : 'neutral';
  return (
    <span title={d.note}>
      <Tag tone={tone}>{d.label}</Tag>
      {d.reason_code ? (
        <div className="mono m3" style={{ fontSize: 9.5, marginTop: 2 }}>
          {d.reason_code}
        </div>
      ) : null}
    </span>
  );
}

/**
 * A price that is not there, showing WHY it is not there.
 *
 * `no_symbol` — a hold about the whole book; there was no instrument to price.
 * `unavailable` — the snapshot carried no quote for this symbol at this tick.
 * Neither is zero, and they are not the same as each other either.
 */
function PriceAbsent({ status }: { status: string | null }) {
  if (status === 'no_symbol') {
    return (
      <span className="mono m3" title="This decision named no symbol, so there is no price to record.">
        n/a
      </span>
    );
  }
  if (status === 'unavailable' || status === 'missing') {
    return <Unavailable reason="The market snapshot for this tick carried no quote for this symbol." />;
  }
  return (
    <span className="mono m3" title={status ? `price_status: ${status}` : 'No price and no status were recorded.'}>
      {status ?? '—'}
    </span>
  );
}
