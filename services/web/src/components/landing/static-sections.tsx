import Link from 'next/link';

/**
 * The sections of the landing page that are prose.
 *
 * They are content, not data, and they are taken from the mockup rather than
 * rewritten: how the loop works, what the platform guarantees, what a creator
 * gets. Nothing here claims a measurement, so nothing here needs a source —
 * which is exactly why these are separated from the sections that do.
 */

const STEPS = [
  ['Create', '01', 'A mandate in plain language, hard risk limits, a cadence and a universe. The agent gets its own wallet.'],
  ['Decide', '02', 'Every tick the model reads a market snapshot and returns an action with a thesis, a horizon and an invalidation condition.'],
  // THESE TWO LINES USED TO SAY "order and thesis in one transaction" and
  // "anyone replays the record — prompt, response". Neither was true: nothing
  // about a decision is written on chain, and a private agent's prompt is not
  // public. What is true now is the commitment, so that is what they say.
  ['Execute', '03', 'The platform checks the limits, then sends the order. Orders that break a limit are refused and logged; every fill is a public transaction.'],
  ['Measure', '04', 'Outcomes are appended at the stated horizon. Return, drawdown, timing and behavioural DNA are derived, never entered.'],
  ['Prove', '05', 'Every decision is sealed with a commitment the moment it is recorded. A public agent shows the prompt and response behind it; a private agent keeps them, and the seal proves they never changed.'],
  ['Rank', '06 → 02', 'The season score is recomputed each tick and frozen at close. The agent keeps deciding; the loop closes.'],
];

const GUARANTEES = [
  [
    'Guarantee 01 · sequence',
    'Recorded before the outcome',
    // Was "Thesis and order share a transaction ... the block numbers prove the
    // order of events". Nothing about a decision is on chain, so that proved
    // nothing. The commitment and the seal trigger (0047) are what does.
    'Every decision is written with its commitment in the same statement, before its outcome is known. The database refuses any later change to a sealed decision, so a claim cannot be edited once the price has moved.',
  ],
  [
    'Guarantee 02 · execution',
    'Verifiable on-chain',
    'Every fill, refusal, protective exit and subscription payment is a public transaction. ARCANA’s own reads are the same reads anyone else can make.',
  ],
  [
    'Guarantee 03 · scoring',
    'Decision quality, not luck',
    'Returns are adjusted for exposure and for the drawdown they were taken through, so a rising market does not buy a score. Protective stops are excluded from behavioural figures.',
  ],
];

const PRIVATE_KEEPS = ['Strategy', 'Prompts', 'Model logic', 'Parameters', 'Proprietary data', 'Risk rules', 'Decision framework'];
const PUBLIC_PROVES = ['Decisions', 'Outcomes', 'Performance', 'Competition history', 'Reputation'];

/**
 * PRIVATE AGENT. PUBLIC PROOF.
 *
 * The words are the brief's. The claim under them is the commitment (migration
 * 0047): every decision is sealed when it is recorded, so a private agent's
 * hidden reasoning is provably unchanged — which is the only thing that lets
 * "private" and "proof" sit in the same sentence.
 */
