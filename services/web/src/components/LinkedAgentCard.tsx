/**
 * The agent a thesis was bound to, as it stands right now.
 *
 * EVERY NUMBER HERE IS FETCHED, NOT COMPUTED. The score comes from the
 * leaderboard, the return and drawdown from the agent's own overview window,
 * the holdings from its positions read. This component does no arithmetic at
 * all — not a percentage, not a sum — because a second implementation of any
 * of them would agree with the agent's own page on every day it still agreed,
 * and the two pages sit one click apart.
 *
 * That is also what makes it checkable: infra/verify/thesis-verify.mjs pulls
 * this card's endpoints and the agent page's endpoints and compares them value
 * for value.
 *
 * AN AGENT THAT STOPPED, OR WENT PRIVATE, STILL GETS AN HONEST CARD — this is
 * the part that has to be written down, because the failure it prevents looks
 * like success. A retired agent's overview still answers, with the figures it
 * finished on; rendered with no label they read as a live position, and the
 * longer it has been retired the more confidently wrong the card looks. So a
 * retired or paused agent is labelled as such and its numbers are called final.
 *
 * A PRIVATE AGENT IS NOT RENDERED AS ZEROES. Migration 0047 withholds a private
 * agent's performance, so the endpoints answer with nulls — which `Cell` would
 * draw as em-dashes, a card that looks like an agent that has done nothing.
 * That is a different claim from "this is not published", so the private case
 * returns early and says which one it is.
 */
import Link from 'next/link';
import { agent } from '@/lib/api';
import { int, money, num, score as fmtScore } from '@/lib/format';
import { Tag } from '@/components/ds/primitives';
import { Unavailable } from '@/components/ds/states';

type Overview = {
  agent_id: string;
  season: { id: string; name: string } | null;
  stats: {
    return_pct: { value: number | null; note: string };
    max_drawdown_pct: { value: number | null; note: string; measurable: boolean };
    decisions: number;
    trades: { own: number; protective: number; total: number };
  } | null;
  note?: string;
};

type Positions = {
  agent_id: string;
  visibility: string;
  open?: Array<{ symbol: string; quantity: number; avg_entry: number | null }>;
};

type Board = {
  items: Array<{ agent_id: string; rank: number | null; score: number | null }>;
};

/** Lifecycle states whose figures are a record, not a reading. */
const STOPPED = new Set(['retired', 'paused', 'draft']);

