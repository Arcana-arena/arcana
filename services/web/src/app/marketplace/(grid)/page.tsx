/**
 * The marketplace grid.
 *
 * WHAT CHANGED AND WHY IT MATTERS. This page used to end in a note listing four
 * numbers it could not show — return, drawdown, a sparkline, a subscriber count
 * — because discovery returned seven columns. The numbers were in the database
 * the whole time. `GET /v1/marketplace/browse` now assembles them, and a
 * paragraph explaining an absence has been replaced by the thing it was
 * explaining.
 *
 * THE MOST IMPORTANT FIELD ON A CARD IS `buyable`. A Subscribe button on a
 * listing whose creator has no payee address is an invitation to send money
 * nobody can receive and nobody can refund. Every card that cannot be bought
 * says so where the button would be, and says which of the five reasons it is.
 *
 * ORDERING AND FILTERING ARE THE SERVICE'S. Every control here is a link that
 * re-asks. There is no comparator and no `.filter()` over rows in this file —
 * the array is printed in the order it arrives, and when the service could not
 * order it, the page says the rows are unordered instead of implying a ranking.
 *
 * A SCORE OF `null` IS NOT A LOW SCORE. It comes from the leaderboard, which
 * withholds rather than lowers, and the card prints the withholding.
 */
import Link from 'next/link';
import { marketplace, qs } from '@/lib/api';
import { int, money, num, pct, score as fmtScore, tone } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Lbl, Num, Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed } from '@/components/ds/states';
import { Seg } from '@/components/ds/nav';
import { Sparkline } from '@/components/ds/chart';
import type { BrowseResponse, BrowseItem } from '../shapes';

export const dynamic = 'force-dynamic';

type SP = { [k: string]: string | string[] | undefined };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const SORTS = [
  { key: 'score', label: 'Score', about: 'Highest published ARCANA Score first — ordered by the service.' },
  { key: 'return', label: 'Return', about: 'Highest season return first — measured from portfolio snapshots.' },
  { key: 'price', label: 'Cheapest', about: 'Lowest listing price first.' },
  { key: 'newest', label: 'Newest', about: 'Most recently created agent first.' },
];

