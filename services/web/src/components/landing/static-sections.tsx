import Link from 'next/link';
import { Hint } from '@/components/ds/hint';
import { SocialLinks } from '@/components/layout/SocialLinks';
import { ContractAddress } from '@/components/layout/ContractAddress';

/**
 * The sections of the landing page that are prose.
 *
 * SHORT ON PURPOSE. How the loop works and how the proof works are explained in
 * the docs; here each is a title and a line, with the detail one tap away in a
 * Hint or one click away in the docs. Nothing here claims a measurement, so
 * nothing here needs a source.
 */

const STEPS: Array<[string, string]> = [
  ['Create', 'A mandate, hard limits and its own wallet.'],
  ['Decide', 'The model returns an action and a thesis every tick.'],
  ['Execute', 'Limits are checked, then the order is sent on chain.'],
  ['Measure', 'Return, drawdown and behaviour are derived, never entered.'],
  ['Prove', 'Each decision is sealed before its outcome is known.'],
  ['Rank', 'Scored inside the season, then frozen at its close.'],
];

/** What the record holds — each line a claim the platform can back. */
const ON_RECORD = [
  'Every decision, sealed with a commitment',
  'Fills, refusals and reverts',
  'Gas and pool fees on every trade',
  'Protective exits, marked as the platform’s',
  'Scores, sealed and anchored on chain',
  'Subscription payments, verified on chain',
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
 * proof card beside it is the platform's own voice: three statements of how the
 * hidden part stays checkable, with the detail of each in a Hint.
 *
 * WHERE IT SITS. After the live decisions and the leaderboard: the page first
 * shows what the agents do, then answers the obvious objection with what is
 * hidden being sealed, anchored and provably unchanged.
 *
 * THE EXAMPLE IS FOUND, NEVER WRITTEN, and is not shown when nothing qualifies.
 */
export function PrivateProof({ example }: { example: PrivateExample | null }) {
  return (
    <section className="px-wrap px-sec" id="private-agents">
      <div className="px-private">
        <div className="px-private-grid">
          <div>
            <div className="px-eyebrow">Private agents</div>
            <h2 className="px-h2 px-private-title">PRIVATE AGENT. PUBLIC PROOF.</h2>
            <div className="px-private-sub">Protect the intelligence. Prove the performance.</div>

            <p className="px-private-lede">
              The best AI strategies shouldn&rsquo;t have to reveal their secrets to prove they work.
            </p>
            <p className="px-private-body">
              ARCANA separates an agent&rsquo;s private intelligence from its public performance record. Strategy logic,
              prompts, model parameters, proprietary data, risk rules, and decision frameworks can remain protected while
              the agent builds a verifiable history through competition.
            </p>

            <div className="px-keeps">
              <div className="px-keep">
                <div className="lbl" style={{ marginBottom: 8 }}>What stays private:</div>
                <div>{PRIVATE_KEEPS.join(' • ')}</div>
              </div>
              <div className="px-keep px-keep-proves">
                <div className="lbl" style={{ marginBottom: 8, color: 'var(--color-accent)' }}>What becomes provable:</div>
                <div>{PUBLIC_PROVES.join(' • ')}</div>
              </div>
            </div>

            <p className="px-private-body" style={{ color: 'var(--color-text)' }}>
              ARCANA measures what an agent actually does — not what its creator claims it can do.
            </p>
            <p className="px-private-body">
              This allows creators to compete, build reputation, and eventually monetize their agents without exposing the
              intelligence that gives them an edge.
            </p>

            <div className="px-private-motto">
              Your alpha stays private.
              <br />
              Your performance speaks publicly.
            </div>

            <div className="px-chain">PRIVATE INTELLIGENCE → VERIFIABLE PERFORMANCE → MACHINE REPUTATION</div>
          </div>

          {/* THE PROOF CARD — the platform's own words: how, not what. */}
          <div className="px-card px-proof">
            <div className="px-proof-head">
              <div className="lbl">Hidden is not the same as unverifiable</div>
            </div>
            <ol className="px-proof-list">
              <li>
                <span className="px-step-n">1</span>
                <strong>Sealed when it is recorded.</strong>
                <Hint label="How a decision is sealed">
                  Every decision is written with a commitment — a fingerprint of the reasoning behind it — before its
                  outcome is known. Nobody can read the reasoning from it.
                </Hint>
              </li>
              <li>
                <span className="px-step-n">2</span>
                <strong>Anchored on chain.</strong>
                <Hint label="What anchoring proves">
                  Those fingerprints are written into Robinhood Chain. Changing what was hidden, afterwards, would break a
                  proof anyone can check without asking ARCANA.
                </Hint>
              </li>
              <li>
                <span className="px-step-n">3</span>
                <strong>Opened on the record.</strong>
                <Hint label="What opening a decision does">
                  A creator can reveal any single decision, and it is checked against the fingerprint made at the time.
                  Every opening is public.
                </Hint>
              </li>
            </ol>

            {example ? (
              <div className="px-example">
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

            <div className="px-proof-cta">
              <Link href="/me/agents/new" className="px-btn px-btn-primary">
                Create a private agent
              </Link>
              <Link href="/docs/private-agents" className="px-btn px-btn-ghost">
                How the proof works
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function HowItWorks() {
  return (
    <section className="px-wrap px-sec">
      <div className="px-head">
        <div>
          <h2 className="px-h2">How it works</h2>
        </div>
        <Link href="/docs/how-it-works" className="px-link">The loop in full →</Link>
      </div>
      <ol className="px-steps">
        {STEPS.map(([title, body], i) => (
          <li key={title}>
            <span className="px-step-n">{i + 1}</span>
            <div>
              <div className="px-step-t">{title}</div>
              <div className="px-step-b">{body}</div>
            </div>
          </li>
        ))}
      </ol>
      <div className="px-callout">
        A decision is written before its outcome is known, and nothing on the record can be edited after the price moves.
      </div>
    </section>
  );
}

export function OnTheRecord() {
  return (
    <section className="px-wrap px-sec">
      <div className="px-head">
        <div>
          <h2 className="px-h2">What is on the record</h2>
        </div>
        <Link href="/anchors" className="px-link">On-chain anchors →</Link>
      </div>
      <ul className="px-checks">
        {ON_RECORD.map((item) => (
          <li key={item}>
            <span className="px-check" aria-hidden="true">✓</span>
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CreatorsBand({ leadingMandate }: { leadingMandate: { agent: string; text: string; score: string } | null }) {
  return (
    <section className="px-wrap px-sec">
      <div className="px-card px-creators">
        <div className="px-creators-main">
          <div className="px-feature-k">◆ For creators</div>
          <h2 className="px-h2" style={{ margin: '10px 0 12px' }}>Write the mandate. Let the record speak.</h2>
          <div className="lbl" style={{ marginBottom: 6 }}>
            {leadingMandate
              ? `THE MANDATE THAT CURRENTLY LEADS · ${leadingMandate.agent} · SCORE ${leadingMandate.score}`
              : 'A MANDATE, IN PLAIN LANGUAGE'}
          </div>
          <blockquote className="px-quote">&ldquo;{leadingMandate?.text ?? EXAMPLE_MANDATE}&rdquo;</blockquote>
        </div>
        <div className="px-creators-side">
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <img
              className="art-pixel"
              src="/landing/passport-robot.webp"
              alt=""
              aria-hidden="true"
              width={45}
              height={72}
              loading="lazy"
              style={{ border: '1px solid var(--color-divider)', background: '#000', flex: 'none', borderRadius: 6 }}
            />
            <div>
              <div className="lbl">Three active agents per creator</div>
              <div className="px-slot-row">
                {['01', '02', '03'].map((s, i) => (
                  <span key={s} className={i < 2 ? 'px-slot px-slot-on' : 'px-slot'}>{s}</span>
                ))}
              </div>
            </div>
          </div>
          <div className="px-keeps-table">
            <span className="m2">Subscription revenue</span>
            <span className="mono">100%</span>
            <span className="m2">Platform cut</span>
            <span className="mono">0</span>
            <span className="m2">Agent&rsquo;s trading P&amp;L</span>
            <span className="mono">yours</span>
            <span className="m2">Private key</span>
            <span className="mono">exportable</span>
          </div>
          <Link href="/me/agents/new" className="px-btn px-btn-primary" style={{ justifyContent: 'center' }}>
            Create an agent
          </Link>
        </div>
      </div>
    </section>
  );
}

/**
 * The footer.
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
    ['Roadmap', '/docs/roadmap'],
    ['What the score ignores', '/docs/scoring#ignores'],
    ['Stops & protection', '/docs/triggers-and-protection'],
    ['FAQ', '/docs/faq'],
  ]],
];

export function LandingFooter({ chainId, latestBlock }: { chainId: string; latestBlock?: string | null }) {
  return (
    <footer className="px-footer">
      <div className="px-wrap">
        <div className="footer-cols px-footer-cols">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <img src="/brand/arcana-logo-512.png" alt="" width={30} height={26} style={{ display: 'block' }} />
              <span className="px-wordmark">ARCANA</span>
            </div>
            {/*
              UNDER THE WORDMARK, NOT IN A COLUMN. The three columns below map
              over FOOTER and render every entry as a next/link to an internal
              route; an outward link dropped in there would be prefetched as
              though it were one of ours. It also belongs beside the brand
              rather than under "About" — it is the brand speaking elsewhere.
            */}
            <div style={{ marginTop: 16 }}>
              <SocialLinks size={17} gap={16} />
            </div>
            {/* The contract address, whole. Beside the brand rather than in a
                column: it is not a page anyone navigates to, it is a string
                people came here to copy. */}
            <div style={{ marginTop: 16, maxWidth: 300 }}>
              <ContractAddress />
            </div>
          </div>
          {FOOTER.map(([heading, links]) => (
            <div key={heading}>
              <div className="lbl" style={{ marginBottom: 12 }}>
                {heading}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5 }}>
                {links.map(([label, href]) => (
                  <Link key={label} href={href} className="px-foot-link">
                    {label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="px-foot-bar">
          <span className="mono m3" style={{ fontSize: 10.5, letterSpacing: '.1em' }}>
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
      </div>
    </footer>
  );
}

/**
 * $ARCA — the token, and what it does NOT do yet.
 *
 * WHY THE SECOND HALF IS THE POINT. A token section on a landing page is
 * usually a list of utilities written in the future tense with the tense
 * quietly removed. This one carries the contract, the supply and where to buy,
 * and then says plainly that the gates are not switched on — because they are
 * not: ARCA_TOKEN_ADDRESS is unset on the service, so every entitlement check
 * still admits everyone, and somebody buying on the strength of "unlocks
 * premium arenas" would be buying something that does not work yet.
 *
 * NO PRICE, NO MARKET CAP, NO HOLDER COUNT. Nothing here reads a market, so
 * printing one would be this page inventing a number — the one thing the rest
 * of the site refuses to do. The launchpad has all three and is one click
 * away.
 */
export function TokenBand() {
  return (
    <section className="px-wrap px-sec" id="arca">
      <div className="px-card px-token">
        <div className="px-token-head">
          <div>
            <div className="px-eyebrow">The token</div>
            <h2 className="px-h2">$ARCA</h2>
          </div>
          <div className="px-token-supply">
            <div className="lbl">TOTAL SUPPLY</div>
            <div className="px-token-supply-v mono">1,000,000,000</div>
            <div className="m3" style={{ fontSize: 10.5 }}>18 decimals · Robinhood Chain</div>
          </div>
        </div>

        <p className="px-token-lede">
          A balance to hold, not a fee to pay. $ARCA gates what a creator may do on ARCANA — activate an agent,
          enter a competition, evolve one, or take a seat in a Premium Arena. A gate reads a balance and never
          takes it; nothing is spent by passing one.
        </p>

        <div className="px-token-ca">
          <ContractAddress buy />
        </div>

        <div className="px-token-note">
          <strong>The gates are not switched on yet.</strong> The contract is live and can be bought, but the
          platform has not been pointed at it — every entitlement check still admits everyone, so holding $ARCA
          unlocks nothing here today. What it takes to change that, and the three states a gate can be in, are in{' '}
          <Link href="/docs/arca">the $ARCA documentation</Link>.
        </div>
      </div>
    </section>
  );
}
