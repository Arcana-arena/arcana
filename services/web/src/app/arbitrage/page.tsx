/**
 * Arbitrage, read-only.
 *
 * WHAT THIS PAGE IS: the public view of the registry the arbitrage service
 * keeps — which agent wallets own which Uniswap v3 positions, what the last
 * sync read, and what the executor has done about it. The strategy it runs is
 * liquidity provision (see the callout below for why that, and not a pair of
 * taker legs), so the rows are LP positions: that is the service's vocabulary
 * and this page does not rename them.
 *
 * NOTHING HERE IS COMPUTED. Positions arrive in the registry's order and every
 * verdict, amount and status is the service's own. The fee column is labelled
 * as the STORED figure (tokensOwed at the last position touch) rather than the
 * exact accrual: the exact number needs a per-position feeGrowthInside read,
 * which the position endpoint performs one NFT at a time — a public page will
 * not fan that out per row. The label says which number it is, so a reader is
 * never shown a lower bound dressed as a total.
 */
import Link from 'next/link';
import type { Metadata } from 'next';
import { arbitrage } from '@/lib/api';
import { ago, int, num, txShort, utc } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed } from '@/components/ds/states';
import {
  REC_TONE,
  shortId,
  stepTone,
  tokenIndex,
  units,
  type LPAction,
  type LPOpen,
  type LPPosition,
  type LPStep,
  type LPVenues,
} from '@/lib/lp';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Arbitrage — ARCANA' };

function AgentCell({ id }: { id: string }) {
  return (
    <Link href={`/agents/${id}`} className="mono" style={{ fontSize: 11 }} title={id}>
      {shortId(id)}
    </Link>
  );
}

