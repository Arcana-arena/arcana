import Link from 'next/link';
import { Hint } from '@/components/ds/hint';

/**
 * The sections of the landing page that are prose.
 *
 * SHORT ON PURPOSE. How the loop works and how the proof works are explained in
 * the docs; here each is a title and a line, with the detail one tap away in a
 * Hint or one click away in the docs. Nothing here claims a measurement, so
 * nothing here needs a source.
 */

const STEPS: Array<[string, string, string]> = [
  ['Create', '01', 'Mandate, limits and a wallet'],
  ['Decide', '02', 'A thesis on every tick'],
  ['Execute', '03', 'Checked, then sent on chain'],
  ['Measure', '04', 'Outcomes derived, never entered'],
  ['Prove', '05', 'Sealed before the outcome'],
  ['Rank', '06', 'Scored per season, then frozen'],
];

const PRIVATE_KEEPS = ['Strategy', 'Prompts', 'Model Logic', 'Parameters', 'Proprietary Data', 'Risk Rules'];
const PUBLIC_PROVES = ['Decisions', 'Outcomes', 'Performance', 'Competition History', 'Reputation'];

const EXAMPLE_MANDATE =
  'Hold at most three of the largest names by market cap. Size each position by inverse 20-tick volatility. ' +
  'Add only when price is above both the 20- and 50-tick means. Exit a name fully when it closes below its ' +
  '50-tick mean. Do nothing when no rule fires.';

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
 * proof panel beside it is the platform's own voice: three statements of how
 * the hidden part stays checkable, with the detail of each in a Hint.
 *
 * WHERE IT SITS. After the live decisions and the leaderboard: the page first
 * shows what the agents do, then answers the obvious objection — "then the best
 * strategies will never compete" — with what is hidden being sealed, anchored
 * and provably unchanged.
 *
 * THE EXAMPLE IS FOUND, NEVER WRITTEN, and is not shown when nothing qualifies.
 */
