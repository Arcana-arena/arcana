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
import { int, utcDate } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { StatusTag, Tag } from '@/components/ds/primitives';
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

  const [agentR, passportR] = await Promise.all([
    agent<Agent>(`/v1/agents/${id}`),
    agent<Passport>(`/v1/agents/${id}/passport`),
  ]);

  if (!agentR.ok && !passportR.ok) {
    return (
      <div className="page">
        <Header />
        <div className="sec" style={{ padding: '48px 32px', borderBottom: 'none' }}>
          <Failed what="This agent" error={agentR} />
        </div>
        <Footer />
      </div>
    );
  }

  const p = passportR.ok ? passportR.data : null;
  const a = agentR.ok ? agentR.data : null;
  const name = p?.agent?.name ?? a?.name ?? id.slice(0, 8);
  const version = p?.agent?.version ?? a?.version ?? null;

  return (
    <div className="page">
      <Header />

      <div className="sec" style={{ paddingTop: 26, paddingBottom: 18, borderBottom: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 30, lineHeight: 1 }}>{name}</h1>
          {version ? (
            <span className="mono m2" style={{ fontSize: 11, border: '1px solid var(--color-divider)', padding: '2px 7px' }}>
              v{version}
            </span>
          ) : null}
          <StatusTag status={p?.agent?.status ?? a?.status ?? null} />
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
        {tab === 'overview' ? <OverviewTab id={id} p={p} passportError={passportR.ok ? null : passportR} /> : null}
        {tab === 'decisions' ? <DecisionsTab id={id} p={p} page={page} /> : null}
        {tab === 'dna' ? <DnaTab id={id} /> : null}
        {tab === 'autopsy' ? <AutopsyTab id={id} /> : null}
        {tab === 'passport' ? <PassportTab p={p} passportError={passportR.ok ? null : passportR} /> : null}
        {tab === 'evolution' ? <EvolutionTab id={id} /> : null}
        {tab === 'positions' ? <PositionsTab id={id} p={p} passportError={passportR.ok ? null : passportR} /> : null}
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
