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
import Link from 'next/link';
import { agent } from '@/lib/api';
import { int, money, num, txShort, utc } from '@/lib/format';
import { ActionTag, Key, Num, Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed, Unavailable } from '@/components/ds/states';
import { Pager } from '@/components/ds/nav';
import type { DecidedBy, DecisionsResponse, Evidence, Passport } from '../shapes';

const PAGE_SIZE = 25;

export async function DecisionsTab({
  id,
  p,
  page,
  open,
  filters,
  hrefFor,
}: {
  id: string;
  p: Passport | null;
  page: string;
  /** The decision whose evidence is expanded, from the URL. */
  open: string | null;
  filters: { action: string; symbol: string };
  hrefFor: (over: Record<string, string | undefined>) => string;
}) {
  const r = await agent<DecisionsResponse>(
    `/v1/agents/${id}/decisions?page=${encodeURIComponent(page)}&page_size=${PAGE_SIZE}` +
      (filters.action ? `&action=${encodeURIComponent(filters.action)}` : '') +
      (filters.symbol ? `&symbol=${encodeURIComponent(filters.symbol)}` : ''),
  );

  // THE EXPANDED ROW IS A URL, not client state. It can be linked to, and the
  // prompt and the raw answer are fetched on the server like everything else —
  // the evidence is the product, and it should survive being sent to someone.
  const evidence = open
    ? await agent<Evidence>(`/v1/agents/${id}/decisions/${encodeURIComponent(open)}/evidence`)
    : null;

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
                  <th className="r" style={{ width: 76 }}>Slip · bps</th>
                  <th className="r" style={{ width: 84 }}>Gas · USD</th>
                  <th style={{ minWidth: 260 }}>Thesis</th>
                  <th style={{ width: 130 }}>Tx</th>
                  <th style={{ width: 90 }} />
                </tr>
              </thead>
              <tbody>
                {d.decisions.map((row, i) => {
                  const isOpen = Boolean(row.decision_id && open === String(row.decision_id));
                  return (
                  <>
                  <tr key={`${row.ts}-${i}`} style={isOpen ? { background: 'rgba(47,232,140,.05)' } : undefined}>
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
                    <td className="r">
                      <Num value={row.execution?.slippage_bps === null || row.execution === null || row.execution === undefined
                        ? '—' : num(row.execution.slippage_bps, 2)} />
                    </td>
                    <td className="r">
                      <Num value={row.execution?.gas_cost_usd === null || row.execution === null || row.execution === undefined
                        ? '—' : num(row.execution.gas_cost_usd, 5)} />
                    </td>
                    <td className="m2" style={{ fontSize: 12 }}>
                      {/* THE THESIS IS WHAT MAKES A DECISION FALSIFIABLE — a
                          claim, a horizon, and the condition that would prove it
                          wrong. A protective exit has none, and says so rather
                          than borrowing the agent's words. */}
                      {row.decided_by?.category?.startsWith('protective') ? (
                        <span className="m3" style={{ fontStyle: 'italic' }}>
                          No thesis — {row.decided_by.label.toLowerCase()}, decided by a level rather than by the agent.
                        </span>
                      ) : row.thesis?.claim ? (
                        <>
                          {row.thesis.claim}
                          <div className="mono m3" style={{ fontSize: 10.5, marginTop: 3 }}>
                            {row.thesis.horizon_ticks ? `horizon ${row.thesis.horizon_ticks} ticks` : ''}
                            {row.thesis.confidence !== null && row.thesis.confidence !== undefined
                              ? ` · confidence ${num(row.thesis.confidence, 2)}` : ''}
                          </div>
                        </>
                      ) : (
                        <>
                          {row.rationale || <span className="m3">no rationale recorded</span>}
                          {row.model?.model ? null : (
                            <div className="mono m3" style={{ fontSize: 10.5, marginTop: 3 }}>
                              deterministic strategy — no model wrote a thesis
                            </div>
                          )}
                        </>
                      )}
                    </td>
                    <td className="mono m3" style={{ fontSize: 10.5 }} title={row.execution?.tx_hash ?? undefined}>
                      {row.execution?.tx_hash ? (
                        <>
                          {txShort(row.execution.tx_hash)}
                          <div style={{ fontSize: 9.5 }}>{row.execution.status}</div>
                        </>
                      ) : row.execution?.status ? (
                        <span title={row.execution.refusal_code ?? undefined}>{row.execution.status}</span>
                      ) : (
                        <span title="This decision placed no order.">—</span>
                      )}
                    </td>
                    <td>
                      {row.decision_id ? (
                        <Link
                          href={hrefFor({ open: isOpen ? undefined : String(row.decision_id) })}
                          style={{ fontSize: 11.5 }}
                        >
                          {isOpen ? 'Hide' : 'Evidence'}
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr>
                      <td colSpan={12} style={{ background: 'var(--color-surface)', padding: '16px 12px' }}>
                        {!evidence ? null : !evidence.ok ? (
                          <Failed what="The evidence" error={evidence} />
                        ) : (
                          <EvidenceBlock e={evidence.data} snapshot={row.evidence?.market_snapshot_ref ?? null} />
                        )}
                      </td>
                    </tr>
                  ) : null}
                  </>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Pager
            page={d.page}
            pageSize={d.page_size}
            total={d.total_decisions}
            totalPages={d.total_pages}
            unit="decisions"
            hrefFor={(n) => hrefFor({ page: String(Math.max(1, n)), open: undefined })}
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

/**
 * The prompt, the raw answer, and the model that produced them.
 *
 * THIS IS THE PRODUCT. "Anyone replays the record — prompt, response, snapshot,
 * fill, outcome — without a wallet and without asking the creator" is either
 * true on this screen or it is a slogan. So the bodies are shown in full, not
 * summarised, and a body that is missing says whether it was never recorded or
 * has since been pruned — two different facts about the same empty space.
 */
function EvidenceBlock({ e, snapshot }: { e: Evidence; snapshot: string | null }) {
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <span className="k">Evidence · decision {e.decision_id}</span>
        <span className="mono m3" style={{ fontSize: 10.5 }}>
          {e.model.model
            ? `${e.model.provider ?? '—'} · ${e.model.model}${e.model.model_version ? ` · ${e.model.model_version}` : ''}`
            : e.model.note}
        </span>
        {snapshot ? <span className="mono m3" style={{ fontSize: 10.5 }}>snapshot {snapshot}</span> : null}
      </div>

      {e.thesis ? (
        <div className="node" style={{ padding: '10px 12px' }}>
          <div className="lbl" style={{ marginBottom: 6 }}>THESIS</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: '4px 12px', fontSize: 12.5 }}>
            <span className="m3">claim</span><span>{e.thesis.claim ?? <span className="m3">not stated</span>}</span>
            <span className="m3">horizon</span>
            <span className="mono">{e.thesis.horizon_ticks ?? <span className="m3">not stated</span>}{e.thesis.horizon_ticks ? ' ticks' : ''}</span>
            <span className="m3">invalidated if</span>
            <span>{e.thesis.invalidated_if ?? <span className="m3">not stated</span>}</span>
          </div>
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
        <Body title="PROMPT" hash={e.prompt.hash} body={e.prompt.body} bytes={e.prompt.bytes} note={e.prompt.note} />
        <Body title="RAW RESPONSE" hash={e.response.hash} body={e.response.body} bytes={e.response.bytes} note={e.response.note} />
      </div>
    </div>
  );
}

function Body({
  title, hash, body, bytes, note,
}: { title: string; hash: string | null; body: string | null; bytes: number | null; note: string | null }) {
  return (
    <div className="node" style={{ padding: '10px 12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
        <span className="lbl">{title}</span>
        <span className="mono m3" style={{ fontSize: 9.5 }} title={hash ?? undefined}>
          {hash ? `${hash.slice(0, 12)}… · ${bytes ?? '?'} bytes` : 'no hash'}
        </span>
      </div>
      {body ? (
        <pre className="mono m2" style={{ fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, maxHeight: 320, overflow: 'auto' }}>
          {body}
        </pre>
      ) : (
        <div className="m3" style={{ fontSize: 11.5, lineHeight: 1.45 }}>{note ?? 'not recorded'}</div>
      )}
    </div>
  );
}
