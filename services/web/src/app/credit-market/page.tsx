/**
 * Agent Credit Markets — indications of interest.
 *
 * THE FIRST SENTENCE A READER NEEDS IS THAT NOTHING HERE IS FUNDED, and it is
 * the first thing on the page. An agent row shows what capital providers have
 * said they would supply; a reader who took that for capital supplied would be
 * trusting a balance that does not exist.
 *
 * EVERY LISTED AGENT, NOT ONLY THE QUALIFIED ONES. An agent is qualified when
 * it is rated and holds tier 1 or above, and no agent can be rated before it
 * has thirty days of borrowing history. A page that listed only the qualified
 * would be empty and would read as "nobody borrows". So the rest are shown as
 * building a record, each with the service's own reason.
 *
 * NOTHING IS COMPUTED HERE. The reputation, the tier, the limit, the risk
 * figures and the totals arrive decided by GET /v1/credit-market.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { agent } from '@/lib/api';
import { authed, getSession } from '@/lib/session';
import { int, money, num, utc } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Key, Num, Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed } from '@/components/ds/states';
import type { MyIndications } from './actions';
import { IndicationForm } from './IndicationForm';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Agent Credit Markets — ARCANA' };

type MarketAgent = {
  agent_id: string;
  name: string;
  version: number;
  status: string;
  visibility: string;
  strategy_type: string;
  creator: { id: string; handle: string | null } | null;
  capital: {
    status: 'unrated' | 'rated';
    score: number | null;
    unrated_why: string | null;
    tier: number;
    earned_tier: number;
    held_because: string | null;
    limit_usdg: number;
    confirmed_at: string;
    stale: boolean;
  };
  risk: {
    loans: { total: number; open: number; repaid: number; deleveraged: number; liquidated: number };
    usdg_days: number;
    lowest_health_factor_worst: number | null;
    share_under_floor: number | null;
    deleverage_steps: number;
    liquidations: number | null;
    owed_usdg: number;
  };
  qualified: boolean;
  not_qualified_why: string | null;
  interest: { providers: number; indicated_usdg: number; rate_bps_low: number | null; rate_bps_high: number | null };
};

type Market = {
  as_of: string;
  funded: false;
  credit_enabled: boolean;
  tiers: Array<{ tier: number; min_score: number; max_debt_usdg: number; min_scored_days: number }>;
  ceiling_usdg: number;
  totals: { agents: number; qualified: number; indications: number; providers: number; indicated_usdg: number };
  truncated: boolean;
  agents: MarketAgent[];
  limits: { min_amount_usdg: number; max_amount_usdg: number; min_rate_bps: number; max_rate_bps: number; max_open_per_wallet: number };
  note: string;
};

const rate = (bps: number) => `${num(bps / 100, 2)}%`;

export default async function CreditMarketPage() {
  const [marketR, s] = await Promise.all([agent<Market>('/v1/credit-market'), getSession()]);
  const signedIn = s.state === 'signed_in';
  const mineR = signedIn ? await authed<MyIndications>('/v1/credit-market/indications/mine') : null;
  const mine = new Map((mineR?.ok ? mineR.data.open : []).map((i) => [i.agent_id, i]));
  const myCreator = signedIn ? s.session.creator_id : null;
  const m = marketR.ok ? marketR.data : null;

  return (
    <div className="page">
      <Header current="Credit" />

      <div className="sec" style={{ paddingTop: 32, paddingBottom: 18, borderBottom: 'none' }}>
        <h1>Agent Credit Markets</h1>
        <div className="m2" style={{ fontSize: 12.5, marginTop: 4, maxWidth: 760, lineHeight: 1.55 }}>
          Agents that have borrowed, with the capital reputation and the risk figures a lender would choose by. A
          capital provider can record what they would supply to one of them.
        </div>
        <div style={{ marginTop: 14, maxWidth: 760 }}>
          <Callout tone="warn">
            <strong>No money moves here.</strong> An indication is not a loan, an escrow or a promise, and nothing on
            this page is funded. Every loan is still made by Morpho against the agent&rsquo;s own collateral. This is
            the first step of the market: what providers would supply is measured before anything is allowed to
            supply it. <Link href="/docs/roadmap#agent-credit">How it fits the roadmap</Link>.
          </Callout>
        </div>
      </div>

      <div className="sec" style={{ paddingBottom: 40, borderBottom: 'none' }}>
        {!marketR.ok ? (
          <Failed what="The credit market" error={marketR} />
        ) : m ? (
          <>
            <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <Figure label="LISTED AGENTS">{int(m.totals.agents)}</Figure>
              <Figure label="QUALIFIED">{int(m.totals.qualified)}</Figure>
              <Figure label="PROVIDERS">{int(m.totals.providers)}</Figure>
              <Figure label="INDICATED, NOT FUNDED">
                <Num value={money(m.totals.indicated_usdg)} /> USDG
              </Figure>
            </div>
            <p className="mono m3" style={{ marginTop: 8, fontSize: 11 }}>
              as of {utc(m.as_of)}
              {m.credit_enabled ? '' : ' · Agent Credit is switched off: no tier is in force'}
              {m.tiers.length > 0
                ? ' · tiers: ' +
                  m.tiers
                    .map((t) =>
                      `${t.tier} → ${money(t.max_debt_usdg, 0)} USDG` +
                      (t.tier > 0 ? ` at ${t.min_score}+` : '') +
                      (t.min_scored_days > 0 ? ` and ${t.min_scored_days} scored days` : ''))
                    .join(' · ')
                : ''}
            </p>

            {s.state === 'unknown' ? (
              <div style={{ marginTop: 14 }}>
                <Callout tone="warn">
                  Your session could not be confirmed ({s.reason}), so your own indications are not shown. This is not
                  the same as being signed out.
                </Callout>
              </div>
            ) : null}
            {mineR && !mineR.ok ? (
              <div style={{ marginTop: 14 }}>
                <Callout tone="warn">
                  Your own indications could not be read ({mineR.status}: {mineR.reason}). The market below is
                  unaffected.
                </Callout>
              </div>
            ) : null}
            {mineR?.ok && mineR.data.open.length > 0 ? (
              <p className="m2" style={{ marginTop: 14, fontSize: 12.5 }}>
                You have {mineR.data.open.length} standing indication{mineR.data.open.length === 1 ? '' : 's'}, of{' '}
                <span className="mono">{money(mineR.data.open_total_usdg)} USDG</span> in all. None of it is committed.
              </p>
            ) : null}

            {m.agents.length === 0 ? (
              <div style={{ marginTop: 18 }}>
                <Empty title="No agent has a capital record yet">
                  An agent is listed once it has borrowed. Borrowing is switched on by its owner, with a capital
                  mandate, on <Link href="/me/capital">/me/capital</Link>.
                </Empty>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16, marginTop: 18 }}>
                {m.agents.map((a) => {
                  const own = !!myCreator && a.creator?.id === myCreator;
                  const my = mine.get(a.agent_id) ?? null;
                  return (
                    <section key={a.agent_id} className="box">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                        <div>
                          <Link href={`/agents/${a.agent_id}?tab=positions`} style={{ fontSize: 15, fontWeight: 600 }}>
                            {a.name}
                          </Link>
                          {a.version > 1 ? <span className="mono m3" style={{ fontSize: 10 }}> v{a.version}</span> : null}{' '}
                          {a.qualified ? <Tag tone="accent">QUALIFIED</Tag> : <Tag tone="dashed">BUILDING A RECORD</Tag>}
                          {a.status !== 'active' ? (
                            <>
                              {' '}
                              <Tag tone="outline">{a.status.toUpperCase()}</Tag>
                            </>
                          ) : null}
                        </div>
                        <div className="mono m3" style={{ fontSize: 11 }}>
                          {a.creator?.handle ? <Link href={`/creators/${a.creator.id}`}>{a.creator.handle}</Link> : 'creator not recorded'}
                          {' · '}
                          {a.strategy_type}
                          {' · '}
                          <Link href={`/agents/${a.agent_id}?tab=passport`}>passport</Link>
                        </div>
                      </div>

                      <div style={{ marginTop: 12, display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                        <Figure label="CREDIT SCORE" big>
                          {a.capital.status === 'rated' && a.capital.score !== null ? (
                            <Num value={num(a.capital.score, 0)} />
                          ) : (
                            <span className="m3">unrated</span>
                          )}
                        </Figure>
                        <Figure label="TIER">
                          {a.capital.tier}
                          {a.capital.earned_tier > a.capital.tier ? <span className="m3"> · earned {a.capital.earned_tier}</span> : null}
                        </Figure>
                        <Figure label="CREDIT LIMIT">
                          <Num value={money(a.capital.limit_usdg)} /> USDG
                        </Figure>
                        <Figure label="OWED NOW">
                          <Num value={money(a.risk.owed_usdg)} /> USDG
                        </Figure>
                        <Figure label="LOANS">
                          {a.risk.loans.repaid} repaid of {a.risk.loans.total}
                          {a.risk.loans.open > 0 ? <span className="m3"> · {a.risk.loans.open} open</span> : null}
                        </Figure>
                        <Figure label="USDG-DAYS">
                          <Num value={num(a.risk.usdg_days, 1)} />
                        </Figure>
                        <Figure label="LOWEST HEALTH FACTOR" title="The lowest worst-case health factor any reading of its loans saw. Morpho liquidates at 1.0.">
                          {a.risk.lowest_health_factor_worst === null ? <span className="m3">—</span> : num(a.risk.lowest_health_factor_worst, 2)}
                        </Figure>
                        <Figure label="DELEVERAGED BY THE GUARD">{a.risk.deleverage_steps}×</Figure>
                        <Figure label="LIQUIDATIONS">
                          {a.risk.liquidations === null ? (
                            <span className="m3">not read yet</span>
                          ) : (
                            <span style={{ color: a.risk.liquidations ? 'var(--red)' : undefined }}>{a.risk.liquidations}</span>
                          )}
                        </Figure>
                      </div>

                      {a.not_qualified_why ? (
                        <p className="m2" style={{ marginTop: 10, fontSize: 12.5 }}>
                          Not qualified yet. {a.not_qualified_why}
                        </p>
                      ) : null}

                      <div style={{ marginTop: 12, borderTop: '1px solid var(--color-divider)', paddingTop: 12 }}>
                        <Key>Interest recorded</Key>
                        <div className="mono" style={{ fontSize: 13, marginTop: 6 }}>
                          {a.interest.providers === 0 ? (
                            <span className="m3">none yet</span>
                          ) : (
                            <>
                              <Num value={money(a.interest.indicated_usdg)} /> USDG from {a.interest.providers} provider
                              {a.interest.providers === 1 ? '' : 's'}
                              {a.interest.rate_bps_low !== null && a.interest.rate_bps_high !== null ? (
                                <span className="m3">
                                  {' · asking '}
                                  {a.interest.rate_bps_low === a.interest.rate_bps_high
                                    ? rate(a.interest.rate_bps_low)
                                    : `${rate(a.interest.rate_bps_low)} to ${rate(a.interest.rate_bps_high)}`}
                                  {' a year'}
                                </span>
                              ) : null}
                              <span className="m3"> · not funded</span>
                            </>
                          )}
                        </div>

                        {own ? (
                          <p className="m3" style={{ fontSize: 11.5, marginTop: 8 }}>
                            This agent is yours. An indication records what somebody else would supply to it.
                          </p>
                        ) : signedIn ? (
                          <IndicationForm
                            agentId={a.agent_id}
                            standing={my ? { amount_usdg: my.amount_usdg, rate_bps: my.rate_bps } : null}
                            minUsdg={m.limits.min_amount_usdg}
                            maxUsdg={m.limits.max_amount_usdg}
                          />
                        ) : s.state === 'signed_out' ? (
                          <p style={{ fontSize: 12, marginTop: 8 }}>
                            <Link href="/signin?next=%2Fcredit-market">Sign in with a wallet</Link>{' '}
                            <span className="m3">to record what you would supply. No creator profile is needed.</span>
                          </p>
                        ) : null}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
            {m.truncated ? (
              <p className="m3" style={{ fontSize: 11, marginTop: 10 }}>
                Only the first {m.agents.length} listed agents are shown.
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      <Footer />
    </div>
  );
}

function Figure({
  label,
  children,
  big = false,
  title,
}: {
  label: string;
  children: React.ReactNode;
  big?: boolean;
  title?: string;
}) {
  return (
    <div title={title}>
      <div className="mono m3" style={{ fontSize: 10 }}>{label}</div>
      <div className="mono" style={{ fontSize: big ? 22 : 15 }}>{children}</div>
    </div>
  );
}
