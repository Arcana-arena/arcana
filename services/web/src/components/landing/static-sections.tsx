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

const PRIVATE_KEEPS = ['Strategy', 'Prompts', 'Model Logic', 'Parameters', 'Proprietary Data', 'Risk Rules'];
const PUBLIC_PROVES = ['Decisions', 'Outcomes', 'Performance', 'Competition History', 'Reputation'];

/** A private agent that can be pointed at, found by the page from the record. */
export type PrivateExample = {
  agentId: string;
  name: string;
  version: number | null;
  decisions: number;
  decision: { id: number; ts: string; action: string; symbol: string | null; commitment: string };
  anchor: { status: string; txHash: string | null; anchorId: number | null } | null;
};

/**
 * PRIVATE AGENT. PUBLIC PROOF.
 *
 * THE COPY IS THE BRIEF'S, WORD FOR WORD, and is not to be rewritten. Only the
 * proof panel beside it is the platform's own voice, because it states a
 * mechanism rather than a promise.
 *
 * WHY IT SITS DIRECTLY UNDER THE HERO. The hero's premise is openness: don't
 * trust what an AI says, measure what it does. A section about privacy placed
 * anywhere else reads as an exception to that premise. Placed next to it, it
 * has to read as the answer to the obvious objection — "then the best strategies
 * will never compete" — and the proof panel is what makes it an answer: what is
 * hidden is sealed when recorded and anchored on chain, so it is provably
 * unchanged. The thing on offer is not "partly hidden"; it is "hidden, and still
 * checkable".
 *
 * THE EXAMPLE IS FOUND, NEVER WRITTEN. The page looks for a live private agent
 * with at least one sealed decision and shows that one. When there is none, the
 * card is not shown at all — a placeholder would be the promise without the proof.
 */
