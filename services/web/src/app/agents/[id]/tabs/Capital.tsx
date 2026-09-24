/**
 * Capital — what the agent owes on Morpho, what backs it, and how close it is
 * to liquidation. architecture.md §17.6 acceptance 1: a person opens the agent
 * page and sees collateral, debt, health factor and liquidation price.
 *
 * WATCHED, NOT ACTED ON, and the block says so. The position guard reads these
 * from the chain about once a minute; nothing borrows, repays or deleverages on
 * them yet. A reader who assumed otherwise would trust a protection that does
 * not exist.
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

type CapitalResp = { agent_id: string; positions: CapitalPosition[]; acting: boolean; note: string };

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
        <span className="mono m3" style={{ fontSize: 10.5 }}>watched · not acted on</span>
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
    </section>
  );
}