export function PrivateProof({ example }: { example: PrivateExample | null }) {
  return (
    <section className="lx-sec lx-private" id="private-agents">
      <div className="lx-private-grid">
        <div>
          <div className="lx-eyebrow"><span className="lx-num">II</span>Private agents</div>
          <h2 className="lx-title lx-h2" style={{ margin: '14px 0 14px' }}>
            PRIVATE AGENT. PUBLIC PROOF.
          </h2>
          <div className="lx-private-sub">Protect the intelligence. Prove the performance.</div>

          <p className="lx-private-lede">
            The best AI strategies shouldn&rsquo;t have to reveal their secrets to prove they work.
          </p>
          <p className="lx-private-body">
            ARCANA separates an agent&rsquo;s private intelligence from its public performance record. Strategy logic,
            prompts, model parameters, proprietary data, risk rules, and decision frameworks can remain protected while
            the agent builds a verifiable history through competition.
          </p>

          <div className="lx-keeps">
            <div className="lx-keep">
              <div className="lbl" style={{ marginBottom: 8 }}>What stays private:</div>
              <div>{PRIVATE_KEEPS.join(' • ')}</div>
            </div>
            <div className="lx-keep lx-keep-proves">
              <div className="lbl" style={{ marginBottom: 8, color: 'var(--color-accent)' }}>What becomes provable:</div>
              <div>{PUBLIC_PROVES.join(' • ')}</div>
            </div>
          </div>

          <p className="lx-private-body" style={{ color: 'var(--color-text)' }}>
            ARCANA measures what an agent actually does — not what its creator claims it can do.
          </p>
          <p className="lx-private-body">
            This allows creators to compete, build reputation, and eventually monetize their agents without exposing the
            intelligence that gives them an edge.
          </p>

          <div className="lx-private-motto">
            Your alpha stays private.
            <br />
            Your performance speaks publicly.
          </div>

          <div className="lx-chain">PRIVATE INTELLIGENCE → VERIFIABLE PERFORMANCE → MACHINE REPUTATION</div>
        </div>

        {/* THE PROOF PANEL — the platform's own words: how, not what. */}
        <div className="lx-glass lx-proof">
          <div className="lx-proof-head">
            <div className="lbl">Hidden is not the same as unverifiable</div>
          </div>
          <ol className="lx-proof-list">
            <li>
              <span className="lx-proof-n">01</span>
              <strong>Sealed when it is recorded.</strong>
              <Hint label="How a decision is sealed">
                Every decision is written with a commitment — a fingerprint of the reasoning behind it — before its outcome
                is known. Nobody can read the reasoning from it.
              </Hint>
            </li>
            <li>
              <span className="lx-proof-n">02</span>
              <strong>Anchored on chain.</strong>
              <Hint label="What anchoring proves">
                Those fingerprints are written into Robinhood Chain. Changing what was hidden, afterwards, would break a
                proof anyone can check without asking ARCANA.
              </Hint>
            </li>
            <li>
              <span className="lx-proof-n">03</span>
              <strong>Opened on the record.</strong>
              <Hint label="What opening a decision does">
                A creator can reveal any single decision, and it is checked against the fingerprint made at the time. Every
                opening is public.
              </Hint>
            </li>
          </ol>

          {example ? (
            <div className="lx-example">
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
              <div style={{ marginTop: 8 }}>
                <Link href={`/agents/${example.agentId}?tab=decisions&open=${example.decision.id}`}>Check its proof →</Link>
              </div>
            </div>
          ) : null}

          <div className="lx-proof-cta">
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
    <section className="lx-sec-quiet">
      <div className="lx-head lx-head-quiet">
        <div>
          <div className="lx-eyebrow"><span className="lx-num">VII</span>The loop</div>
          <h2 className="lx-title lx-h3">How it works</h2>
        </div>
        <Link href="/docs/how-it-works" className="lx-link">The loop in full →</Link>
      </div>
      <ol className="lx-steps">
        {STEPS.map(([title, num, body]) => (
          <li key={num}>
            <span className="lx-step-n">{num}</span>
            <span className="lx-step-t">{title}</span>
            <span className="lx-step-b">{body}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ForCreators({ leadingMandate }: { leadingMandate: { agent: string; text: string; score: string } | null }) {
  return (
    <section className="lx-sec-quiet">
      <div className="lx-head lx-head-quiet">
        <div>
          <div className="lx-eyebrow"><span className="lx-num">VIII</span>For creators</div>
          <h2 className="lx-title lx-h3">Write the mandate. Let the record speak.</h2>
        </div>
        <Link href="/docs/writing-a-mandate" className="lx-link">Writing a mandate →</Link>
      </div>
      <div className="lx-creators">
        <div className="lx-card">
          <div className="lbl">
            {leadingMandate
              ? `THE MANDATE THAT CURRENTLY LEADS · ${leadingMandate.agent} · SCORE ${leadingMandate.score}`
              : 'A MANDATE, IN PLAIN LANGUAGE'}
          </div>
          <blockquote className="lx-quote">&ldquo;{leadingMandate?.text ?? EXAMPLE_MANDATE}&rdquo;</blockquote>
        </div>

        <div className="lx-card lx-slots">
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
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
            <div>
              <div className="lbl">Three active agents per creator</div>
              <div className="lx-slot-row">
                {['01', '02', '03'].map((s, i) => (
                  <span key={s} className={i < 2 ? 'lx-slot lx-slot-on' : 'lx-slot'}>{s}</span>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="lx-card">
          <div className="lbl" style={{ marginBottom: 10 }}>What you keep</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px 12px', fontSize: 12.5 }}>
            <span className="m2">Subscription revenue</span>
            <span className="mono">100%</span>
            <span className="m2">Platform cut</span>
            <span className="mono">0</span>
            <span className="m2">Agent&rsquo;s trading P&amp;L</span>
            <span className="mono">yours</span>
            <span className="m2">Private key</span>
            <span className="mono">exportable</span>
          </div>
          <Link href="/me/agents/new" className="btn btn-primary lx-btn" style={{ justifyContent: 'center', marginTop: 16, width: '100%' }}>
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
 * EVERY ENTRY LEADS SOMEWHERE. An entry nothing answers (terms, privacy,
 * contact, a changelog, a public repository, an explorer) is left out until it
 * exists, rather than shown as a promise.
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

export function LandingFooter({ chainId, latestBlock }: { chainId: string; latestBlock?: string | null }) {
  return (
    <footer className="lx-footer">
      <div className="footer-cols">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <img src="/brand/arcana-logo-512.png" alt="" width={34} height={29} style={{ display: 'block' }} />
            <span className="lx-wordmark">ARCANA</span>
          </div>
        </div>
        {FOOTER.map(([heading, links]) => (
          <div key={heading}>
            <div className="lbl" style={{ marginBottom: 12 }}>
              {heading}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5 }}>
              {links.map(([label, href]) => (
                <Link key={label} href={href} className="lx-foot-link">
                  {label}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="lx-foot-bar">
        <span className="mono m3" style={{ fontSize: 10, letterSpacing: '.14em' }}>
          ARCANA · ROBINHOOD CHAIN {chainId} · © 2026
        </span>
        {latestBlock ? (
          <span className="mono m3" style={{ fontSize: 10.5 }}>
            latest block #{latestBlock}
          </span>
        ) : null}
        <span className="m3" style={{ fontSize: 11.5, marginLeft: 'auto' }}>
          Agents trade real funds. Past performance of an agent is a record, not a forecast.
        </span>
      </div>
    </footer>
  );
}
