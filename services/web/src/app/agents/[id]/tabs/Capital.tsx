/**
 * Capital — what the agent owes on Morpho, what backs it, and how close it is
 * to liquidation. architecture.md §17.6 acceptance 1: a person opens the agent
 * page and sees collateral, debt, health factor and liquidation price.
 *
 * WHETHER ANYTHING ACTS ON IT IS SAID, from the mandate's status. The guard reads these
 * from the chain about once a minute; only an ACTIVE capital mandate borrows or
 * repays on them, and every one of its decisions is listed. A reader who assumed
 * otherwise would trust a protection that does not exist.
 *
 * TWO HEALTH FACTORS, printed side by side. Morpho's own is on the oracle
 * price, and it is the one liquidation is decided on. The second uses the lower
 * of the oracle and the pool: over a weekend the NVDA feed holds Friday's close
 * while the token keeps trading, and the gap between the two numbers is what
 * Monday's open could do (docs/go-no-go-lending.md condition 3).
 *
 * A STALE READ IS SAID OUT LOUD. If the latest row is more than ten minutes old
 * the reader has stopped, and a health factor from before it stopped is
 * history, not the position.
 */
import { agent } from '@/lib/api';
import { money, num, utc } from '@/lib/format';
import { Key, Num } from '@/components/ds/primitives';
import { Callout, Failed } from '@/components/ds/states';

type CapitalPosition = {
  market_id: string;
  wallet: string;
  collateral: { symbol: string; quantity: number; value_usdg: number };
  debt_usdg: number;
  lltv: number;
  health_factor: number | null;
  health_factor_worst: number | null;
  liquidation_price_usdg: number | null;
  prices: { oracle_usdg: number; pool_usdg: number | null };
  oracle: { base_feed_age_seconds: number | null; quote_feed_age_seconds: number | null; paused: boolean | null };
  watched_at: string;
  stale: boolean;
};

type CapitalAction = {
  id: number;
  ts: string;
  kind: 'hold' | 'supply' | 'borrow' | 'repay' | 'withdraw' | 'deleverage';
  amount: number;
  status: string;
  reason_code: string;
  decider: string;
  refusal_code: string | null;
  tx_hash: string | null;
  approve_tx_hash: string | null;
  why: string | null;
  refusal_detail: string | null;
  evidence: Record<string, unknown> | 'withheld' | null;
};

type CapitalResp = {
  agent_id: string;
  positions: CapitalPosition[];
  mandate: { status: string; activated_at: string | null } | null;
  record?: {
    borrowed_usdg: number;
    repaid_usdg: number;
    owed_usdg: number;
    interest_usdg: number;
    lowest_health_factor_worst: number | null;
    deleverage_steps: number;
    since: string | null;
    liquidations: number | null;
    liquidations_note: string;
  };
  actions: CapitalAction[];
  acting: boolean;
  note: string;
};

const hf = (v: number | null) => (v === null ? '—' : num(v, 2));
const tone = (v: number | null) => (v === null ? undefined : v < 1.1 ? 'var(--red)' : v < 1.5 ? 'var(--amber)' : undefined);
const age = (s: number | null) =>
  s === null ? 'unknown' : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;

