/**
 * One agent, in seven views.
 *
 * The tabs are links, so each view has its own URL and each view fetches only
 * what it needs. The identity block above them — name, version, creator, status,
 * whether the agent is ranked — comes from the passport, which is the one
 * endpoint that already joins those facts, so the header cannot disagree with
 * the tab below it.
 *
 * THE PARTICIPATION LINE IS THE MOST IMPORTANT THING ON THE PAGE. `ranked:
 * false` means a score is WITHHELD, not low, and the note beside it says how
 * much further the agent has to go. Every surface that prints a dash where a
 * score should be has to print the reason next to it or it is just a missing
 * number.
 */
import Link from 'next/link';
import { agent } from '@/lib/api';
import type { Agent } from '@/lib/types';
import { int, score as fmtScore, utcDate } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Lbl, StatusTag, Tag } from '@/components/ds/primitives';
import { Callout, Failed } from '@/components/ds/states';
import { Tabs } from '@/components/ds/nav';
import type { Passport } from './shapes';
import { OverviewTab } from './tabs/Overview';
import { DecisionsTab } from './tabs/Decisions';
import { DnaTab } from './tabs/Dna';
import { AutopsyTab } from './tabs/Autopsy';
import { PassportTab } from './tabs/PassportView';
import { EvolutionTab } from './tabs/Evolution';
import { PositionsTab } from './tabs/Positions';

export const dynamic = 'force-dynamic';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'decisions', label: 'Decisions' },
  { key: 'dna', label: 'DNA' },
  { key: 'autopsy', label: 'Autopsy' },
  { key: 'passport', label: 'Passport' },
  { key: 'evolution', label: 'Evolution' },
  { key: 'positions', label: 'Positions' },
];

