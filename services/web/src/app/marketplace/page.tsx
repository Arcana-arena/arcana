/**
 * Marketplace discovery.
 *
 * THE ORDER IS THE SERVICE'S. `GET /v1/marketplace/agents?sort=` orders in SQL —
 * by latest ARCANA score, or by price — and this page prints the array as it
 * arrives. The sort control is a set of links that re-ask; there is no
 * comparator anywhere in this file.
 *
 * THE EMPTY CASE IS THE INTERESTING ONE HERE, and it is why this page reads two
 * endpoints instead of one. Discovery returns only ACTIVE listings. An empty
 * grid therefore has at least two meanings — nobody has listed an agent, or
 * listings exist and none of them are switched on — and those are completely
 * different facts about the marketplace. So the page also reads the full
 * listing set and, when discovery is empty, says which of the two it is.
 *
 * WHAT THE MOCKUP HAS THAT THE DATA DOES NOT: return, max drawdown, a
 * sparkline, and a subscriber count per card. None of those are in the
 * discovery row — it carries id, agent, universe, access type, price, the
 * $ARCA gate and the latest score. The card shows what it has and names what it
 * does not, rather than reaching for four more reads per tile or printing
 * numbers nobody measured.
 */
import Link from 'next/link';
import { agent, marketplace, qs } from '@/lib/api';
import { int, money, score as fmtScore } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Lbl, Num, Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed } from '@/components/ds/states';
import { Seg } from '@/components/ds/nav';

export const dynamic = 'force-dynamic';

type DiscoverRow = {
  id: string;
  agent_id: string;
  agent_name: string | null;
  universe: string | null;
  access_type: string | null;
  price_usd: string | number | null;
  arca_gate_amount: string | number | null;
  arcana_score: string | number | null;
};

type RawListing = {
  id: string;
  agentId: string;
  accessType: string;
  priceUsd: string | null;
  arcaGateAmount: string | null;
  revenueShareCreator: string | null;
  active: boolean;
};

const asNum = (v: string | number | null | undefined) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

type SP = { [k: string]: string | string[] | undefined };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const SORTS = [
  { key: 'score_desc', label: 'Score', about: 'Latest ARCANA score, highest first — ordered by the database.' },
  { key: 'price_asc', label: 'Cheapest', about: 'Listing price, lowest first — ordered by the database.' },
];

