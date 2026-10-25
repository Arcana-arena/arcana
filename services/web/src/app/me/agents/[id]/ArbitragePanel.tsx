/**
 * One agent's arbitrage — the registry the arbitrage service keeps for it: the
 * positions it owns, the fees recorded against them, and the harvest/open steps
 * the executor has taken. The strategy is liquidity provision, so the rows are
 * LP positions and are named that way.
 *
 * STATE FIRST, THEN THE RECORD. The three facts an owner opens this tab for
 * (how many positions, how many are inside their range, when the last sync
 * happened) are one strip above the tables. The range is drawn, not encoded in
 * ticks, and harvests and opens share one timeline instead of two tables.
 *
 * SERVER-RENDERED AND READ-ONLY, LIKE THE REST OF THE PAGE. Opening, arming and
 * closing are executor acts with their own capped tools; there is deliberately
 * no button here that would imply a browser click can move this agent's funds.
 */
import type { Err } from '@/lib/api';
import { num, utc } from '@/lib/format';
import { Empty, Failed } from '@/components/ds/states';
import { ActivityTable, PositionsTable, type ActivityRow } from '@/components/arbitrage/Positions';
import {
  shortId,
  stepTone,
  tokenIndex,
  type LPOpen,
  type LPPosition,
  type LPStep,
  type LPVenues,
} from '@/lib/lp';

export function ArbitragePanel({
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

  if (positions.length === 0) {
    return (
      <Empty title="This agent holds no arbitrage position">
        The registry has no position for this agent&rsquo;s wallet. A position is opened by its owner through the
        executor&rsquo;s capped open command after funding the wallet, and the platform cannot open one from here.
        <div style={{ marginTop: 10 }}>
          The public registry is at <a href="/arbitrage">/arbitrage</a>.
        </div>
      </Empty>
    );
  }

  const open = positions.filter((p) => p.status === 'open');
  const inRange = open.filter((p) => p.in_range === true).length;
  const syncs = positions.map((p) => p.last_synced_at).filter((x): x is string => Boolean(x)).sort();
  const lastSync = syncs.length > 0 ? syncs[syncs.length - 1] : null;

  const harvests = executions.filter((e) => e.intent === 'lp_collect');
  const events: ActivityRow[] = [
    ...harvests.map((e: LPStep) => ({
      key: `h-${e.id}`,
      ts: e.ts,
      kind: 'HARVEST',
      agentId: e.agent_id,
      position: `#${e.token_id}`,
      detail: e.intent,
      note: e.error ? e.error.slice(0, 90) : undefined,
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

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div className="lp-strip" style={{ marginTop: 0 }} role="group" aria-label="This agent's arbitrage state">
        <div>
          <div className="k">Open positions</div>
          <div className="v">{open.length}</div>
        </div>
        <div>
          <div className="k">In range</div>
          <div className="v">{open.length === 0 ? '—' : `${inRange} of ${open.length}`}</div>
        </div>
        <div>
          <div className="k">Last sync</div>
          <div className="v" style={{ fontSize: 13 }}>
            {lastSync ? utc(lastSync).slice(0, 16) : 'never'}
          </div>
        </div>
      </div>

      <section>
        <div className="k">Positions held</div>
        <PositionsTable positions={positions} token={token} dense />
      </section>

      <section>
        <div className="k">Executor activity</div>
        {executionsError || opensError ? (
          <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
            {executionsError ? <Failed what="This agent's execution record" error={executionsError} /> : null}
            {opensError ? <Failed what="This agent's opens" error={opensError} /> : null}
          </div>
        ) : events.length === 0 ? (
          <p className="m2" style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.5 }}>
            No fee harvest or open is recorded for this agent. Fees stay in the position (the stored figure above)
            until a harvest crosses the reviewed threshold, a rebalance, or a close.
          </p>
        ) : (
          <ActivityTable rows={events} label="This agent's harvests and opens" />
        )}
      </section>

      <div className="m2 mono" style={{ fontSize: 11.5, lineHeight: 1.45 }}>
        Agent {shortId(positions[0].agent_id)} · wallet {positions[0].wallet}
      </div>
    </div>
  );
}
