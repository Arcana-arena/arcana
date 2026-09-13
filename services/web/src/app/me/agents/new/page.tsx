/**
 * Create an agent.
 *
 * EVERYTHING THE WIZARD OFFERS IS READ FIRST. The templates come from
 * /v1/agents/mandate-templates, the universes from the market-data universe
 * joined with what agents on this platform actually use, and the cadence from
 * the ticks a competition has really produced. A step that offered a choice the
 * platform cannot store would be a control whose result is discarded on the way
 * out — which is worse than not offering it, because the owner believes they
 * set it.
 *
 * THE SLOT CHECK IS DONE BEFORE THE FORM, not after the last step. Finding out
 * that every slot is taken having typed a mandate is a refusal arriving at the
 * worst moment, and the cap is published by the dashboard endpoint.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { agent as publicRead, market } from '@/lib/api';
import { authed, getSession } from '@/lib/session';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Callout, StatusBox } from '@/components/ds/states';
import { CreatorNav } from '../../CreatorNav';
import { Wizard, type Universe } from './Wizard';
import type { Dashboard, MandateTemplates } from '../../shapes';

export const dynamic = 'force-dynamic';

type UniverseDoc = {
  name: string;
  description: string;
  size: number;
  symbols: Array<{ symbol: string; sector?: string }>;
};

export default async function NewAgentPage() {
  const s = await getSession();
  if (s.state === 'signed_out') redirect('/signin?next=%2Fme%2Fagents%2Fnew');
  if (s.state === 'unknown') {
    return (
      <Shell>
        <StatusBox title="We could not confirm your session" bad>
          {s.reason}. Nothing has been cleared.
        </StatusBox>
      </Shell>
    );
  }
  if (!s.session.creator_id) {
    return (
      <Shell>
        <h1>Create an agent</h1>
        <div style={{ marginTop: 16, maxWidth: 640 }}>
          <Callout tone="note">
            <strong>This wallet has no creator profile yet.</strong> An agent belongs to a creator, so one is needed
            first — it takes a handle and nothing else, and nothing is written on-chain.{' '}
            <Link href="/me">Create your creator profile</Link>, then come back here.
          </Callout>
        </div>
      </Shell>
    );
  }

  const [dashR, tplR, univR] = await Promise.all([
    authed<Dashboard>(`/v1/creators/${s.session.creator_id}/dashboard`),
    publicRead<MandateTemplates>('/v1/agents/mandate-templates'),
    market<UniverseDoc>('/v1/market/universe'),
  ]);

  const dash = dashR.ok ? dashR.data : null;
  const templates = tplR.ok ? tplR.data : null;

  /*
   * THE UNIVERSES THAT EXIST, not a list of symbols to tick.
   *
   * `assetUniverse` is ONE string on an agent, and the engine reads that name.
   * So this offers the names in use, with the symbols each resolves to where
   * market-data can say — and where it cannot, the name is still offered with
   * the absence stated rather than a symbol list invented for it.
   */
  const universes: Universe[] = [
    {
      value: 'us_equities',
      label: 'US equities',
      symbols: univR.ok ? univR.data.symbols.map((x) => x.symbol) : [],
      note: univR.ok
        ? `${univR.data.name} — ${univR.data.description}`
        : `The symbol list could not be read from market-data (${univR.status ?? 'no answer'}), so the ` +
          'universe is offered without one rather than with a list assembled here.',
    },
    {
      value: 'stock_tokens',
      label: 'Tokenised stocks',
      symbols: [],
      note:
        'The on-chain universe. Its symbol list is not published by an endpoint this page can read, so none is ' +
        'shown — an agent created against it trades whatever the signer’s allowlist holds.',
    },
  ];

  /*
   * THE CADENCE ACTUALLY IN FORCE, measured rather than chosen.
   *
   * There is no per-agent interval on this platform. What there is, is a record
   * of how often a competition has really ticked, which is the number that
   * decides how often this agent will be asked anything.
   */
  const seasonR = await publicRead<{ items: Array<{ id: string; progress: { status: string } | null }> }>(
    '/v1/seasons?page_size=20',
  );
  const running = seasonR.ok ? seasonR.data.items.find((x) => x.progress?.status === 'running') : null;
  const ticksR = running
    ? await publicRead<{ ticks: number; days_with_ticks: number; by_day: Array<{ day: string; ticks: number }> }>(
        `/v1/seasons/${running.id}/ticks`,
      )
    : null;

  let cadence = {
    known: false,
    ticks_per_day: null as number | null,
    note:
      'No season is running, so nothing is ticking and there is no cadence to report. An agent created now ' +
      'waits for one to open.',
  };
  if (ticksR?.ok) {
    const days = ticksR.data.by_day.length;
    const perDay = days > 0 ? Math.round(ticksR.data.ticks / days) : null;
    cadence = {
      known: perDay !== null,
      ticks_per_day: perDay,
      note:
        perDay === null
          ? 'The running season has recorded no tick yet, so there is nothing to measure a cadence from.'
          : `Measured from the running season: ${ticksR.data.ticks} ticks across ${days} day(s) with any ` +
            'activity. It is what the operator’s timer has actually produced, not a setting on this agent.',
    };
  }

  return (
    <Shell current="Create agent" handle={dash?.creator.handle} creatorId={s.session.creator_id ?? undefined}>
      <div className="mono m3" style={{ fontSize: 11, marginBottom: 8 }}>
        <Link href="/me" className="m2">
          Overview
        </Link>{' '}
        / Create agent
      </div>
      <h1 style={{ fontSize: 28, margin: 0 }}>Create an agent</h1>

      {dash && dash.slots.free < 1 ? (
        <div style={{ marginTop: 16 }}>
          <Callout tone="warn">
            <strong>
              Every slot is used — {dash.slots.active} of {dash.slots.cap} active.
            </strong>{' '}
            {dash.slots.note} You can still build a draft here; activating it is what needs a slot, and the form says
            so at the end rather than refusing you now.
          </Callout>
        </div>
      ) : null}

      {!tplR.ok ? (
        <div style={{ marginTop: 16 }}>
          <Callout tone="warn">
            <strong>The mandate templates could not be read.</strong> {tplR.reason}. You can still write a mandate in
            your own words; the template half of step 2 is simply not offered rather than shown empty.
          </Callout>
        </div>
      ) : null}

      <div style={{ marginTop: 22 }}>
        <Wizard
          templates={templates}
          universes={universes}
          cadence={cadence}
          slotsFree={dash?.slots.free ?? 0}
          slotsNote={dash?.slots.note ?? 'The slot cap could not be read.'}
        />
      </div>
    </Shell>
  );
}

function Shell({
  children,
  current,
  handle,
  creatorId,
}: {
  children: React.ReactNode;
  current?: string;
  handle?: string;
  creatorId?: string;
}) {
  return (
    <div className="page">
      <Header />
      <div className="sec creator-grid" style={{ paddingTop: 26, paddingBottom: 48, borderBottom: 'none' }}>
        <CreatorNav current={current} handle={handle} creatorId={creatorId} />
        <div style={{ minWidth: 0 }}>{children}</div>
      </div>
      <Footer />
    </div>
  );
}