export default async function ArbitragePage() {
  const [venuesR, positionsR, actionsR, executionsR, opensR] = await Promise.all([
    arbitrage<LPVenues>('/v1/arbitrage/venues'),
    arbitrage<{ positions: LPPosition[] }>('/v1/arbitrage/lp/positions?status=all&limit=100'),
    arbitrage<{ actions: LPAction[] }>('/v1/arbitrage/lp/actions?limit=50'),
    arbitrage<{ executions: LPStep[] }>('/v1/arbitrage/lp/executions?limit=50'),
    arbitrage<{ opens: LPOpen[] }>('/v1/arbitrage/lp/opens?limit=20'),
  ]);

  const token = tokenIndex(venuesR.ok ? venuesR.data : null);

  const positions = positionsR.ok ? positionsR.data.positions : [];
  const actions = actionsR.ok ? actionsR.data.actions : [];
  const executions = executionsR.ok ? executionsR.data.executions : [];
  const opens = opensR.ok ? opensR.data.opens : [];

  const stamps = [
    ...positions.map((p) => p.last_synced_at),
    ...actions.map((a) => a.ts),
    ...executions.map((e) => e.ts),
    ...opens.map((o) => o.ts),
  ]
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .sort();
  const latest = stamps.length > 0 ? stamps[stamps.length - 1] : null;
  const openCount = positions.filter((p) => p.status === 'open').length;

  return (
    <div className="page">
      <Header current="Arbitrage" />

      <div className="sec" style={{ paddingTop: 32, paddingBottom: 0, borderBottom: 'none' }}>
        <h1>Arbitrage</h1>
        <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 4 }}>
          Agent-owned Uniswap v3 positions, read from the chain by the arbitrage service and acted on by the executor.
          No wallet is needed to read this page.
        </div>
      </div>

      <div className="sec" style={{ paddingTop: 14, paddingBottom: 14 }}>
        <Callout tone="note">
          <strong>What the name means here.</strong> A taker spread between two venues has to clear the gas both legs
          cost, and on this chain the measured residual does not. So the arbitrage service takes the other side of the
          trade instead: a position deposits a pair — a Stock Token against USDG, or WETH against USDG — into a pool and
          earns the fee every swap through its range pays. The registry re-reads each position every five minutes.{' '}
          <em>Harvest</em> collects fees once their exact accrual crosses a reviewed threshold; <em>rebalance</em> moves
          a range the price has left; <em>close</em> collects and burns a position that was emptied. A position that
          leaves its range stops earning — that is the risk this activity carries, and the verdict column says when it
          has happened.
        </Callout>
      </div>

      {/* ------------------------------------------------------------ positions */}
      <div className="sec">
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
          <h2>Positions</h2>
          <span className="mono m3" style={{ fontSize: 11 }}>
            {int(positions.length)} registered · {int(openCount)} open
          </span>
        </div>
        {!positionsR.ok ? (
          <Failed what="The arbitrage registry" error={positionsR} />
        ) : positions.length === 0 ? (
          <Empty title="No arbitrage position is registered yet">
            The registry discovers positions from the chain — nothing can appear here until an agent&rsquo;s wallet owns
            one. The first position is opened by its owner through the executor&rsquo;s open command, with a cap that
            has to be typed.
          </Empty>
        ) : (
          <div className="scroll-x">
            <table className="table" style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th style={{ width: 170 }}>Pair</th>
                  <th style={{ width: 100 }}>Agent</th>
                  <th className="r" style={{ width: 130 }}>Range (ticks)</th>
                  <th style={{ width: 80 }}>In range</th>
                  <th style={{ width: 200 }}>Holds</th>
                  <th style={{ width: 200 }}>
                    <span title="tokensOwed stored at the last position touch — a lower bound on the accrual. The position endpoint reports the exact number for one NFT at a time.">
                      Stored fees
                    </span>
                  </th>
                  <th style={{ width: 100 }}>Verdict</th>
                  <th style={{ width: 80 }}>Status</th>
                  <th className="r" style={{ width: 90 }}>Synced</th>
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
                    <tr
                      key={`${p.position_manager}-${p.token_id}`}
                      style={p.status === 'closed' ? { color: 'var(--ink-2)' } : undefined}
                    >
                      <td>
                        <span className="mono">
                          {t0.symbol} / {t1.symbol}
                        </span>
                        <div className="m3" style={{ fontSize: 10.5 }}>
                          #{p.token_id} · {(p.fee_tier / 10000).toFixed(2)}%
                        </div>
                      </td>
                      <td>
                        <AgentCell id={p.agent_id} />
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
                      <td>
                        <Tag tone={p.status === 'open' ? 'neutral' : 'outline'}>{p.status}</Tag>
                      </td>
                      <td className="r mono m3" style={{ fontSize: 10.5 }} title={p.last_synced_at ?? undefined}>
                        {p.last_synced_at ? ago(p.last_synced_at) : 'never'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------ proposals */}
      <div className="sec">
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
          <h2>Standing proposals</h2>
          <span className="mono m3" style={{ fontSize: 11 }}>
            {int(actions.length)} outstanding
          </span>
        </div>
        {!actionsR.ok ? (
          <Failed what="The proposal queue" error={actionsR} />
        ) : actions.length === 0 ? (
          <Empty title="No proposal is standing">
            The loop proposes only when a position&rsquo;s verdict changes — fees crossing the harvest threshold, a
            price leaving its range, or a position emptied. A quiet queue is the normal state.
          </Empty>
        ) : (
          <div className="scroll-x">
            <table className="table" style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th style={{ width: 130 }}>When</th>
                  <th style={{ width: 100 }}>Agent</th>
                  <th style={{ width: 120 }}>Position</th>
                  <th style={{ width: 110 }}>Verdict</th>
                  <th>Intent sequence</th>
                </tr>
              </thead>
              <tbody>
                {actions.map((a) => (
                  <tr key={a.id}>
                    <td className="mono m2" style={{ whiteSpace: 'nowrap' }} title={a.ts}>
                      {utc(a.ts).slice(0, 16)}
                    </td>
                    <td>
                      <AgentCell id={a.agent_id} />
                    </td>
                    <td className="mono">#{a.token_id}</td>
                    <td>
                      <Tag tone={REC_TONE[a.recommendation] ?? 'neutral'}>{a.recommendation}</Tag>
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {(a.detail?.intents ?? []).join(' → ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ----------------------------------------------------------- executions */}
      <div className="sec">
        <h2>Execution record</h2>
        {!executionsR.ok ? (
          <Failed what="The execution record" error={executionsR} />
        ) : executions.length === 0 ? (
          <Empty title="Nothing has been executed">
            Every signed intent and its receipt is recorded here. An empty record means the executor has not been
            asked to act — not that it failed to.
          </Empty>
        ) : (
          <div className="scroll-x">
            <table className="table" style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th style={{ width: 130 }}>When</th>
                  <th style={{ width: 100 }}>Agent</th>
                  <th style={{ width: 90 }}>Position</th>
                  <th style={{ width: 50 }} className="r">
                    Step
                  </th>
                  <th style={{ width: 110 }}>Intent</th>
                  <th style={{ width: 100 }}>Status</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {executions.map((e) => (
                  <tr key={e.id}>
                    <td className="mono m2" style={{ whiteSpace: 'nowrap' }} title={e.ts}>
                      {utc(e.ts).slice(0, 16)}
                    </td>
                    <td>
                      <AgentCell id={e.agent_id} />
                    </td>
                    <td className="mono">#{e.token_id}</td>
                    <td className="r mono m2">{e.step}</td>
                    <td className="mono">{e.intent}</td>
                    <td className={stepTone(e.status)} style={{ fontSize: 11 }}>
                      {e.status}
                      {e.error ? (
                        <div className="m3" style={{ fontSize: 10 }} title={e.error}>
                          {e.error.slice(0, 48)}
                          {e.error.length > 48 ? '…' : ''}
                        </div>
                      ) : null}
                    </td>
                    <td className="mono m2">
                      {e.tx_hash ? (
                        <span title={e.tx_hash}>{txShort(e.tx_hash)}</span>
                      ) : (
                        <span className="m3">not sent</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ----------------------------------------------------------------- opens */}
      <div className="sec">
        <h2>Opens</h2>
        {!opensR.ok ? (
          <Failed what="The position opens" error={opensR} />
        ) : opens.length === 0 ? (
          <Empty title="No position has been opened through the platform">
            Opening is a separate, capped act: the owner funds the agent&rsquo;s wallet and the position is minted
            through the signer, with a ceiling that has to be typed for that open. Every open is recorded here with its
            transaction and token id.
          </Empty>
        ) : (
          <div className="scroll-x">
            <table className="table" style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th style={{ width: 130 }}>When</th>
                  <th style={{ width: 100 }}>Agent</th>
                  <th style={{ width: 110 }}>Symbol</th>
                  <th className="r" style={{ width: 90 }}>
                    Size (USD)
                  </th>
                  <th style={{ width: 100 }}>Token id</th>
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
                    <td>
                      <AgentCell id={o.agent_id} />
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
      </div>

      <Footer stamp={latest ? { label: 'last arbitrage activity', value: utc(latest) } : null} />
    </div>
  );
}