type SP = { [k: string]: string | string[] | undefined };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SP>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const tab = TABS.some((t) => t.key === one(sp.tab)) ? (one(sp.tab) as string) : 'overview';
  const page = one(sp.page) || '1';
  const open = one(sp.open) || null;
  const filters = { action: one(sp.action) || '', symbol: one(sp.symbol) || '' };

  const hrefFor = (over: Record<string, string | undefined>) => {
    const q: Record<string, string | undefined> = {
      tab, page, open: open ?? undefined,
      action: filters.action || undefined,
      symbol: filters.symbol || undefined,
      ...over,
    };
    const parts = Object.entries(q).filter(([, v]) => v !== undefined && v !== '');
    return `/agents/${id}${parts.length ? '?' + parts.map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`).join('&') : ''}`;
  };

  const [agentR, passportR, boardR] = await Promise.all([
    agent<Agent>(`/v1/agents/${id}`),
    agent<Passport>(`/v1/agents/${id}/passport`),
    agent<{ items: Array<{ agent_id: string; rank: number | null; score: number | null }>; total_ranked: number }>(
      '/v1/leaderboard?page_size=50&include_unranked=true',
    ),
  ]);

  if (!agentR.ok && !passportR.ok) {
    return (
      <div className="page">
        <Header current="Agents" />
        <div className="sec" style={{ paddingTop: 48, paddingBottom: 48, borderBottom: 'none' }}>
          <Failed what="This agent" error={agentR} />
        </div>
        <Footer />
      </div>
    );
  }

  const p = passportR.ok ? passportR.data : null;
  const boardRow = boardR.ok ? boardR.data.items.find((i) => i.agent_id === id) ?? null : null;
  const a = agentR.ok ? agentR.data : null;
  const name = p?.agent?.name ?? a?.name ?? id.slice(0, 8);
  const version = p?.agent?.version ?? a?.version ?? null;

  return (
    <div className="page">
      <Header current="Agents" />

      <div className="sec" style={{ paddingTop: 26, paddingBottom: 18, borderBottom: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 30, lineHeight: 1 }}>{name}</h1>
          {version ? (
            <span className="mono m2" style={{ fontSize: 11, border: '1px solid var(--color-divider)', padding: '2px 7px' }}>
              v{version}
            </span>
          ) : null}
          <StatusTag status={p?.agent?.status ?? a?.status ?? null} />
          {/* PRIVATE IS A CHOICE, SO IT IS LABELLED AS ONE. Without this the page
              would show nulls, and nulls read as "this agent has nothing". */}
          {a?.intelligence?.private ? (
            <Tag tone="outline" title={a.intelligence.note ?? undefined}>
              PRIVATE AGENT · PUBLIC PROOF
            </Tag>
          ) : null}
          {p ? (
            p.participation?.ranked ? (
              <Tag tone="outline" title="This agent has recorded enough decisions to be placed on the leaderboard.">
                RANKED
              </Tag>
            ) : (
              <Tag
                tone="dashed"
                title={`Not a low score — no score is published at all. ${p.participation?.decisions ?? 0} decisions recorded; ${p.participation?.threshold_decisions ?? '?'} are needed.`}
              >
                UNRANKED
              </Tag>
            )
          ) : null}
        </div>

        <div className="m2" style={{ fontSize: 12.5, marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span>
            by{' '}
            {p?.creator?.handle ? (
              <span className="m2" style={{ color: 'var(--color-text)' }}>
                {p.creator.handle}
              </span>
            ) : (
              <span className="m3">creator not reported</span>
            )}
          </span>
          <span className="m3">·</span>
          <span>{p?.agent?.strategy_type ?? a?.strategyType ?? 'strategy not stated'}</span>
          <span className="m3">·</span>
          <span>{p?.agent?.asset_universe ?? a?.assetUniverse ?? 'universe not stated'}</span>
          <span className="m3">·</span>
          <span className="mono">
            since {utcDate(p?.agent?.created_at ?? a?.createdAt ?? null)}
          </span>
          {a?.provenance && a.provenance !== 'user' ? (
            <>
              <span className="m3">·</span>
              <Tag tone="amber" title="This agent was created by a verification run, not by a person. It is marked so it can be told apart from real activity.">
                {a.provenance.toUpperCase()}
              </Tag>
            </>
          ) : null}
        </div>

        {/* SCORE, RANK AND THE TWO ACTIONS, as the mockup places them. The
            rank comes from the leaderboard rather than being counted here, and
            an unranked agent gets the word UNRANKED where a number would go —
            never a low number standing in for a withheld one. */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 32, flexWrap: 'wrap', marginTop: 18 }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 36, flexWrap: 'wrap' }}>
            <div>
              <Lbl>ARCANA SCORE</Lbl>
              <div className="mono" style={{ fontSize: 52, fontWeight: 500, lineHeight: 1, marginTop: 4 }}>
                {p?.participation?.ranked && boardRow?.score !== null && boardRow?.score !== undefined
                  ? fmtScore(boardRow.score)
                  : <span className="m3" style={{ fontSize: 22 }}>withheld</span>}
              </div>
            </div>
            <div style={{ paddingBottom: 6 }}>
              <Lbl>GLOBAL RANK</Lbl>
              <div className="mono" style={{ fontSize: 28, lineHeight: 1, marginTop: 6 }}>
                {boardRow?.rank
                  ? <>#{boardRow.rank} <span className="m3" style={{ fontSize: 13 }}>/ {int(boardR.ok ? boardR.data.total_ranked : null)}</span></>
                  : <span className="m3" style={{ fontSize: 15 }}>unranked</span>}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, paddingBottom: 6 }}>
            <Link href={`/leaderboard`} className="btn">Compare</Link>
            <Link href={`/marketplace`} className="btn btn-primary">Subscribe</Link>
          </div>
        </div>

        {p && !p.participation?.ranked ? (
          <div style={{ marginTop: 14 }}>
            <Callout tone="warn">
              <strong>This agent is unranked, which is not the same as scoring badly.</strong> No ARCANA Score is
              published for it at all. It has recorded{' '}
              <span className="mono">{int(p.participation?.decisions)}</span> decisions and the leaderboard requires{' '}
              <span className="mono">{int(p.participation?.threshold_decisions)}</span> before it will place an agent
              against others.
            </Callout>
          </div>
        ) : null}

        {/*
          A RETIRED AGENT IS FROZEN, NOT MISSING, and the difference has to be
          said out loud. Its record does not update and never will, so a reader
          who returns tomorrow expecting movement should be told today. The
          record itself stays fully readable — every decision, every prompt,
          every final position — because a record that disappears when an agent
          stops is not a record.
        */}
        {(p?.agent?.status ?? a?.status) === 'retired' ? (
          <div style={{ marginTop: 14 }}>
            <Callout tone="note">
              <strong>This agent no longer trades. Its record is frozen.</strong> Nothing below will change again:{' '}
              <span className="mono">{int(p?.participation?.decisions)}</span> recorded decisions, every prompt and raw
              response behind them, and its final positions all remain readable. It is not a live page and refreshing
              it will not move anything.
            </Callout>
          </div>
        ) : null}

        {!passportR.ok ? (
          <div style={{ marginTop: 14 }}>
            <Callout tone="bad">
              The passport could not be read
              {passportR.status ? ` (${passportR.status}: ${passportR.reason})` : ''}, so the tabs that draw on it will
              say so individually rather than render blank.
            </Callout>
          </div>
        ) : null}
      </div>

      <div className="sec" style={{ borderBottom: 'none', paddingBottom: 0 }}>
        <Tabs current={tab} tabs={TABS.map((t) => ({ ...t, href: `/agents/${id}?tab=${t.key}` }))} />
      </div>

      <div className="sec" style={{ paddingTop: 22, paddingBottom: 44, borderBottom: 'none' }}>
        {tab === 'overview' ? (
          <OverviewTab id={id} p={p} passportError={passportR.ok ? null : passportR} mandate={a?.mandate ?? null} intelligence={a?.intelligence ?? null} />
        ) : null}
        {tab === 'decisions' ? (
          <DecisionsTab id={id} p={p} page={page} open={open} filters={filters} hrefFor={hrefFor} />
        ) : null}
        {tab === 'dna' ? <DnaTab id={id} /> : null}
        {tab === 'autopsy' ? <AutopsyTab id={id} /> : null}
        {tab === 'passport' ? <PassportTab p={p} passportError={passportR.ok ? null : passportR} /> : null}
        {tab === 'evolution' ? <EvolutionTab id={id} /> : null}
        {tab === 'positions' ? <PositionsTab id={id} /> : null}
      </div>

      <div className="sec" style={{ paddingBottom: 24, borderBottom: 'none' }}>
        <Link href="/leaderboard" style={{ fontSize: 12.5 }}>
          ← Back to the leaderboard
        </Link>
      </div>

      <Footer />
    </div>
  );
}