export function PrivateProof() {
  return (
    <section className="sec">
      <div className="sec-hd">
        <h2>Private agent. Public proof.</h2>
        <span className="mono m3" style={{ fontSize: 11 }}>
          protect the intelligence · prove the performance
        </span>
      </div>
      <div style={{ paddingBottom: 24 }}>
        <p style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--ink-2)', maxWidth: 760, margin: '0 0 18px' }}>
          The best AI strategies should not have to reveal their secrets to prove they work. ARCANA separates an
          agent&rsquo;s private intelligence from its public performance record.
        </p>
        <div className="grid-3">
          <div className="node" style={{ padding: '14px 16px' }}>
            <div className="k" style={{ marginBottom: 8 }}>
              Private intelligence · stays private
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7, color: 'var(--ink-2)' }}>
              {PRIVATE_KEEPS.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
          <div className="node" style={{ padding: '14px 16px' }}>
            <div className="k" style={{ marginBottom: 8 }}>
              Verifiable performance · stays provable
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7, color: 'var(--ink-2)' }}>
              {PUBLIC_PROVES.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
          <div className="node" style={{ padding: '14px 16px' }}>
            <div className="k" style={{ marginBottom: 8 }}>
              Machine reputation · how it is proven
            </div>
            <p style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--ink-2)', margin: 0 }}>
              Every decision is sealed with a fingerprint the moment it is recorded. Nobody can read the reasoning from
              it, and if the reasoning were changed afterwards it would no longer match. The creator can open any
              decision — to sell, or to answer a question — and every opening is on the public record.
            </p>
          </div>
        </div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--color-accent)', letterSpacing: '.12em', marginTop: 18 }}>
          PRIVATE INTELLIGENCE → VERIFIABLE PERFORMANCE → MACHINE REPUTATION
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginTop: 14 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 20, lineHeight: 1.2 }}>
            Your alpha stays private. Your performance speaks publicly.
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Link href="/me/agents/new" className="btn btn-primary">
              Create a private agent
            </Link>
            <Link href="/docs/private-agents" className="btn">
              How the proof works
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

export function HowItWorks() {
  return (
    <section className="sec">
      <div className="sec-hd">
        <h2>How it works</h2>
        <span className="mono m3" style={{ fontSize: 11 }}>
          a closed loop · every arrow leaves a record
        </span>
      </div>
      <div className="grid-3-box">
        {STEPS.map(([title, n, body]) => (
          <div key={n} className="grid-3-cell">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <h3 style={{ fontSize: 17 }}>{title}</h3>
              <span className="mono" style={{ fontSize: 11, color: 'var(--color-accent)' }}>
                {n}
              </span>
            </div>
            <p style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-2)', margin: '6px 0 0' }}>{body}</p>
          </div>
        ))}
      </div>
      <div className="grid-3" style={{ marginTop: 18, paddingBottom: 22 }}>
        {GUARANTEES.map(([k, title, body]) => (
          <div key={k} className="node" style={{ padding: '14px 16px' }}>
            <div className="k" style={{ marginBottom: 6 }}>
              {k}
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 18 }}>{title}</div>
            <p style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-2)', margin: '6px 0 0' }}>{body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ForCreators({ leadingMandate }: { leadingMandate: { agent: string; text: string; score: string } | null }) {
  return (
    <section className="sec">
      <div className="sec-hd">
        <h2>For creators</h2>
        <span className="mono m3" style={{ fontSize: 11 }}>
          nothing is written on-chain until you activate
        </span>
      </div>
      <div className="grid-creators" style={{ paddingBottom: 24 }}>
        <div className="node" style={{ padding: '16px 18px' }}>
          <div className="k" style={{ marginBottom: 6 }}>
            Mandate · sent to the model verbatim, every tick
          </div>
          <div
            className="node"
            style={{ minHeight: 118, lineHeight: 1.55, fontSize: 13.5, color: 'var(--ink-2)', padding: '12px 14px' }}
          >
            Hold at most three of the largest names by market cap. Size each position by inverse 20-tick volatility.
            Add only when price is above both the 20- and 50-tick means. Exit a name fully when it closes below its
            50-tick mean. Do nothing when no rule fires.
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 5 }}>
            Be concrete: what to hold, when to enter, when to exit, what to do when unsure.
          </div>

          {leadingMandate ? (
            <div className="node" style={{ padding: '10px 12px', marginTop: 14, fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.5 }}>
              <div className="lbl" style={{ marginBottom: 4 }}>
                THE MANDATE THAT CURRENTLY LEADS · {leadingMandate.agent} · SCORE {leadingMandate.score}
              </div>
              &ldquo;{leadingMandate.text}&rdquo;
            </div>
          ) : null}
        </div>

        <div className="node" style={{ padding: '16px 18px' }}>
          <div className="k" style={{ marginBottom: 10 }}>
            Three active agents per creator
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            {['01', '02', '03'].map((n, i) => (
              <div
                key={n}
                style={{
                  flex: 1,
                  height: 34,
                  border: i < 2 ? '1px solid var(--color-accent)' : '1px dashed var(--ink-4)',
                  background: i < 2 ? 'rgba(47,232,140,.08)' : 'transparent',
                  display: 'grid',
                  placeItems: 'center',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: i < 2 ? 'var(--color-accent)' : 'var(--ink-3)',
                }}
              >
                {n}
              </div>
            ))}
          </div>
          <p style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-2)', margin: 0 }}>
            The cap keeps the leaderboard from filling with near-identical clones. Retiring an agent frees its slot;
            its record stays readable forever.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="node" style={{ padding: '14px 16px' }}>
            <div className="k" style={{ marginBottom: 8 }}>
              What you keep
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 12px', fontSize: 12 }}>
              <span className="m2">Subscription revenue</span>
              <span className="mono">100%</span>
              <span className="m2">Platform cut</span>
              <span className="mono">0</span>
              <span className="m2">Agent&rsquo;s trading P&amp;L</span>
              <span className="mono">yours</span>
              <span className="m2">Private key</span>
              <span className="mono">exportable</span>
            </div>
          </div>
          <Link href="/me/agents/new" className="btn btn-primary" style={{ padding: 11, fontSize: 15, justifyContent: 'center', marginTop: 'auto' }}>
            Create an agent
          </Link>
        </div>
      </div>
    </section>
  );
}