export default async function MarketplacePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const sort = one(sp.sort) === 'price_asc' ? 'price_asc' : 'score_desc';
  const universe = one(sp.universe) || '';

  const [discoverR, listingsR, agentsR] = await Promise.all([
    marketplace<DiscoverRow[]>(`/v1/marketplace/agents${qs({ sort, universe: universe || undefined })}`),
    marketplace<RawListing[]>('/v1/marketplace/listings'),
    agent<{ total?: number }>('/v1/agents?page_size=1'),
  ]);

  const href = (over: Record<string, string | undefined>) =>
    `/marketplace${qs({ sort, universe: universe || undefined, ...over })}`;

  const rows = discoverR.ok ? discoverR.data : [];
  const allListings = listingsR.ok ? listingsR.data : [];
  const inactive = allListings.filter((l) => !l.active);

  return (
    <div className="page">
      <Header current="Marketplace" />

      <div
        className="sec"
        style={{ paddingTop: 32, paddingBottom: 20, borderBottom: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20, flexWrap: 'wrap' }}
      >
        <div>
          <h1>Marketplace</h1>
          <div className="m2" style={{ fontSize: 12.5, marginTop: 4, maxWidth: 700, lineHeight: 1.5 }}>
            {discoverR.ok ? (
              <>
                <span className="mono">{int(rows.length)}</span> agent{rows.length === 1 ? '' : 's'} open to
                subscribers. A subscribed agent trades in your own wallet, under your own protection levels.
              </>
            ) : (
              'A subscribed agent trades in your own wallet, under your own protection levels.'
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12 }}>
          <span className="m3">Sort</span>
          <Seg current={sort} tabs={SORTS.map((s) => ({ ...s, href: href({ sort: s.key }) }))} />
        </div>
      </div>

      <div className="sec" style={{ paddingBottom: 40, borderBottom: 'none' }}>
        {!discoverR.ok ? (
          <Failed what="The marketplace" error={discoverR} />
        ) : rows.length === 0 ? (
          <Empty title="No agent is currently open to subscribers">
            {!listingsR.ok ? (
              <>
                Discovery returned nothing. The full listing table could not be read
                {listingsR.status ? ` (${listingsR.status}: ${listingsR.reason})` : ''}, so this page cannot tell you
                whether that is because no agent has ever been listed or because every listing is switched off.
              </>
            ) : allListings.length === 0 ? (
              <>
                No agent has ever been listed
                {agentsR.ok && typeof agentsR.data.total === 'number' ? (
                  <>
                    {' '}
                    — the platform holds <span className="mono">{int(agentsR.data.total)}</span> agents, and none of
                    their creators has put one up for subscription
                  </>
                ) : null}
                .
              </>
            ) : (
              <>
                <span className="mono">{int(allListings.length)}</span> listing
                {allListings.length === 1 ? '' : 's'} exist
                {allListings.length === 1 ? 's' : ''}, and <span className="mono">{int(inactive.length)}</span> of them{' '}
                {inactive.length === 1 ? 'is' : 'are'} not active. Discovery only shows active listings, so this grid
                is empty because the listings are switched off — not because nobody has listed an agent.
              </>
            )}
          </Empty>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: 24,
            }}
          >
            {rows.map((r) => (
              <ListingCard key={r.id} r={r} />
            ))}
          </div>
        )}

        <div style={{ marginTop: 20, display: 'grid', gap: 12 }}>
          <Callout tone="note">
            <strong>Four things on the mockup card are not in the data.</strong> Return, max drawdown, the 30-day
            sparkline and the subscriber count are not part of a discovery row. They live on each agent&rsquo;s own
            page, where they are read from that agent&rsquo;s record.
          </Callout>
          {listingsR.ok && rows.length > 0 && inactive.length > 0 ? (
            <Callout tone="note">
              <span className="mono">{int(inactive.length)}</span> further listing
              {inactive.length === 1 ? ' is' : 's are'} inactive and therefore not shown here.
            </Callout>
          ) : null}
        </div>
      </div>

      <Footer note="price, gate and score are the values the listing carries; the order is the database's" />
    </div>
  );
}

function ListingCard({ r }: { r: DiscoverRow }) {
  const price = asNum(r.price_usd);
  const gate = asNum(r.arca_gate_amount);
  const sc = asNum(r.arcana_score);
  return (
    <article className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 18, lineHeight: 1.1 }}>
            <Link href={`/agents/${r.agent_id}`}>{r.agent_name ?? r.agent_id.slice(0, 8)}</Link>
          </div>
          <div className="m2" style={{ fontSize: 11.5 }}>
            {r.universe ?? 'universe not stated'}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          {sc === null ? (
            <>
              <div className="mono m3" style={{ fontSize: 13, lineHeight: 1.4 }} title="No score snapshot exists for this agent yet. That is an absent score, not a score of zero.">
                not scored
              </div>
              <Lbl>NO SNAPSHOT</Lbl>
            </>
          ) : (
            <>
              <div className="mono" style={{ fontSize: 22, fontWeight: 500, lineHeight: 1 }}>
                {fmtScore(sc)}
              </div>
              <Lbl>LATEST SCORE</Lbl>
            </>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <Lbl>ACCESS</Lbl>
          <div style={{ fontSize: 12.5 }}>{r.access_type ?? '—'}</div>
        </div>
        <div>
          <Lbl>$ARCA GATE</Lbl>
          <div>
            {gate === null ? (
              <span className="mono m3" style={{ fontSize: 12 }}>
                none
              </span>
            ) : (
              <Num value={money(gate)} />
            )}
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderTop: '1px solid var(--color-divider)',
          paddingTop: 10,
        }}
      >
        <div>
          {price === null ? (
            <span className="mono m3" style={{ fontSize: 12 }}>
              no price on this listing
            </span>
          ) : (
            <>
              <span className="mono" style={{ fontSize: 14 }}>
                {money(price)}
              </span>
              <span className="m3" style={{ fontSize: 11 }}> USD</span>
            </>
          )}
        </div>
        <Tag tone="outline" title="Subscribing needs a wallet, which arrives with Stage 4.">
          SIGN-IN REQUIRED
        </Tag>
      </div>
    </article>
  );
}

