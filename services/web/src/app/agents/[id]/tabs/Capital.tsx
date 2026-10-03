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

/**
 * Agent Credit: the capital reputation, WITH ITS WORKING. The score is four
 * components in points; each is printed beside the figure it came from, and the
 * loans those figures were measured over are listed underneath. A number that
 * moves a debt limit has to be one a reader can recompute.
 */
type CreditCycle = {
  market_id: string;
  opened_at: string;
  closed_at: string | null;
  peak_debt_usdg: number;
  usdg_days: number;
  debt_seconds: number;
  seconds_under_floor: number;
  lowest_health_factor_worst: number | null;
  borrowed_usdg: number;
  repaid_usdg: number;
  interest_usdg: number | null;
  deleverage_steps: number;
  liquidations: number;
  closed_how: 'repaid' | 'deleveraged' | 'liquidated' | null;
};

type Credit = {
  enabled: boolean;
  status: 'no_record' | 'unrated' | 'rated';
  score: number | null;
  unrated_why: string | null;
  components: { exposure: number; margin: number; self_sufficiency: number; cycles_closed: number } | null;
  inputs: {
    figures?: {
      usdg_days: number;
      debt_days: number;
      share_under_floor: number;
      lowest_health_factor_worst: number | null;
      deleverage_steps: number;
      qualifying_cycles: number;
      cycles_repaid: number;
      evidence_fraction: number;
    };
    scored_days?: number;
  } | null;
  tier: number;
  earned_tier: number;
  held_because: string | null;
  held_because_note: string | null;
  limit_usdg: number;
  ceiling_usdg: number;
  tiers: Array<{ tier: number; min_score: number; max_debt_usdg: number; min_scored_days: number }>;
  computed_at: string | null;
  confirmed_at: string | null;
  stale: boolean;
  cycles: { total: number; open: number; repaid: number; deleveraged: number; liquidated: number; list: CreditCycle[]; truncated: boolean };
  liquidations: {
    count: number | null;
    scanned_at: string | null;
    scanned_to_block: string | null;
    list: Array<{ ts: string; tx_hash: string; liquidator: string; repaid_usdg: number; seized_qty: number; bad_debt_usdg: number }>;
  };
  note: string;
};

const days = (seconds: number) => num(seconds / 86400, 1);

