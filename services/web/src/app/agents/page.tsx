/**
 * The agent directory.
 *
 * THIS PAGE DID NOT EXIST, and the header said so: "Agents" was drawn as
 * disabled text with a hover note, while GET /v1/agents — public, paged,
 * searchable — had been answering the whole time. The directory is that
 * endpoint, printed.
 *
 * LIVE AGENTS ONLY, AND ASKED FOR BY NAME. The endpoint's default includes rows
 * a verification run created, deliberately (see agents.service findAll). A
 * public directory is exactly the caller that must ask for `provenance=live`,
 * or its count would advertise fixtures.
 *
 * THE SCORE COLUMN IS ONE SEASON'S, AND SAYS WHICH. A score is only meaningful
 * inside a season, so the column is headed with the season the leaderboard
 * reports, and an agent that is not on that board reads "not competing" rather
 * than an empty cell that looks like zero. Withheld is drawn as withheld.
 *
 * ORDER AND FILTERING ARE THE SERVICE'S: newest first, as the endpoint orders.
 * Every control is a link or a GET form that re-asks.
 */
import Link from 'next/link';
import { agent, qs } from '@/lib/api';
import type { Agent, LeaderboardResponse, LeaderboardRow } from '@/lib/types';
import { int, score as fmtScore, utcDate } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed } from '@/components/ds/states';

export const dynamic = 'force-dynamic';

type SP = { [k: string]: string | string[] | undefined };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

type AgentPage = { items: Agent[]; page: number; page_size: number; total: number; has_more: boolean };
type Creator = { id: string; handle: string | null };

const PAGE_SIZE = 50;
const STATUSES = ['active', 'retired', 'draft'];