export default async function MarketplacePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const sort = SORTS.some((s) => s.key === one(sp.sort)) ? (one(sp.sort) as string) : 'score';
  const q = one(sp.q) || '';
  const strategy = one(sp.strategy) || '';
  const universe = one(sp.universe) || '';
  const minScore = one(sp.min_score) || '';
  const buyableOnly = one(sp.buyable_only) === 'true';

  const query = qs({
    sort,
    q: q || undefined,
    strategy: strategy || undefined,
    universe: universe || undefined,
    min_score: minScore || undefined,
    buyable_only: buyableOnly ? 'true' : undefined,
  });
  const r = await marketplace<BrowseResponse>(`/v1/marketplace/browse${query}`);

  const href = (over: Record<string, string | undefined>) => {
    const base: Record<string, string | undefined> = {
      sort,
      q: q || undefined,
      strategy: strategy || undefined,
      universe: universe || undefined,
      min_score: minScore || undefined,
      buyable_only: buyableOnly ? 'true' : undefined,
      ...over,
    };
    return `/marketplace${qs(base)}`;
  };

  const d = r.ok ? r.data : null;
  const filtered = !!(q || strategy || universe || minScore || buyableOnly);

  return (
    <div className="page">
      <Header current="Marketplace" />

      <div
        className="sec"
        style={{ paddingTop: 32, paddingBottom: 18, borderBottom: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20, flexWrap: 'wrap' }}
      >
        <div>
          <h1>Marketplace</h1>
          <div className="m2" style={{ fontSize: 12.5, marginTop: 4, maxWidth: 720, lineHeight: 1.5 }}>
            {d ? (
              <>
                <span className="mono">{int(d.counts.buyable)}</span> of{' '}
                <span className="mono">{int(d.counts.listings)}</span> listing
                {d.counts.listings === 1 ? '' : 's'} can be subscribed to right now. A subscribed agent also trades in{' '}
                <em style={{ color: 'var(--color-text)', fontStyle: 'normal' }}>your own wallet</em>, sized by your own
                limits — the creator chooses only the direction.
              </>
            ) : (
              'A subscribed agent also trades in your own wallet, sized by your own limits.'
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12 }}>
          <span className="m3">Sort</span>
          <Seg current={sort} tabs={SORTS.map((s) => ({ ...s, href: href({ sort: s.key }) }))} />
        </div>
      </div>

      {/* FILTERS. A GET form, so every filtered view has its own URL and the
          back button behaves. The facets come from the service and carry their
          own counts, so a filter that would match nothing says so before it is
          clicked. */}
      <div className="sec" style={{ paddingTop: 0, paddingBottom: 16, borderBottom: 'none' }}>
        <form method="get" action="/marketplace" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="hidden" name="sort" value={sort} />
          <input
            className="input mono"
            type="search"
            name="q"
            defaultValue={q}
            placeholder="agent or creator"
            aria-label="Search the marketplace"
            style={{ width: 190, fontSize: 12 }}
          />
          <select name="strategy" defaultValue={strategy} aria-label="Strategy" className="input" style={{ fontSize: 12 }}>
            <option value="">Strategy · all</option>
            {(d?.facets.strategy_type ?? []).map((f) => (
              <option key={f.value} value={f.value}>
                {f.value} ({f.listings})
              </option>
            ))}
          </select>
          <select name="universe" defaultValue={universe} aria-label="Universe" className="input" style={{ fontSize: 12 }}>
            <option value="">Universe · all</option>
            {(d?.facets.asset_universe ?? []).map((f) => (
              <option key={f.value} value={f.value}>
                {f.value} ({f.listings})
              </option>
            ))}
          </select>
          <select name="min_score" defaultValue={minScore} aria-label="Minimum score" className="input" style={{ fontSize: 12 }}>
            <option value="">Score · any</option>
            <option value="40">Score ≥ 40</option>
            <option value="60">Score ≥ 60</option>
            <option value="75">Score ≥ 75</option>
          </select>
          <label className="m2" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" name="buyable_only" value="true" defaultChecked={buyableOnly} />
            Only what can be bought
          </label>
          <button className="btn" type="submit" style={{ fontSize: 12 }}>
            Apply
          </button>
          {filtered ? (
            <Link href="/marketplace" className="m3" style={{ fontSize: 12 }}>
              clear
            </Link>
          ) : null}
        </form>
        {minScore ? (
          <div className="m3" style={{ fontSize: 11, marginTop: 6 }}>
            A score floor can only judge agents that have one. An agent whose score is withheld is excluded by this
            filter rather than treated as scoring zero.
          </div>
        ) : null}
      </div>

      <div className="sec" style={{ paddingBottom: 40, borderBottom: 'none' }}>
        {!r.ok ? (
          <Failed what="The marketplace" error={r} />
        ) : d && d.items.length === 0 ? (
          <EmptyGrid d={d} filtered={filtered} />
        ) : (
          <>
            {d && !d.sorted ? (
              <div style={{ marginBottom: 16 }}>
                <Callout tone="warn">
                  <strong>These rows are not in the order you asked for.</strong> {d.sort_note}
                </Callout>
              </div>
            ) : null}
            {d && d.performance_unavailable_reason ? (
              <div style={{ marginBottom: 16 }}>
                <Callout tone="warn">
                  <strong>Return and drawdown could not be read.</strong> {d.performance_unavailable_reason}. The cards
                  below say so on each tile rather than showing a flat line, which would read as an agent that made
                  nothing.
                </Callout>
              </div>
            ) : null}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 24 }}>
              {(d?.items ?? []).map((i) => (
                <ListingCard key={i.listing_id} i={i} />
              ))}
            </div>
            {d && d.counts.hidden_unavailable > 0 ? (
              <div className="m3" style={{ fontSize: 11.5, marginTop: 16 }}>
                <span className="mono">{int(d.counts.hidden_unavailable)}</span> more listing
                {d.counts.hidden_unavailable === 1 ? ' is' : 's are'} not shown — {describeHidden(d.counts.hidden_by_agent_status)}.
                A stopped agent decides nothing, so a subscription bought today would mirror nothing. The listings are
                untouched: a paused agent’s comes back by itself the moment its creator resumes it.
              </div>
            ) : null}
            {d && d.counts.inactive > 0 && !buyableOnly ? (
              <div className="m3" style={{ fontSize: 11.5, marginTop: 16 }}>
                <span className="mono">{int(d.counts.inactive)}</span> of these listing
                {d.counts.inactive === 1 ? ' is' : 's are'} switched off and shown anyway, marked, so the grid is the
                whole marketplace rather than the part of it that happens to be for sale.
              </div>
            ) : null}
          </>
        )}
      </div>

      <Footer />
    </div>
  );
}

