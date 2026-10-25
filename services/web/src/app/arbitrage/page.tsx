/**
 * Arbitrage, read-only.
 *
 * WHAT THIS PAGE IS: the public view of the registry the arbitrage service
 * keeps — which agent wallets own which Uniswap v3 positions, what the last
 * sync read, and what the executor has done about it. The strategy it runs is
 * liquidity provision, so the rows are LP positions: that is the service's
 * vocabulary and this page does not rename them.
 *
 * WHAT IT SHOWS FIRST: state. Open positions, how many are still inside their
 * range, and the freshest read are one strip above everything. The mechanism
 * (harvest, rebalance, close) is three sentences, not a paragraph, and the
 * documentation link carries the rest.
 *
 * ONE TIMELINE. Proposals, executor steps and opens are the same story told in
 * three tables before; they are merged here, chronologically, with a kind
 * column. A failure in any one source is still reported as a failure rather
 * than as an empty list.
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
import { arbitrage, type Err } from '@/lib/api';
import { int, num, utc } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Empty, Failed } from '@/components/ds/states';
import { ActivityTable, PositionsTable, type ActivityRow } from '@/components/arbitrage/Positions';
import {
  stepTone,
  tokenIndex,
  type LPAction,
  type LPOpen,
  type LPPosition,
  type LPStep,
  type LPVenues,
} from '@/lib/lp';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Arbitrage — ARCANA' };

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

  const open = positions.filter((p) => p.status === 'open');
  const inRange = open.filter((p) => p.in_range === true).length;

  const stamps = [
    ...positions.map((p) => p.last_synced_at),
    ...actions.map((a) => a.ts),
    ...executions.map((e) => e.ts),
    ...opens.map((o) => o.ts),
  ]
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .sort();
  const latest = stamps.length > 0 ? stamps[stamps.length - 1] : null;

  const rows: ActivityRow[] = [
    ...actions.map((a: LPAction) => ({
      key: `a-${a.id}`,
      ts: a.ts,
      kind: 'PROPOSAL',
      agentId: a.agent_id,
      position: `#${a.token_id}`,
      detail: (a.detail?.intents ?? []).join(' → ') || a.recommendation,
      note: a.superseded_at ? `superseded ${utc(a.superseded_at).slice(0, 16)}` : undefined,
      status: a.superseded_at ? 'superseded' : 'standing',
      statusClass: a.superseded_at ? 'm2' : 'am',
    })),
    ...executions.map((e: LPStep) => ({
      key: `e-${e.id}`,
      ts: e.ts,
      kind: 'STEP',
      agentId: e.agent_id,
      position: `#${e.token_id}`,
      detail: e.intent,
      note: e.error ? e.error.slice(0, 90) : e.gas_used ? `gas ${int(Number(e.gas_used))}` : undefined,
      status: e.status,
      statusClass: stepTone(e.status),
      tx: e.tx_hash,
    })),
    ...opens.map((o: LPOpen) => ({
      key: `o-${o.id}`,
      ts: o.ts,
      kind: 'OPEN',
      agentId: o.agent_id,
      position: o.token_id ? `#${o.token_id}` : null,
      detail: o.symbol,
      note: `${num(o.size_usd, 2)} USD`,
      status: o.status,
      statusClass: o.status === 'executed' ? 'up' : 'dn',
      tx: o.tx_hash,
    })),
  ].sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''));

  const activityFailures: { what: string; error: Err }[] = [];
  if (!actionsR.ok) activityFailures.push({ what: 'The proposal queue', error: actionsR });
  if (!executionsR.ok) activityFailures.push({ what: 'The execution record', error: executionsR });
  if (!opensR.ok) activityFailures.push({ what: 'The position opens', error: opensR });

  return (
    <div className="page">
      <Header current="Arbitrage" />

      <div className="sec" style={{ paddingTop: 32, paddingBottom: 16, borderBottom: 'none' }}>
        <h1>Arbitrage</h1>
        <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 4, maxWidth: 760 }}>
          Agent-owned Uniswap v3 positions, read from the chain by the arbitrage service and acted on by the executor.
          No wallet is needed to read this page.
        </div>
        <div className="lp-strip" role="group" aria-label="Registry state">
          <div>
            <div className="k">Registered</div>
            <div className="v">{int(positions.length)}</div>
          </div>
          <div>
            <div className="k">Open</div>
            <div className="v">{int(open.length)}</div>
          </div>
          <div>
            <div className="k">In range</div>
            <div className="v">{open.length === 0 ? '—' : `${int(inRange)} of ${int(open.length)}`}</div>
          </div>
          <div>
            <div className="k">Last activity</div>
            <div className="v" style={{ fontSize: 13 }}>
              {latest ? utc(latest).slice(0, 16) : '—'}
            </div>
          </div>
        </div>
      </div>

      <div className="sec" style={{ paddingTop: 0 }}>
        <div className="lp-steps">
          <div>
            <div className="k">Harvest</div>
            <p>Fees are collected once their exact accrual crosses the reviewed threshold.</p>
          </div>
          <div>
            <div className="k">Rebalance</div>
            <p>A left range is replaced: decrease, collect, burn, then mint the new band.</p>
          </div>
          <div>
            <div className="k">Close</div>
            <p>An emptied position is collected and burned, and its capital returns to the agent&rsquo;s wallet.</p>
          </div>
        </div>
        <div className="m2" style={{ fontSize: 12.5, marginTop: 12, lineHeight: 1.5 }}>
          The loop re-reads every position from the chain every five minutes. The strategy and the reasons for it are
          documented in <Link href="/docs/arbitrage">how arbitrage works</Link>.
        </div>
      </div>

      {/* ------------------------------------------------------------ positions */}
      <div className="sec" style={{ paddingTop: 22 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
          <h2>Positions</h2>
          <span className="mono m2" style={{ fontSize: 12 }}>
            {int(positions.length)} registered · {int(open.length)} open
          </span>
        </div>
        {!positionsR.ok ? (
          <Failed what="The arbitrage registry" error={positionsR} />
        ) : positions.length === 0 ? (
          <Empty title="No arbitrage position is registered yet">
            The registry discovers positions from the chain, so nothing can appear here until an agent&rsquo;s wallet
            owns one. The first position is opened by its owner through the executor&rsquo;s open command, with a cap
            that has to be typed.
          </Empty>
        ) : (
          <PositionsTable positions={positions} token={token} showAgent />
        )}
      </div>

      {/* ------------------------------------------------------------- activity */}
      <div className="sec" style={{ paddingTop: 22 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
          <h2>Activity</h2>
          <span className="mono m2" style={{ fontSize: 12 }}>
            {int(rows.length)} events · proposals, executor steps, opens
          </span>
        </div>
        {activityFailures.length > 0 ? (
          <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
            {activityFailures.map((f) => (
              <Failed key={f.what} what={f.what} error={f.error} />
            ))}
          </div>
        ) : null}
        {rows.length === 0 ? (
          activityFailures.length === 0 ? (
            <Empty title="Nothing has been proposed or executed yet">
              Events appear here when the loop proposes an action for a position, when the executor signs a step, or
              when an owner opens a position through the platform.
            </Empty>
          ) : null
        ) : (
          <ActivityTable rows={rows} label="Proposals, executor steps and opens" />
        )}
      </div>

      <Footer stamp={latest ? { label: 'last arbitrage activity', value: utc(latest) } : null} />
    </div>
  );
}