export async function LinkedAgentCard({
  agentId,
  agentName,
  statusNow,
  visibility = null,
}: {
  agentId: string;
  agentName: string;
  statusNow: string | null;
  /**
   * 'private' when the platform withholds this agent's performance (0047).
   * null when the caller does not know, in which case the card asks the
   * endpoints and believes what they say.
   */
  visibility?: 'public' | 'private' | null;
}) {
  // Known private before asking: skip three reads that would answer with
  // withheld nulls anyway.
  if (visibility === 'private') return <PrivateCard agentId={agentId} agentName={agentName} />;

  const stopped = statusNow !== null && STOPPED.has(statusNow);
  const [overR, posR, boardR] = await Promise.all([
    agent<Overview>(`/v1/agents/${agentId}/overview`),
    agent<Positions>(`/v1/agents/${agentId}/positions`),
    agent<Board>('/v1/leaderboard?page_size=100&include_unranked=true'),
  ]);

  // AND THE SAME ANSWER WHEN THE CALLER DID NOT KNOW. A thesis carries no
  // visibility field, so an agent made private after a thesis was bound to it
  // arrives here as 'public' by omission; the endpoints are the authority and
  // they say so. Without this branch that card would render a full row of
  // em-dashes — which reads as an agent that never did anything.
  if (posR.ok && posR.data.visibility === 'private') {
    return <PrivateCard agentId={agentId} agentName={agentName} />;
  }

  const row = boardR.ok ? boardR.data.items.find((i) => i.agent_id === agentId) : undefined;
  const stats = overR.ok ? overR.data.stats : null;
  const open = posR.ok ? (posR.data.open ?? []) : [];

  return (
    <div style={{ border: '1px solid var(--color-divider)', marginTop: 20 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          borderBottom: '1px solid var(--color-divider)',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div className="m3" style={{ fontSize: 10.5, letterSpacing: '0.08em' }}>
            LINKED AGENT
          </div>
          <Link href={`/agents/${agentId}`} style={{ fontSize: 14.5 }}>
            {agentName}
          </Link>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {statusNow ? <Tag tone={statusNow === 'active' ? 'accent' : 'dashed'}>{statusNow}</Tag> : null}
          {row?.rank ? <Tag tone="outline">rank {row.rank}</Tag> : null}
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(128px, 1fr))',
          borderBottom: '1px solid var(--color-divider)',
        }}
      >
        <Cell label="ARCANA Score" value={row ? fmtScore(row.score) : null} />
        <Cell
          label="Return, season"
          value={stats ? num(stats.return_pct.value, 2) : null}
          suffix="%"
          title={stats?.return_pct.note}
        />
        <Cell
          label="Max drawdown"
          value={stats && stats.max_drawdown_pct.measurable ? num(stats.max_drawdown_pct.value, 2) : null}
          suffix="%"
          title={stats?.max_drawdown_pct.note}
        />
        <Cell label="Decisions" value={stats ? int(stats.decisions) : null} />
      </div>

      {stopped ? (
        <div
          className="m2"
          style={{
            fontSize: 11.5,
            padding: '10px 16px',
            borderBottom: '1px solid var(--color-divider)',
            lineHeight: 1.55,
          }}
        >
          This agent is <strong>{statusNow}</strong>. The figures above are where it finished, not
          where it is going — it is not deciding, and nothing here will move again.
        </div>
      ) : null}

      <div style={{ padding: '12px 16px' }}>
        <div className="m3" style={{ fontSize: 10.5, letterSpacing: '0.08em', marginBottom: 6 }}>
          {stopped ? 'POSITIONS STILL HELD' : 'POSITIONS NOW'}
        </div>
        {!posR.ok ? (
          <Unavailable reason={posR.reason} />
        ) : open.length === 0 ? (
          // "Holds nothing" and "we could not find out" are different facts and
          // are never rendered the same way. See src/lib/api.ts.
          <div className="m3" style={{ fontSize: 12 }}>
            {stopped ? 'Holds nothing — it closed out.' : 'Holding nothing right now.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {open.map((p) => (
              <span key={p.symbol} className="mono" style={{ fontSize: 12 }}>
                <Tag tone="outline">
                  {p.symbol} · {num(p.quantity, 6)}
                  {p.avg_entry !== null ? ` @ ${money(p.avg_entry)}` : ''}
                </Tag>
              </span>
            ))}
          </div>
        )}
      </div>

      <div
        className="m3"
        style={{ fontSize: 10.5, padding: '0 16px 12px', lineHeight: 1.5 }}
      >
        {overR.ok && overR.data.season
          ? `Season figures from ${overR.data.season.name}. `
          : ''}
        Read live from the agent&rsquo;s own endpoints — the same numbers its page shows, not a
        second calculation.
      </div>
    </div>
  );
}

function Cell({
  label,
  value,
  suffix = '',
  title,
}: {
  label: string;
  value: string | null;
  suffix?: string;
  title?: string;
}) {
  return (
    <div
      style={{ padding: '10px 16px', borderRight: '1px solid var(--color-divider)' }}
      title={title}
    >
      <div className="m3" style={{ fontSize: 10, letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 15, marginTop: 2 }}>
        {value === null ? <span className="m3">—</span> : `${value}${suffix}`}
      </div>
    </div>
  );
}

/**
 * A private agent, said out loud.
 *
 * WHAT THIS REPLACES is a card whose every cell renders an em-dash, because
 * 0047 withholds a private agent's score, return, drawdown and positions. Four
 * dashes in a row is a perfectly reasonable way to draw an agent that has never
 * traded — which is exactly the wrong thing to tell a reader about an agent
 * that has, and whose owner simply does not publish it.
 */
function PrivateCard({ agentId, agentName }: { agentId: string; agentName: string }) {
  return (
    <div style={{ border: '1px solid var(--color-divider)', marginTop: 20 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          borderBottom: '1px solid var(--color-divider)',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div className="m3" style={{ fontSize: 10.5, letterSpacing: '0.08em' }}>
            LINKED AGENT
          </div>
          <Link href={`/agents/${agentId}`} style={{ fontSize: 14.5 }}>
            {agentName}
          </Link>
        </div>
        <Tag tone="dashed">private</Tag>
      </div>
      <div className="m2" style={{ fontSize: 12, padding: '14px 16px', lineHeight: 1.6 }}>
        This agent&rsquo;s owner has made it private, so ARCANA withholds its score, returns and
        positions &mdash; everywhere, not only here.{' '}
        <span className="m3">
          Nothing is shown rather than zeroes: an agent with no published figures and an agent that
          has done nothing are different facts, and a row of dashes would read as the second.
        </span>
      </div>
    </div>
  );
}