/**
 * The empty grid, told apart from its neighbours.
 *
 * Four different facts render as no cards: nobody has listed anything, the
 * listings are switched off, every listed creator is unpayable, or the filters
 * matched nothing. The counts come back with the response precisely so this
 * block can say which — an empty grid that does not is a claim about the
 * marketplace that may be false.
 */
/**
 * "3 retired, 1 paused" — the statuses, not just the total.
 *
 * A bare count invites the wrong conclusion in both directions: three paused
 * agents is a quiet week, three retired ones is a marketplace emptying out.
 */
function describeHidden(by: Record<string, number>): string {
  const WORDS: Record<string, string> = {
    retired: 'retired',
    paused: 'paused by their creator',
    draft: 'never started',
  };
  const entries = Object.entries(by).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return 'their agents are not active';
  if (entries.length === 1) {
    const [status, n] = entries[0];
    const word = WORDS[status] ?? status;
    return n === 1 ? `its agent is ${word}` : `their agents are ${word}`;
  }
  const parts = entries.map(([status, n]) => `${int(n)} ${WORDS[status] ?? status}`);
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function EmptyGrid({ d, filtered }: { d: BrowseResponse; filtered: boolean }) {
  // EVERY LISTING WITHHELD is its own fact, and it is not "nothing can be
  // bought". The marketplace is not broken and the creators are not unpayable;
  // the agents stopped. Checked before the filter branch because a withheld row
  // is not a row the filters rejected.
  if (d.counts.hidden_unavailable > 0 && d.counts.hidden_unavailable === d.counts.listings) {
    return (
      <Empty title="No agent on the marketplace is running right now">
        Every listing here belongs to an agent that is not active — {describeHidden(d.counts.hidden_by_agent_status)}.
        None of them is shown, because a stopped agent decides nothing and a subscription bought today would mirror
        nothing. Nothing has been deleted: a paused agent’s listing returns by itself when its creator resumes it.
      </Empty>
    );
  }
  if (filtered && d.counts.listings > 0) {
    return (
      <Empty title="No listing matches these filters">
        The marketplace holds <span className="mono">{int(d.counts.listings)}</span> listing
        {d.counts.listings === 1 ? '' : 's'}; none of them matches what you asked for.{' '}
        <Link href="/marketplace">Clear the filters</Link> to see all of them.
      </Empty>
    );
  }
  if (d.counts.listings === 0) {
    return (
      <Empty title="No agent has been listed">
        No creator has put an agent up for subscription. This is an empty marketplace, not a marketplace that failed to
        load.
      </Empty>
    );
  }
  return (
    <Empty title="Nothing here can be bought right now">
      <span className="mono">{int(d.counts.listings)}</span> listing{d.counts.listings === 1 ? '' : 's'} exist
      {d.counts.listings === 1 ? 's' : ''}, and none of them can currently be subscribed to.
      {d.counts.creators_without_wallet > 0 ? (
        <>
          {' '}
          <span className="mono">{int(d.counts.creators_without_wallet)}</span> of them belong to a creator with no
          wallet address on record — there is no address a buyer could pay, so the platform refuses to quote one rather
          than take money to a place it cannot verify.
        </>
      ) : null}{' '}
      <Link href="/marketplace?buyable_only=false">Show them anyway</Link> to see each one and why.
    </Empty>
  );
}

function ListingCard({ i }: { i: BrowseItem }) {
  const perf = i.performance;
  const seriesPoints = perf.series.map((p) => ({ ts: p.ts, value: p.nav, agg: p.agg }));

  return (
    <article className="card" style={i.buyable ? undefined : { borderColor: 'rgba(212,162,74,.35)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 18, lineHeight: 1.1 }}>
            <Link href={`/marketplace/${i.listing_id}`}>{i.agent_name ?? i.agent_id.slice(0, 8)}</Link>{' '}
            {i.agent_version ? (
              <span className="mono m3" style={{ fontWeight: 400, fontSize: 10 }}>
                v{i.agent_version}
              </span>
            ) : null}
          </div>
          <div className="m2" style={{ fontSize: 11.5 }}>
            by{' '}
            {i.creator?.handle ? (
              <Link href={`/creators/${i.creator.id}`}>{i.creator.handle}</Link>
            ) : (
              <span className="m3">creator not recorded</span>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right', flex: 'none' }}>
          {/* WITHHELD IS NOT LOW, and the two are drawn differently. */}
          {i.score === null ? (
            <>
              <div className="mono m3" style={{ fontSize: 22, lineHeight: 1 }} title={scoreWhy(i)}>
                —
              </div>
              <Lbl>{i.ranked === false ? 'UNRANKED' : i.absent_from_leaderboard ? 'NOT COMPETING' : 'NO SCORE'}</Lbl>
            </>
          ) : (
            <>
              <div className="mono" style={{ fontSize: 22, fontWeight: 500, lineHeight: 1 }}>
                {fmtScore(i.score)}
              </div>
              <Lbl>SCORE{i.rank ? ` · #${i.rank}` : ''}</Lbl>
            </>
          )}
        </div>
      </div>

      {/* THE SPARKLINE IS DRAWN FROM THE SERVICE'S OWN min/max BUCKETS. It is
          not resampled here — the deepest point of a drawdown is exactly the
          value a second pass would smooth away. */}
      {perf.available && perf.measured && seriesPoints.length > 1 ? (
        <Sparkline points={seriesPoints} width="100%" height={40} />
      ) : (
        <div
          className="m3 mono"
          style={{ height: 40, display: 'flex', alignItems: 'center', fontSize: 10.5, borderBottom: '1px dashed var(--ink-4)' }}
          title={perf.available ? perf.note ?? undefined : perf.reason ?? undefined}
        >
          {perf.available ? 'no NAV series in this season' : 'series unreadable'}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        <div>
          <Lbl>RETURN</Lbl>
          <Num
            value={pct(perf.return_pct)}
            tone={tone(perf.return_pct)}
            title={perf.available ? perf.note ?? undefined : perf.reason ?? undefined}
          />
        </div>
        <div>
          <Lbl>MAX DD</Lbl>
          <Num
            value={perf.max_drawdown_pct === null ? '—' : `−${num(perf.max_drawdown_pct, 2)}%`}
            tone={perf.max_drawdown_pct === null ? 'flat' : 'dn'}
            title="The largest fall from a running peak inside this season."
          />
        </div>
        <div>
          <Lbl>STRATEGY</Lbl>
          <div style={{ fontSize: 12 }}>{i.strategy_type ?? <span className="m3">not stated</span>}</div>
        </div>
      </div>

      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--color-divider)', paddingTop: 10, gap: 8 }}
      >
        <div>
          {i.price_usd === null ? (
            <span className="mono m3" style={{ fontSize: 12 }}>
              no price on this listing
            </span>
          ) : (
            <>
              <span className="mono" style={{ fontSize: 14 }}>
                {money(i.price_usd)}
              </span>
              <span className="m3" style={{ fontSize: 11 }}> USDG / 30d</span>
            </>
          )}
        </div>
        <span className="mono m2" style={{ fontSize: 11 }} title="Subscriptions currently active against this listing.">
          {int(i.subscribers.active)} sub{i.subscribers.active === 1 ? '' : 's'}
        </span>
      </div>

      {i.buyable ? (
        <Link href={`/marketplace/${i.listing_id}`} className="btn btn-primary" style={{ justifyContent: 'center' }}>
          Subscribe
        </Link>
      ) : (
        <div>
          <Tag tone="amber" title={i.not_buyable_note ?? undefined}>
            {UNBUYABLE_LABEL[i.not_buyable_because ?? ''] ?? 'NOT AVAILABLE'}
          </Tag>
          <div className="m3" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>
            {i.not_buyable_note}
          </div>
          <Link href={`/marketplace/${i.listing_id}`} style={{ fontSize: 11.5, display: 'inline-block', marginTop: 6 }}>
            Read the record anyway →
          </Link>
        </div>
      )}
    </article>
  );
}

const UNBUYABLE_LABEL: Record<string, string> = {
  creator_has_no_wallet: 'NO PAYEE ADDRESS',
  agent_retired: 'RETIRED',
  agent_paused: 'PAUSED',
  agent_draft: 'NEVER STARTED',
  listing_inactive: 'SWITCHED OFF',
};

function scoreWhy(i: BrowseItem): string {
  if (!i.scoring_known) return 'The leaderboard could not be read, so no score is shown. This is not a score of zero.';
  if (i.unranked_note) return i.unranked_note;
  if (i.absent_from_leaderboard) {
    return 'This agent is not on the current leaderboard — it is not competing in the running season, so there is no score for it to have.';
  }
  return 'No score is published for this agent. That is a withheld score, not a low one.';
}