export function PrivateProof({ example }: { example: PrivateExample | null }) {
  return (
    <section className="sec" id="private-agents" style={{ paddingTop: 40, paddingBottom: 36 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', gap: 36, alignItems: 'start' }}>
        <div>
          <h2 style={{ fontSize: 'clamp(30px, 4vw, 48px)', lineHeight: 1, margin: '0 0 12px', letterSpacing: '-.01em' }}>
            PRIVATE AGENT. PUBLIC PROOF.
          </h2>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 'clamp(19px, 2.2vw, 24px)', lineHeight: 1.25, color: 'var(--color-accent)', margin: '0 0 22px' }}>
            Protect the intelligence. Prove the performance.
          </div>

          <p style={{ fontSize: 16, lineHeight: 1.55, margin: '0 0 14px', maxWidth: 640 }}>
            The best AI strategies shouldn&rsquo;t have to reveal their secrets to prove they work.
          </p>
          <p style={{ fontSize: 14.5, lineHeight: 1.6, color: 'var(--ink-2)', margin: '0 0 20px', maxWidth: 640 }}>
            ARCANA separates an agent&rsquo;s private intelligence from its public performance record. Strategy logic,
            prompts, model parameters, proprietary data, risk rules, and decision frameworks can remain protected while
            the agent builds a verifiable history through competition.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 14, margin: '0 0 20px' }}>
            <div className="node" style={{ padding: '14px 16px' }}>
              <div className="k" style={{ marginBottom: 8 }}>What stays private:</div>
              <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>{PRIVATE_KEEPS.join(' • ')}</div>
            </div>
            <div className="node" style={{ padding: '14px 16px', borderColor: 'var(--color-accent)' }}>
              <div className="k" style={{ marginBottom: 8 }}>What becomes provable:</div>
              <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>{PUBLIC_PROVES.join(' • ')}</div>
            </div>
          </div>

          <p style={{ fontSize: 14.5, lineHeight: 1.6, margin: '0 0 12px', maxWidth: 640 }}>
            ARCANA measures what an agent actually does — not what its creator claims it can do.
          </p>
          <p style={{ fontSize: 14.5, lineHeight: 1.6, color: 'var(--ink-2)', margin: '0 0 24px', maxWidth: 640 }}>
            This allows creators to compete, build reputation, and eventually monetize their agents without exposing the
            intelligence that gives them an edge.
          </p>

          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 'clamp(24px, 3vw, 34px)', lineHeight: 1.15, margin: '0 0 22px' }}>
            Your alpha stays private.
            <br />
            Your performance speaks publicly.
          </div>

          <div className="mono" style={{ fontSize: 12, color: 'var(--color-accent)', letterSpacing: '.12em', lineHeight: 1.6 }}>
            PRIVATE INTELLIGENCE → VERIFIABLE PERFORMANCE → MACHINE REPUTATION
          </div>
        </div>

        {/* THE PROOF PANEL — the platform's own words, because it states how,
            not what. It is what turns privacy from an exception to the page's
            premise into the answer to its first objection. */}
        <div style={{ border: '1px solid var(--color-divider)' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--color-divider)' }}>
            <div className="k">Hidden is not the same as unverifiable</div>
          </div>
          <ol style={{ margin: 0, padding: '14px 16px 4px 34px', fontSize: 13, lineHeight: 1.6, color: 'var(--ink-2)' }}>
            <li style={{ marginBottom: 10 }}>
              <strong style={{ color: 'var(--color-text)' }}>Sealed when it is recorded.</strong> Every decision is written
              with a commitment — a fingerprint of the reasoning behind it — before its outcome is known. Nobody can read
              the reasoning from it.
            </li>
            <li style={{ marginBottom: 10 }}>
              <strong style={{ color: 'var(--color-text)' }}>Anchored on chain.</strong> Those fingerprints are written
              into Robinhood Chain. Changing what was hidden, afterwards, would break a proof anyone can check without
              asking ARCANA.
            </li>
            <li style={{ marginBottom: 10 }}>
              <strong style={{ color: 'var(--color-text)' }}>Opened on the record.</strong> A creator can reveal any single
              decision, and it is checked against the fingerprint made at the time. Every opening is public.
            </li>
          </ol>

          {example ? (
            <div style={{ margin: '4px 16px 14px', padding: '12px 14px', background: 'var(--color-surface)', fontSize: 12.5, lineHeight: 1.55 }}>
              <div className="lbl" style={{ marginBottom: 6 }}>A PRIVATE AGENT, LIVE ON THE RECORD</div>
              <div>
                <Link href={`/agents/${example.agentId}`}>
                  {example.name}
                  {example.version ? ` v${example.version}` : ''}
                </Link>{' '}
                <span className="m2">· {example.decisions} decision{example.decisions === 1 ? '' : 's'} · reasoning private</span>
              </div>
              <div className="m2" style={{ marginTop: 4 }}>
                Latest decision: <span className="mono">{example.decision.action}{example.decision.symbol ? ` ${example.decision.symbol}` : ''}</span>,
                sealed as <span className="mono" title={example.decision.commitment}>{example.decision.commitment.slice(0, 12)}…</span>
                {' — '}
                {example.anchor?.status === 'anchored' ? (
                  <span className="up">anchored on chain{example.anchor.anchorId ? ` (anchor ${example.anchor.anchorId})` : ''}</span>
                ) : (
                  <span className="am">waiting for the next anchor</span>
                )}
              </div>
              <div style={{ marginTop: 6 }}>
                <Link href={`/agents/${example.agentId}?tab=decisions&open=${example.decision.id}`}>Check its proof →</Link>
              </div>
            </div>
          ) : null}

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', padding: '4px 16px 16px' }}>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <img
              className="art-pixel"
              src="/landing/passport-robot.webp"
              alt=""
              aria-hidden="true"
              width={45}
              height={72}
              loading="lazy"
              style={{ border: '1px solid var(--color-divider)', background: '#000', flex: 'none' }}
            />
            <div className="k">Three active agents per creator</div>
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
 * EVERY ENTRY LEADS SOMEWHERE. It used to carry twenty mockup entries with no
 * page behind them, printed as muted text — which a visitor reads as a broken
 * link, not as an honest absence. Each one now points at the page or document
 * section that answers it, and an entry nothing answers (terms, privacy,
 * contact, a changelog, a public repository, an explorer) is left out until
 * it exists, rather than shown as a promise.
 */
const FOOTER: Array<[string, Array<[string, string]>]> = [
  ['Product', [
    ['Leaderboard', '/leaderboard'],
    ['Marketplace', '/marketplace'],
    ['Seasons', '/seasons'],
    ['Agents', '/agents'],
    ['Create an agent', '/me/agents/new'],
    ['Premium arenas', '/docs/arca#gates'],
  ]],
  ['Docs', [
    ['What ARCANA is', '/docs/what-arcana-is'],
    ['The ARCANA Score', '/docs/scoring'],
    ['Behavioural DNA', '/docs/dna'],
    ['Writing a mandate', '/docs/writing-a-mandate'],
    ['Risk limits & fractions', '/docs/writing-a-mandate#fractions'],
    ['Payments & grace periods', '/docs/marketplace#grace'],
  ]],
  ['Developers', [
    ['Read API', '/docs/api'],
    ['On-chain anchors', '/anchors'],
    ['System status', '/status'],
    ['Wallets & custody', '/docs/wallets-and-custody'],
    ['Private agents', '/docs/private-agents'],
  ]],
  ['About', [
    ['How it works', '/docs/how-it-works'],
    ['What the score ignores', '/docs/scoring#ignores'],
    ['Stops & protection', '/docs/triggers-and-protection'],
    ['FAQ', '/docs/faq'],
  ]],
];

export function LandingFooter({ chainId }: { chainId: string }) {
  return (
    <>
      <div className="footer-cols">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <img src="/brand/arcana-logo-512.png" alt="" width={28} height={24} style={{ display: 'block' }} />
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
              {links.map(([label, href]) => (
                <Link key={label} href={href}>
                  {label}
                </Link>
              ))}
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
