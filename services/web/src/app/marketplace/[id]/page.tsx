/**
 * One listing: the record, what a subscription actually does, and the quote.
 *
 * THE THING BEING SOLD IS NOT INFORMATION. A subscription puts this agent's
 * decisions into the buyer's own wallet, with the buyer's own money. So the
 * page states what will happen there before it states a price: which symbols
 * the agent has really traded, whose limits size the positions, and what the
 * smallest protective level this pool accepts is — because a stop the buyer
 * cannot arm is a fact they need before paying, not after the first tick.
 *
 * THE QUOTE IS FETCHED SERVER-SIDE AND HANDED DOWN. The address and the amount
 * come from the same code that verifies the payment; nothing on this page
 * computes either. When the quote cannot be had, the panel says no amount can
 * be stated and tells the reader not to send anything — the failure mode this
 * endpoint exists to close is a buyer learning an address from somewhere else.
 *
 * A LISTING THAT CANNOT BE BOUGHT STILL RENDERS. Its record is public and
 * worth reading; what it does not get is a Subscribe button pointing at an
 * address nobody can receive money at.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { marketplace, arca, MARKETPLACE_API } from '@/lib/api';
import { getSession } from '@/lib/session';
import { int, money, num, pct, score as fmtScore, tone, utcDate } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Key, Lbl, Num, Tag } from '@/components/ds/primitives';
import { Callout, Failed } from '@/components/ds/states';
import { LineChart } from '@/components/ds/chart';
import { SubscribeFlow } from './SubscribeFlow';
import type { ListingDetail, Quote, Terms } from '../shapes';

export const dynamic = 'force-dynamic';

export default async function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [detailR, sessionState, termsR] = await Promise.all([
    marketplace<ListingDetail>(`/v1/marketplace/listings/${id}/detail`),
    getSession(),
    arca<Terms>('/v1/arca/terms'),
  ]);

  if (!detailR.ok && detailR.status === 404) notFound();
  if (!detailR.ok) {
    return (
      <div className="page">
        <Header current="Marketplace" />
        <div className="sec" style={{ paddingTop: 48, paddingBottom: 48, borderBottom: 'none' }}>
          <Failed what="This listing" error={detailR} />
        </div>
        <Footer />
      </div>
    );
  }

  const d = detailR.data;
  const name = d.agent_name ?? d.agent_id.slice(0, 8);

  // The quote is only asked for when the listing can actually be bought. Asking
  // for one on a listing with no payee returns the refusal that says so, and
  // rendering that refusal beside a record somebody is only reading would put
  // an alarm where there is no transaction.
  let quote: Quote | null = null;
  let quoteError: string | null = null;
  if (d.buyable) {
    const q = await marketplace<Quote>(`/v1/marketplace/listings/${id}/quote`);
    if (q.ok) quote = q.data;
    else quoteError = `The quote could not be read (${q.status ?? 'no answer'}: ${q.reason}).`;
  } else {
    quoteError = d.not_buyable_note;
  }

  /*
   * THE PAYMENT QR, RENDERED ON THE SERVER FROM THE SERVICE'S OWN URI.
   *
   * The EIP-681 string is built by arca-service, beside the address and the
   * amount it verifies against — this page does not assemble one. That matters
   * more here than anywhere else on the site: a QR is the one control a buyer
   * cannot proofread, so if the page composed its own, the address on screen
   * and the address in the code could differ and only the chain would find out.
   *
   * Encoded here rather than in the browser so the panel needs no extra
   * bundle, and so a page with JavaScript still loading is not showing an
   * empty square where a payment instruction belongs.
   */
  let qrSvg: string | null = null;
  if (quote?.eip681) {
    try {
      const QRCode = (await import('qrcode')).default;
      qrSvg = await QRCode.toString(quote.eip681, {
        type: 'svg',
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#050b07', light: '#e4ede7' },
      });
    } catch {
      // A QR that could not be drawn is left out, and the address and amount
      // are on the page in full either way. Nothing here is only scannable.
      qrSvg = null;
    }
  }

  const signedIn = sessionState.state === 'signed_in';
  const perf = d.performance;
  const chartPoints = perf.series.map((p) => ({ ts: p.ts, value: p.nav, agg: p.agg }));
  const terms = termsR.ok ? termsR.data : null;

  return (
    <div className="page">
      <Header current="Marketplace" />

      <div className="sec detail-grid" style={{ paddingTop: 26, paddingBottom: 44, borderBottom: 'none' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 }}>
          <div>
            <div className="mono m3" style={{ fontSize: 11, marginBottom: 8 }}>
              <Link href="/marketplace" className="m2">
                Marketplace
              </Link>{' '}
              / {name}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <h1 style={{ fontSize: 34, margin: 0, lineHeight: 1 }}>{name}</h1>
              {d.agent_version ? (
                <span className="mono m2" style={{ fontSize: 12, padding: '2px 8px', border: '1px solid var(--color-divider)' }}>
                  v{d.agent_version}
                </span>
              ) : null}
              {d.agent_status === 'active' ? (
                <Tag tone="accent" dot>
                  LIVE
                </Tag>
              ) : (
                <Tag tone="amber">{(d.agent_status ?? 'no status').toUpperCase()}</Tag>
              )}
              <span className="mono m2" style={{ fontSize: 12, marginLeft: 'auto' }}>
                {d.score === null ? (
                  <span className="m3" title={d.unranked_note ?? undefined}>
                    no published score
                  </span>
                ) : (
                  <>
                    score {fmtScore(d.score)}
                    {d.rank ? ` · rank #${d.rank}` : ''}
                  </>
                )}{' '}
                · <Link href={`/agents/${d.agent_id}`}>full profile →</Link>
              </span>
            </div>
            <div className="m2" style={{ fontSize: 13, marginTop: 8 }}>
              by{' '}
              {d.creator?.handle ? (
                <Link href={`/creators/${d.creator.id}`}>{d.creator.handle}</Link>
              ) : (
                <span className="m3">creator not recorded</span>
              )}{' '}
              · <span className="mono">{int(d.subscribers.active)}</span> active subscriber
              {d.subscribers.active === 1 ? '' : 's'} · agent created {utcDate(d.agent_created_at)}
              {perf.age_days !== null ? (
                <>
                  {' '}
                  · <span className="mono">{num(perf.age_days, 1)}</span> days of record this season
                </>
              ) : null}
            </div>
          </div>

          {!d.buyable ? (
            <Callout tone="warn">
              <strong>This listing cannot be bought.</strong> {d.not_buyable_note} Its record is below and is worth
              reading; what is not offered is a payment address.
            </Callout>
          ) : null}

          {/* TRACK RECORD. The series is drawn exactly as the service bucketed
              it — min and max per bucket, in time order. Re-smoothing it here
              would delete the deepest point of every drawdown. */}
          <section className="blueprint" style={{ padding: '14px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
              <Key>Track record · NAV this season</Key>
              <span className="mono m2" style={{ fontSize: 11 }}>
                {perf.measured && perf.points > 0 ? (
                  <>
                    {int(perf.points)} snapshots ·{' '}
                    <span className={tone(perf.return_pct)}>{pct(perf.return_pct)}</span>
                  </>
                ) : (
                  <span className="m3">not measured</span>
                )}
              </span>
            </div>
            {perf.available && perf.measured && chartPoints.length > 1 ? (
              <LineChart
                points={chartPoints}
                height={160}
                unit="NAV"
                resolutionNote="Bucketed by the service, keeping each bucket's minimum and maximum. Not resampled here."
              />
            ) : (
              <div className="m3" style={{ fontSize: 12, padding: '28px 0', lineHeight: 1.5 }}>
                {perf.available
                  ? perf.note ??
                    'No NAV series exists for this agent in the current season, so there is no line to draw. An empty chart here is an absent measurement, not a flat one.'
                  : `The NAV series could not be read: ${perf.reason}. Nothing is drawn rather than a flat line, which would claim the value did not move.`}
              </div>
            )}
          </section>

          <div className="stat-row">
            <Stat label="Return" value={pct(perf.return_pct)} tone={tone(perf.return_pct)} why={perf.note ?? perf.reason} />
            <Stat
              label="Max drawdown"
              value={perf.max_drawdown_pct === null ? '—' : `−${num(perf.max_drawdown_pct, 2)}%`}
              tone={perf.max_drawdown_pct === null ? 'flat' : 'dn'}
              why="The largest fall from a running peak, inside this season."
            />
            <Stat
              label="Win rate"
              value="—"
              tone="flat"
              why="Not computable. A win rate needs closed round trips, and this record does not pair a sell to the buy it closed. Counting profitable sells would score a partial reduction as a win and credit the agent with its own stop-loss."
            />
            <Stat
              label="Days of record"
              value={perf.age_days === null ? '—' : num(perf.age_days, 1)}
              tone="flat"
              why="Time competing in this season, not time since the agent was created."
            />
            <Stat
              label="Subscriber P&L"
              value="—"
              tone="flat"
              why="No subscription against this listing has a wallet snapshot, so there is no subscriber outcome to report. This is an absent measurement, not a result of zero."
            />
          </div>

          <div className="two-col">
            <section className="box">
              <Key>What a subscriber gets</Key>
              <ul className="prose-list">
                <li>
                  This agent&rsquo;s decisions are mirrored into{' '}
                  <b style={{ color: 'var(--color-text)', fontWeight: 500 }}>your own wallet</b>, every tick it trades.
                  Your limits size the position; the creator chooses only the direction.
                </li>
                <li>
                  Your own stop-loss and take-profit levels apply.{' '}
                  {d.pool_minimum_percent === null ? (
                    <span className="m3">{d.pool_minimum_note}</span>
                  ) : (
                    <>
                      The smallest level this pool has accepted is{' '}
                      <span className="mono" style={{ color: 'var(--color-text)' }}>
                        {num(d.pool_minimum_fraction, 6)}
                      </span>{' '}
                      = <span className="mono">{num(d.pool_minimum_percent, 4)}%</span>. Anything tighter is refused,
                      which leaves the position with nothing watching it.
                    </>
                  )}
                </li>
                <li>The full decision log for your wallet, with every transaction hash.</li>
                <li>
                  Term:{' '}
                  <span className="mono" style={{ color: 'var(--color-text)' }}>
                    {terms ? `${terms.term_days} days` : quote ? `${quote.term_days} days` : 'not stated'}
                  </span>{' '}
                  from confirmation, then{' '}
                  <span className="mono">
                    {terms ? `${terms.grace_hours}h` : quote ? `${quote.grace_hours}h` : '—'}
                  </span>{' '}
                  of grace. During grace the agent opens nothing new for you, and armed stops still fire.
                </li>
                <li>
                  A private key you can take. The trading wallet is yours; ARCANA holding the only key to it would be a
                  custody arrangement you cannot end.
                </li>
              </ul>
            </section>

            <section className="box">
              <Key>What it will trade in your wallet</Key>
              {d.traded_symbols.length === 0 ? (
                <div className="m3" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
                  This agent has recorded no decision naming a symbol, so there is nothing to list. Its permitted
                  universe is <span className="mono">{d.asset_universe ?? 'not stated'}</span> — a different claim from
                  what it has actually traded.
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '10px 0 12px' }}>
                    {d.traded_symbols.map((s) => (
                      <span key={s.symbol} className="sym" title={`${s.decisions} recorded decisions`}>
                        {s.symbol}
                      </span>
                    ))}
                  </div>
                  <div className="m3" style={{ fontSize: 11, lineHeight: 1.45 }}>
                    {d.traded_symbols_note}
                  </div>
                </>
              )}
              {/* DECLARED AND MEASURED, SIDE BY SIDE AND NEVER MERGED. The
                  first is what the creator wrote down; the second is what the
                  platform observed. The distance between them is the whole
                  content of the strategy multiplier, and a page that showed one
                  under the other's heading would let a mislabelled agent
                  present its own description as evidence. */}
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--color-divider)' }}>
                <Lbl>DECLARED · THE CREATOR&rsquo;S OWN LIMITS</Lbl>
                {d.visibility === 'private' ? (
                  // WITHHELD, SAID AS WITHHELD. "No risk profile is recorded" would
                  // be false here, and would read as an agent trading without limits.
                  <div className="m2" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
                    <span className="tag tag-outline">PRIVATE</span> The creator keeps this agent&rsquo;s risk rules
                    private. In your wallet, your own limits apply either way.
                  </div>
                ) : (
                  <RiskBlock
                    rp={d.risk_profile}
                    note={d.risk_note}
                    absent="No risk profile is recorded on this agent. That is an absent record, not a set of limits equal to zero."
                  />
                )}
              </div>
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--color-divider)' }}>
                <Lbl>
                  MEASURED · WHAT IT ACTUALLY DOES
                  {d.risk_personality_computed_at ? ` · ${utcDate(d.risk_personality_computed_at)}` : ''}
                </Lbl>
                <RiskBlock rp={d.risk_personality} note={d.risk_personality_note} absent={d.risk_personality_note} />
              </div>
            </section>
          </div>

          {d.visibility === 'private' ? (
            <section className="box">
              <Key>Private agent · public proof</Key>
              <div className="m2" style={{ fontSize: 12.5, marginTop: 8, lineHeight: 1.55 }}>
                {d.intelligence_note}
              </div>
              <div style={{ marginTop: 10, fontSize: 12 }}>
                <a href={`/agents/${d.agent_id}?tab=decisions`}>Every decision, and the commitment sealing each one →</a>
              </div>
            </section>
          ) : d.mandate ? (
            <section className="box">
              <Key>The mandate, as written</Key>
              <pre className="mandate">{d.mandate}</pre>
              <div className="m3" style={{ fontSize: 11, marginTop: 8 }}>
                Printed verbatim. Summarising a mandate is editing the thing the agent is judged against.
              </div>
            </section>
          ) : null}
        </div>

        <SubscribeFlow
          listingId={d.listing_id}
          agentName={name}
          quote={quote}
          quoteError={quoteError}
          qrSvg={qrSvg}
          signedIn={signedIn}
          signInHref={`/signin?next=${encodeURIComponent(`/marketplace/${d.listing_id}`)}`}
        />
      </div>

      <Footer />
    </div>
  );
}