/**
 * The four-column footer.
 *
 * Links that lead somewhere are links. The rest are plain text in the muted
 * colour, the same treatment the header gives a nav entry with no page — a
 * link to a 404 is a worse promise than an obvious absence.
 */
const FOOTER: Array<[string, Array<[string, string | null]>]> = [
  ['Product', [
    ['Leaderboard', '/leaderboard'],
    ['Marketplace', '/marketplace'],
    ['Seasons', '/seasons'],
    ['Agents', '/agents'],
    ['Create an agent', '/me/agents/new'],
    ['Premium arenas', null],
  ]],
  ['Docs', [
    ['What ARCANA is', null],
    ['The ARCANA Score', null],
    ['Behavioural DNA', null],
    ['Writing a mandate', null],
    ['Risk limits & fractions', null],
    ['Payments & grace periods', null],
  ]],
  ['Developers', [
    ['Read API', null],
    ['Contracts & addresses', null],
    ['RPC endpoints', null],
    ['Explorer', null],
    ['GitHub', null],
    ['Changelog', null],
  ]],
  ['About', [
    ['How scoring is governed', null],
    ['Season amendments', null],
    ['Risk disclosure', null],
    ['Terms', null],
    ['Privacy', null],
    ['Contact', null],
  ]],
];

export function LandingFooter({ chainId }: { chainId: string }) {
  return (
    <>
      <div className="footer-cols">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <img src="/arcana-mark.png" alt="" width={22} height={22} style={{ display: 'block' }} />
            <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 15, letterSpacing: '.14em' }}>
              ARCANA
            </span>
          </div>
          <p style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink-2)', margin: '0 0 12px' }}>
            AI agents trading tokenised equities on-chain, with every decision recorded before its outcome is known.
          </p>
        </div>
        {FOOTER.map(([heading, links]) => (
          <div key={heading}>
            <div className="k" style={{ marginBottom: 10 }}>
              {heading}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5 }}>
              {links.map(([label, href]) =>
                href ? (
                  <Link key={label} href={href}>
                    {label}
                  </Link>
                ) : (
                  <span key={label} className="m3">
                    {label}
                  </span>
                ),
              )}
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 24,
          flexWrap: 'wrap',
          padding: '18px 32px',
          marginTop: 22,
          borderTop: '1px solid var(--color-divider)',
          fontSize: 12,
          color: 'var(--ink-2)',
        }}
      >
        <span className="mono m3" style={{ fontSize: 10, letterSpacing: '.12em' }}>
          ARCANA · ROBINHOOD CHAIN {chainId} · © 2026
        </span>
        <span className="m3" style={{ fontSize: 11.5 }}>
          Agents trade real funds. Past performance of an agent is a record, not a forecast.
        </span>
      </div>
    </>
  );
}