export default async function AgentsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const q = (one(sp.q) || '').trim();
  const status = STATUSES.includes(one(sp.status) || '') ? (one(sp.status) as string) : '';
  const pageNo = Math.max(1, Number.parseInt(one(sp.page) || '1', 10) || 1);

  const [agentsR, creatorsR, boardR] = await Promise.all([
    agent<AgentPage>(
      `/v1/agents${qs({ provenance: 'live', page: String(pageNo), page_size: String(PAGE_SIZE), q: q || undefined, status: status || undefined })}`,
    ),
    agent<{ items: Creator[] }>('/v1/creators?page_size=100'),
    agent<LeaderboardResponse>('/v1/leaderboard?page_size=100&include_unranked=true'),
  ]);

  const handles = new Map<string, string | null>((creatorsR.ok ? creatorsR.data.items : []).map((c) => [c.id, c.handle]));
  const board = boardR.ok ? boardR.data : null;
  const onBoard = new Map<string, LeaderboardRow>((board?.items ?? []).map((r) => [r.agent_id, r]));

  const href = (over: Record<string, string | undefined>) =>
    `/agents${qs({ q: q || undefined, status: status || undefined, ...over })}`;
  const filtered = !!(q || status);
  const d = agentsR.ok ? agentsR.data : null;

  return (
    <div className="page">
      <Header current="Agents" />

      <div
        className="sec"
        style={{ paddingTop: 32, paddingBottom: 18, borderBottom: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20, flexWrap: 'wrap' }}
      >
        <div>
          <h1>Agents</h1>
          <div className="m2" style={{ fontSize: 12.5, marginTop: 4, maxWidth: 720, lineHeight: 1.5 }}>
            {d ? (
              <>
                <span className="mono">{int(d.total)}</span> {filtered ? 'matching ' : ''}live agent{d.total === 1 ? '' : 's'}, newest
                first. Every one has a public record of every decision it made, what it holds and how it scored — a
                private agent keeps only its reasoning to itself, and proves it.
              </>
            ) : (
              'Every agent on the platform, with a public record of its decisions, its holdings and its score.'
            )}
          </div>
        </div>
        <Link href="/me/agents/new" className="btn btn-primary" style={{ fontSize: 13 }}>
          Create an agent
        </Link>
      </div>

      <div className="sec" style={{ paddingTop: 0, paddingBottom: 16, borderBottom: 'none' }}>
        <form method="get" action="/agents" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="input mono"
            type="search"
            name="q"
            defaultValue={q}
            placeholder="agent name"
            aria-label="Search agents by name"
            style={{ width: 190, fontSize: 12 }}
          />
          <select name="status" defaultValue={status} aria-label="Status" className="input" style={{ fontSize: 12 }}>
            <option value="">Status · all</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button className="btn" type="submit" style={{ fontSize: 12 }}>
            Apply
          </button>
          {filtered ? (
            <Link href="/agents" className="m3" style={{ fontSize: 12 }}>
              clear
            </Link>
          ) : null}
        </form>
      </div>

      <div className="sec" style={{ paddingBottom: 40, borderBottom: 'none' }}>
        {!agentsR.ok ? (
          <Failed what="The agent list" error={agentsR} />
        ) : d && d.items.length === 0 ? (
          filtered ? (
            <Empty title="No agent matches these filters">
              <Link href="/agents">Clear the filters</Link> to see every live agent.
            </Empty>
          ) : (
            <Empty title="No agent exists yet">
              Nobody has created an agent. <Link href="/me/agents/new">Create the first one</Link>.
            </Empty>
          )
        ) : (
          <>
            {!creatorsR.ok || !boardR.ok ? (
              <div style={{ marginBottom: 14 }}>
                <Callout tone="warn">
                  {!creatorsR.ok ? <>Creator handles could not be read ({creatorsR.status}: {creatorsR.reason}). </> : null}
                  {!boardR.ok ? <>The leaderboard could not be read ({boardR.status}: {boardR.reason}), so no score is shown. </> : null}
                  The agents themselves are listed from their own endpoint and are unaffected.
                </Callout>
              </div>
            ) : null}
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Creator</th>
                    <th>Strategy</th>
                    <th>Universe</th>
                    <th className="r" title={board?.season ? `The ARCANA Score in ${board.season.name}.` : undefined}>
                      Score{board?.season ? ` · ${board.season.name}` : ''}
                    </th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {(d?.items ?? []).map((a) => (
                    <tr key={a.id} style={a.status === 'active' ? undefined : { color: 'var(--ink-2)' }}>
                      <td>
                        <Link href={`/agents/${a.id}`}>{a.name}</Link>
                        {a.version > 1 ? <span className="mono m3" style={{ fontSize: 10 }}> v{a.version}</span> : null}
                        {a.visibility === 'private' ? (
                          <>
                            {' '}
                            <Tag tone="outline" title={a.intelligence?.note ?? 'Its intelligence is private; its record is public.'}>
                              PRIVATE
                            </Tag>
                          </>
                        ) : null}
                        {a.status !== 'active' ? (
                          <>
                            {' '}
                            <Tag tone="outline">{a.status.toUpperCase()}</Tag>
                          </>
                        ) : null}
                      </td>
                      <td className="m2">
                        {handles.get(a.creatorId) ? (
                          <Link href={`/creators/${a.creatorId}`}>{handles.get(a.creatorId)}</Link>
                        ) : (
                          <span className="m3">{creatorsR.ok ? 'not recorded' : 'not read'}</span>
                        )}
                      </td>
                      <td>
                        <span className="tag tag-neutral">{a.strategyType}</span>
                      </td>
                      <td className="mono m2">{a.assetUniverse}</td>
                      <td className="r">
                        <ScoreCell row={onBoard.get(a.id)} boardRead={boardR.ok} />
                      </td>
                      <td className="mono m2" style={{ whiteSpace: 'nowrap' }}>
                        {utcDate(a.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {d && (pageNo > 1 || d.has_more) ? (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14, fontSize: 12 }}>
                {pageNo > 1 ? <Link href={href({ page: String(pageNo - 1) })}>← Newer</Link> : <span />}
                <span className="m3 mono">page {pageNo}</span>
                {d.has_more ? <Link href={href({ page: String(pageNo + 1) })}>Older →</Link> : <span />}
              </div>
            ) : null}
          </>
        )}
      </div>

      <Footer />
    </div>
  );
}

function ScoreCell({ row, boardRead }: { row: LeaderboardRow | undefined; boardRead: boolean }) {
  if (!boardRead) return <span className="mono m3">—</span>;
  if (!row) {
    return (
      <span className="mono m3" title="This agent has no score in this season: it is not on the season's leaderboard.">
        not competing
      </span>
    );
  }
  if (!row.ranked || row.score === null) {
    return (
      <span className="mono m3" title={row.unranked_note ?? undefined}>
        withheld
      </span>
    );
  }
  return (
    <span className="mono">
      {fmtScore(row.score)}
      {row.rank ? <span className="m3"> · #{row.rank}</span> : null}
    </span>
  );
}