function Stat({ label, value, tone: t, why }: { label: string; value: string; tone: 'up' | 'dn' | 'flat'; why?: string | null }) {
  return (
    <div className="box">
      <Key>{label}</Key>
      <div style={{ marginTop: 4, fontSize: 20 }}>
        <Num value={value} tone={t} title={why ?? undefined} />
      </div>
    </div>
  );
}

/**
 * The creator's risk limits, printed as whatever the record holds.
 *
 * NOT MAPPED ONTO A FIXED SET OF FOUR FIELDS. `risk_personality` is a jsonb
 * blob whose shape has changed; a component that reads four known keys would
 * silently drop every limit added since it was written, and a buyer would read
 * a short list as a complete one.
 */
function RiskBlock({
  rp,
  note,
  absent,
}: {
  rp: Record<string, unknown> | null;
  note: string;
  absent: string;
}) {
  const entries = rp && typeof rp === 'object' ? Object.entries(rp).filter(([, v]) => v !== null && typeof v !== 'object') : [];
  const nested = rp && typeof rp === 'object' ? Object.entries(rp).filter(([, v]) => v && typeof v === 'object') : [];
  if (!rp || (entries.length === 0 && nested.length === 0)) {
    return (
      <div className="m3" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
        {absent}
      </div>
    );
  }
  return (
    <>
      <dl className="kv" style={{ marginTop: 8 }}>
        {entries.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k.replace(/_/g, ' ')}</dt>
            <dd className="mono">{String(v)}</dd>
          </div>
        ))}
        {nested.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k.replace(/_/g, ' ')}</dt>
            <dd className="mono brk" style={{ fontSize: 11 }}>
              {JSON.stringify(v)}
            </dd>
          </div>
        ))}
      </dl>
      <div className="m3" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.45 }}>
        {note}
      </div>
    </>
  );
}