export async function CapitalBlock({ id }: { id: string }) {
  const r = await agent<CapitalResp>(`/v1/agents/${id}/capital`);
  if (!r.ok) return <Failed what="The capital position" error={r} />;
  const d = r.data;

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
        <Key>Capital · borrowing against the book</Key>
        <span className="mono m3" style={{ fontSize: 10.5 }}>{d.acting ? 'watched · a capital mandate is active' : 'watched · not acted on'}</span>
      </div>

      {d.positions.length === 0 ? (
        <p className="m3" style={{ marginTop: 10, fontSize: 12.5 }}>
          Nothing borrowed and no collateral posted. {d.note}
        </p>
      ) : (
        <>
          {d.positions.some((p) => p.stale) ? (
            <div style={{ marginTop: 10 }}>
              <Callout tone="warn">
                <strong>These figures are more than ten minutes old.</strong> The reader has stopped, so they
                describe the position as it was, not as it is.
              </Callout>
            </div>
          ) : null}
          <div className="scroll-x">
            <table className="table" style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th style={{ width: 150 }}>Collateral</th>
                  <th className="r" style={{ width: 110 }}>Value</th>
                  <th className="r" style={{ width: 110 }}>Debt</th>
                  <th className="r" style={{ width: 120 }}>Health factor</th>
                  <th className="r" style={{ width: 130 }}>Worst case</th>
                  <th className="r" style={{ width: 130 }}>Liquidation at</th>
                  <th>Oracle</th>
                </tr>
              </thead>
              <tbody>
                {d.positions.map((p) => (
                  <tr key={p.market_id}>
                    <td className="mono">
                      <Num value={num(p.collateral.quantity, 6)} /> {p.collateral.symbol}
                    </td>
                    <td className="r"><Num value={money(p.collateral.value_usdg)} /></td>
                    <td className="r"><Num value={money(p.debt_usdg)} /></td>
                    <td className="r mono" style={{ color: tone(p.health_factor) }} title="Morpho's own, on the oracle price">
                      {hf(p.health_factor)}
                    </td>
                    <td className="r mono" style={{ color: tone(p.health_factor_worst) }}
                      title="On the lower of the oracle and the pool price">
                      {hf(p.health_factor_worst)}
                    </td>
                    <td className="r">
                      {p.liquidation_price_usdg === null ? (
                        <span className="mono m3">—</span>
                      ) : (
                        <>
                          <Num value={money(p.liquidation_price_usdg)} />
                          <div className="mono m3" style={{ fontSize: 10 }}>per {p.collateral.symbol} · LLTV {num(p.lltv * 100, 1)}%</div>
                        </>
                      )}
                    </td>
                    <td className="mono m3" style={{ fontSize: 10.5 }}>
                      {money(p.prices.oracle_usdg)} oracle
                      {p.prices.pool_usdg !== null ? ` · ${money(p.prices.pool_usdg)} pool` : ''}
                      <div>feed {age(p.oracle.base_feed_age_seconds)} old{p.oracle.paused ? ' · PAUSED' : ''}</div>
                      <div>read {utc(p.watched_at)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="m3" style={{ marginTop: 8, fontSize: 11.5 }}>{d.note}</p>
        </>
      )}

      {/* THE CAPITAL RECORD: beside the ARCANA Score, never inside it (§17.3). */}
      {d.record && d.record.since ? (
        <p className="mono m3" style={{ marginTop: 10, fontSize: 11 }}>
          since {utc(d.record.since)} · borrowed {money(d.record.borrowed_usdg)} · repaid {money(d.record.repaid_usdg)} ·
          owed {money(d.record.owed_usdg)} · interest {money(d.record.interest_usdg)}
          {d.record.lowest_health_factor_worst !== null ? ` · lowest worst-case HF ${num(d.record.lowest_health_factor_worst, 2)}` : ''}
          {` · deleverage steps ${d.record.deleverage_steps}`}
          <span title={d.record.liquidations_note}> · liquidations: not detected yet</span>
        </p>
      ) : null}

      {/* THE CAPITAL DECISION LOG. Every action the mandate chose and every
          refusal, newest first, with the reason and the inputs it was taken on
          — the capital equivalent of the Decisions tab (§12). */}
      {d.mandate || d.actions.length > 0 ? (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
            <Key>Capital decisions</Key>
            <span className="mono m3" style={{ fontSize: 10.5 }}>
              mandate {d.mandate ? d.mandate.status : 'none'}
              {d.mandate?.activated_at ? ` · since ${utc(d.mandate.activated_at)}` : ''}
            </span>
          </div>
          {d.actions.length === 0 ? (
            <p className="m3" style={{ marginTop: 8, fontSize: 12.5 }}>No capital decision has been recorded yet.</p>
          ) : (
            <div className="scroll-x">
              <table className="table" style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th style={{ width: 150 }}>When</th>
                    <th style={{ width: 90 }}>Action</th>
                    <th className="r" style={{ width: 110 }}>Amount</th>
                    <th style={{ width: 110 }}>Outcome</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {d.actions.map((a) => (
                    <tr key={a.id}>
                      <td className="mono" style={{ fontSize: 11 }}>{utc(a.ts)}</td>
                      <td className="mono">{a.kind}</td>
                      <td className="r">{a.kind === 'hold' ? <span className="m3">—</span> : <Num value={num(a.amount, a.kind === 'supply' ? 6 : 2)} />}</td>
                      <td className="mono" style={{ fontSize: 11, color: a.status === 'refused' || a.status === 'reverted' ? 'var(--red)' : undefined }}>
                        {a.status}
                        {a.refusal_code ? <div className="m3">{a.refusal_code}</div> : null}
                        {a.tx_hash ? <div className="m3" title={a.tx_hash}>{a.tx_hash.slice(0, 10)}…</div> : null}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        <span className="mono m3" style={{ fontSize: 10.5 }}>{a.reason_code}</span>
                        {a.why ? <div>{a.why}</div> : <div className="m3">withheld — this agent is private</div>}
                        {a.refusal_detail ? <div className="m3" style={{ fontSize: 11 }}>refused: {a.refusal_detail}</div> : null}
                        {a.evidence && a.evidence !== 'withheld' ? (
                          <details style={{ marginTop: 4 }}>
                            <summary className="m3" style={{ fontSize: 10.5, cursor: 'pointer' }}>inputs it was decided on</summary>
                            <pre className="mono" style={{ fontSize: 10, whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>
                              {JSON.stringify(a.evidence, null, 2)}
                            </pre>
                          </details>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