function CreditBlock({ c }: { c: Credit }) {
  const f = c.inputs?.figures;
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
        <Key>Capital reputation</Key>
        <span className="mono m3" style={{ fontSize: 10.5 }}>
          {c.confirmed_at ? `confirmed ${utc(c.confirmed_at)}` : 'never computed'}
          {c.enabled ? ' · the tier sets the limit' : ' · shown only, moves no limit yet'}
        </span>
      </div>

      {c.stale ? (
        <div style={{ marginTop: 10 }}>
          <Callout tone="warn">
            <strong>This reputation has not been re-checked for two days.</strong> The guard that computes it has
            stopped, so it grants tier 0 until it runs again.
          </Callout>
        </div>
      ) : null}

      <div style={{ marginTop: 10, display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <div className="mono m3" style={{ fontSize: 10 }}>CREDIT SCORE</div>
          <div className="mono" style={{ fontSize: 22 }}>
            {c.status === 'rated' && c.score !== null ? <Num value={num(c.score, 0)} /> : <span className="m3">unrated</span>}
          </div>
        </div>
        <div>
          <div className="mono m3" style={{ fontSize: 10 }}>TIER</div>
          <div className="mono" style={{ fontSize: 15 }}>
            {c.tier}
            {c.earned_tier > c.tier ? <span className="m3"> · earned {c.earned_tier}</span> : null}
          </div>
        </div>
        <div>
          <div className="mono m3" style={{ fontSize: 10 }}>CREDIT LIMIT</div>
          <div className="mono" style={{ fontSize: 15 }}><Num value={money(c.limit_usdg)} /> USDG</div>
        </div>
        <div>
          <div className="mono m3" style={{ fontSize: 10 }}>LOANS</div>
          <div className="mono" style={{ fontSize: 15 }}>
            {c.cycles.repaid} repaid of {c.cycles.total}
            {c.cycles.open > 0 ? <span className="m3"> · {c.cycles.open} open</span> : null}
          </div>
        </div>
        <div>
          <div className="mono m3" style={{ fontSize: 10 }}>LIQUIDATIONS</div>
          <div className="mono" style={{ fontSize: 15, color: c.liquidations.count ? 'var(--red)' : undefined }}>
            {c.liquidations.count === null ? <span className="m3">not read yet</span> : c.liquidations.count}
          </div>
        </div>
      </div>

      {c.status !== 'rated' && c.unrated_why ? (
        <p className="m2" style={{ marginTop: 8, fontSize: 12.5 }}>
          Unrated: {c.unrated_why}. Unrated is not a low score — there is not yet enough of a record to give one.
        </p>
      ) : null}
      {c.held_because_note ? (
        <p className="m2" style={{ marginTop: 8, fontSize: 12.5 }}>
          The score earns tier {c.earned_tier}; the agent holds tier {c.tier}. {c.held_because_note}
        </p>
      ) : null}
      <p className="m3" style={{ marginTop: 8, fontSize: 11.5 }}>{c.note}</p>

      {c.status === 'rated' && c.components && f ? (
        <div className="scroll-x">
          <table className="table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th style={{ width: 190 }}>Component</th>
                <th className="r" style={{ width: 90 }}>Points</th>
                <th className="r" style={{ width: 70 }}>Of</th>
                <th>Measured from</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Seasoned exposure</td>
                <td className="r"><Num value={num(c.components.exposure, 1)} /></td>
                <td className="r mono m3">35</td>
                <td className="m2" style={{ fontSize: 12 }}>
                  {num(f.usdg_days, 0)} USDG-days carried across {f.qualifying_cycles} qualifying loan(s) —{' '}
                  {num(f.evidence_fraction * 100, 0)}% of full evidence
                </td>
              </tr>
              <tr>
                <td>Margin kept</td>
                <td className="r"><Num value={num(c.components.margin, 1)} /></td>
                <td className="r mono m3">30</td>
                <td className="m2" style={{ fontSize: 12 }}>
                  lowest worst-case health factor {hf(f.lowest_health_factor_worst)};{' '}
                  {num(f.share_under_floor * 100, 1)}% of {num(f.debt_days, 1)} debt-days spent under 1.5
                </td>
              </tr>
              <tr>
                <td>Self-sufficiency</td>
                <td className="r"><Num value={num(c.components.self_sufficiency, 1)} /></td>
                <td className="r mono m3">20</td>
                <td className="m2" style={{ fontSize: 12 }}>
                  the guard had to deleverage {f.deleverage_steps} time(s)
                </td>
              </tr>
              <tr>
                <td>Loans closed</td>
                <td className="r"><Num value={num(c.components.cycles_closed, 1)} /></td>
                <td className="r mono m3">15</td>
                <td className="m2" style={{ fontSize: 12 }}>
                  {f.cycles_repaid} qualifying loan(s) repaid without the guard or a liquidator
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}

      {c.tiers.length > 0 ? (
        <p className="mono m3" style={{ marginTop: 10, fontSize: 11 }}>
          tiers:{' '}
          {c.tiers.map((t) =>
            `${t.tier} → ${money(t.max_debt_usdg, 0)} USDG` +
            (t.tier > 0 ? ` at ${t.min_score}+` : '') +
            (t.min_scored_days > 0 ? ` and ${t.min_scored_days} scored days` : '')).join(' · ')}
          {c.enabled ? '' : ` · not enabled: every agent may owe ${money(c.ceiling_usdg, 0)}`}
        </p>
      ) : null}

      {c.cycles.list.length > 0 ? (
        <div className="scroll-x">
          <table className="table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th style={{ width: 150 }}>Opened</th>
                <th style={{ width: 150 }}>Closed</th>
                <th className="r" style={{ width: 100 }}>Peak debt</th>
                <th className="r" style={{ width: 100 }}>USDG-days</th>
                <th className="r" style={{ width: 80 }}>Days</th>
                <th className="r" style={{ width: 90 }}>Lowest HF</th>
                <th className="r" style={{ width: 90 }}>Interest</th>
                <th>How it closed</th>
              </tr>
            </thead>
            <tbody>
              {c.cycles.list.map((y) => (
                <tr key={`${y.market_id}-${y.opened_at}`}>
                  <td className="mono" style={{ fontSize: 11 }}>{utc(y.opened_at)}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{y.closed_at ? utc(y.closed_at) : <span className="m3">open</span>}</td>
                  <td className="r"><Num value={money(y.peak_debt_usdg)} /></td>
                  <td className="r"><Num value={num(y.usdg_days, 1)} /></td>
                  <td className="r mono">{days(y.debt_seconds)}</td>
                  <td className="r mono" style={{ color: tone(y.lowest_health_factor_worst) }}>{hf(y.lowest_health_factor_worst)}</td>
                  <td className="r">{y.interest_usdg === null ? <span className="mono m3">—</span> : <Num value={money(y.interest_usdg)} />}</td>
                  <td className="mono" style={{ fontSize: 11, color: y.closed_how === 'liquidated' ? 'var(--red)' : undefined }}>
                    {y.closed_how ?? 'still owed'}
                    {y.deleverage_steps > 0 ? <span className="m3"> · {y.deleverage_steps} deleverage step(s)</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {c.cycles.truncated ? (
            <p className="m3" style={{ fontSize: 11, marginTop: 6 }}>
              The most recent {c.cycles.list.length} of {c.cycles.total} loans. The score is computed over all of them.
            </p>
          ) : null}
        </div>
      ) : null}

      {c.liquidations.list.length > 0 ? (
        <div className="scroll-x">
          <table className="table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th style={{ width: 150 }}>Liquidated</th>
                <th className="r" style={{ width: 120 }}>Seized</th>
                <th className="r" style={{ width: 120 }}>Debt repaid</th>
                <th className="r" style={{ width: 110 }}>Bad debt</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {c.liquidations.list.map((l) => (
                <tr key={l.tx_hash}>
                  <td className="mono" style={{ fontSize: 11 }}>{utc(l.ts)}</td>
                  <td className="r"><Num value={num(l.seized_qty, 6)} /></td>
                  <td className="r"><Num value={money(l.repaid_usdg)} /></td>
                  <td className="r"><Num value={money(l.bad_debt_usdg)} /></td>
                  <td className="mono m3" style={{ fontSize: 11 }} title={l.tx_hash}>{l.tx_hash.slice(0, 18)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

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
  credit?: Credit;
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
          <span title={d.record.liquidations_note}>
            {' · liquidations: '}
            {d.record.liquidations === null ? 'not read yet' : d.record.liquidations}
          </span>
        </p>
      ) : null}

      {d.credit ? <CreditBlock c={d.credit} /> : null}

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
