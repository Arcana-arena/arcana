/**
 * One agent's liquidity provision: the positions it owns, the fees recorded
 * against them, and the harvest/close steps the executor has taken.
 *
 * SERVER-RENDERED AND READ-ONLY, LIKE THE REST OF THE PAGE. Opening, arming and
 * closing are executor acts with their own capped tools; there is deliberately
 * no button here that would imply a browser click can move this agent's funds.
 */
import type { Err } from '@/lib/api';
import { ago, int, num, txShort, utc } from '@/lib/format';
import { Tag } from '@/components/ds/primitives';
import { Empty, Failed } from '@/components/ds/states';
import {
  REC_TONE,
  shortId,
  stepTone,
  tokenIndex,
  units,
  type LPOpen,
  type LPPosition,
  type LPStep,
  type LPVenues,
} from '@/lib/lp';

export function LiquidityPanel({
  positions,
  executions,
  executionsError,
  opens,
  opensError,
  venues,
}: {
  positions: LPPosition[];
  executions: LPStep[];
  executionsError: Err | null;
  opens: LPOpen[];
  opensError: Err | null;
  venues: LPVenues | null;
}) {
  const token = tokenIndex(venues);
  const harvests = executions.filter((e) => e.intent === 'lp_collect');

  if (positions.length === 0) {
    return (
      <Empty title="This agent holds no LP position">
        The registry has no position for this agent&rsquo;s wallet. A position is opened by its owner through the
        executor&rsquo;s capped open command after funding the wallet — the platform cannot open one from here.
        <div style={{ marginTop: 10 }}>
          The public registry is at <a href="/liquidity">/liquidity</a>.
        </div>
      </Empty>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div className="scroll-x">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 150 }}>Pair</th>
              <th className="r" style={{ width: 120 }}>
                Range (ticks)
              </th>
              <th style={{ width: 70 }}>In range</th>
              <th style={{ width: 170 }}>Holds</th>
              <th style={{ width: 190 }}>Stored fees</th>
              <th style={{ width: 90 }}>Verdict</th>
              <th style={{ width: 70 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const t0 = token(p.token0);
              const t1 = token(p.token1);
              const a0 = units(p.amount0, t0.decimals);
              const a1 = units(p.amount1, t1.decimals);
              const f0 = units(p.tokens_owed0, t0.decimals);
              const f1 = units(p.tokens_owed1, t1.decimals);
              return (
                <tr key={`${p.position_manager}-${p.token_id}`}>
                  <td>
                    <span className="mono">
                      {t0.symbol} / {t1.symbol}
                    </span>
                    <div className="m3" style={{ fontSize: 10.5 }}>
                      #{p.token_id} · {(p.fee_tier / 10000).toFixed(2)}%
                    </div>
                  </td>
                  <td className="r mono" style={{ fontSize: 11 }}>
                    {int(p.tick_lower)} … {int(p.tick_upper)}
                  </td>
                  <td>
                    {p.in_range === null ? (
                      <span className="m3">—</span>
                    ) : p.in_range ? (
                      <Tag tone="accent">IN</Tag>
                    ) : (
                      <Tag tone="amber">OUT</Tag>
                    )}
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {a0 === null && a1 === null ? (
                      <span className="m3">—</span>
                    ) : (
                      <>
                        {num(a0, 4)} {t0.symbol}
                        <br />
                        {num(a1, 4)} {t1.symbol}
                      </>
                    )}
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {f0 === null && f1 === null ? (
                      <span className="m3">—</span>
                    ) : (
                      <>
                        {num(f0, 4)} {t0.symbol} · {num(f1, 4)} {t1.symbol}
                      </>
                    )}
                  </td>
                  <td>
                    {p.recommendation ? (
                      <Tag tone={REC_TONE[p.recommendation] ?? 'neutral'}>{p.recommendation}</Tag>
                    ) : (
                      <span className="m3">—</span>
                    )}
                  </td>
                  <td className="m2" style={{ fontSize: 11 }}>
                    {p.status}
                    <div className="m3" style={{ fontSize: 10 }} title={p.last_synced_at ?? undefined}>
                      {p.last_synced_at ? ago(p.last_synced_at) : 'never synced'}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <section>
        <div className="k">Fees harvested by the executor</div>
        {executionsError ? (
          <div style={{ marginTop: 8 }}>
            <Failed what="This agent's execution record" error={executionsError} />
          </div>
        ) : harvests.length === 0 ? (
          <div className="m3" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.45 }}>
            No fee harvest is recorded for this agent. Fees stay in the position (the stored figure above) until a
            harvest crosses the reviewed threshold, a rebalance, or a close.
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table" style={{ marginTop: 8, fontSize: 11.5 }}>
              <thead>
                <tr>
                  <th style={{ width: 130 }}>When</th>
                  <th style={{ width: 90 }}>Position</th>
                  <th style={{ width: 90 }}>Status</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {harvests.map((e) => (
                  <tr key={e.id}>
                    <td className="mono m2" style={{ whiteSpace: 'nowrap' }} title={e.ts}>
                      {utc(e.ts).slice(0, 16)}
                    </td>
                    <td className="mono">#{e.token_id}</td>
                    <td className={stepTone(e.status)} style={{ fontSize: 11 }}>
                      {e.status}
                    </td>
                    <td className="mono m2">
                      {e.tx_hash ? <span title={e.tx_hash}>{txShort(e.tx_hash)}</span> : <span className="m3">not sent</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="k">Positions opened through the platform</div>
        {opensError ? (
          <div style={{ marginTop: 8 }}>
            <Failed what="This agent's opens" error={opensError} />
          </div>
        ) : opens.length === 0 ? (
          <div className="m3" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.45 }}>
            No open is recorded for this agent. The first position is opened by its owner through the executor&rsquo;s
            open command, with a cap that has to be typed for that act.
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table" style={{ marginTop: 8, fontSize: 11.5 }}>
              <thead>
                <tr>
                  <th style={{ width: 130 }}>When</th>
                  <th style={{ width: 90 }}>Symbol</th>
                  <th className="r" style={{ width: 90 }}>
                    Size (USD)
                  </th>
                  <th style={{ width: 90 }}>Token id</th>
                  <th style={{ width: 90 }}>Status</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {opens.map((o) => (
                  <tr key={o.id}>
                    <td className="mono m2" style={{ whiteSpace: 'nowrap' }} title={o.ts}>
                      {utc(o.ts).slice(0, 16)}
                    </td>
                    <td className="mono">{o.symbol}</td>
                    <td className="r mono">{num(o.size_usd, 2)}</td>
                    <td className="mono">{o.token_id ? `#${o.token_id}` : <span className="m3">—</span>}</td>
                    <td className={o.status === 'executed' ? 'up' : 'dn'} style={{ fontSize: 11 }}>
                      {o.status}
                    </td>
                    <td className="mono m2">
                      {o.tx_hash ? <span title={o.tx_hash}>{txShort(o.tx_hash)}</span> : <span className="m3">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="m3" style={{ fontSize: 10.5, lineHeight: 1.45 }}>
        Agent <span className="mono">{shortId(positions[0].agent_id)}</span> · wallet{' '}
        <span className="mono">{positions[0].wallet}</span>
      </div>
    </div>
  );
}
