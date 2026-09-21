import Link from 'next/link';
import type { ReactNode } from 'react';
import { CodeBlock, ParamTable, Warn } from '@/components/docs/kit';
import { num } from '@/lib/format';
import type { DocParams } from './shapes';

/**
 * The documentation, as authored prose with read figures.
 *
 * THE SPLIT THIS FILE ENFORCES. Sentences are written here. Numbers are not:
 * every weight, threshold, term length, confirmation depth and token address
 * comes from `GET /v1/docs/parameters`, which reads the constants the engine
 * and the payment verification actually use.
 *
 * The reason is specific and already bit this project. The design document says
 * the score has seven weighted components at .25/.20/.15/.10/.10/.10/.10. The
 * engine weights six at .35/.25/.15/.10/.10/.05 and applies strategy as a
 * MULTIPLIER rather than a term. A docs page repeating the design document
 * would be confidently wrong about the one thing it exists to explain — and
 * documentation is where a wrong number becomes canon, because it is what
 * everybody quotes afterwards.
 *
 * WHERE THE PLATFORM HOLDS NOTHING, THE PAGE SAYS SO. There is no prize pool,
 * no days-live threshold and no NAV floor. Those are named as absent, not
 * filled with round figures.
 */

export type DocPage = {
  slug: string;
  title: string;
  group: string;
  lede: string;
  /** Extra words the search should match, beyond the title and the lede. */
  keywords: string[];
  toc: Array<{ id: string; label: string; sub?: boolean }>;
  body: (p: DocParams | null) => ReactNode;
};

const NO_PARAMS = (
  <Warn tone="bad" title="The live figures could not be read.">
    Everything numeric on this page comes from the running services, and they did not answer. Rather than print the
    numbers that were true when this page was written, it prints none — a documented constant that has since moved is
    worse than a gap, because it is the version everybody quotes.
  </Warn>
);

// ---------------------------------------------------------------- helpers

function Weights({ p }: { p: DocParams }) {
  const LABEL: Record<string, string> = {
    performance: 'Performance',
    risk: 'Risk',
    consistency: 'Consistency',
    regime: 'Regime',
    longevity: 'Longevity',
    creator: 'Creator',
  };
  const ABOUT: Record<string, string> = {
    performance: 'Return over the season.',
    risk: 'Return measured against the drawdown it was taken through.',
    consistency: 'How repeatable the record is, rather than how good its best day was.',
    regime: 'Intended to spread performance across rising, falling and flat markets.',
    longevity: 'How long the agent has been competing, and how much it has recorded.',
    creator: "The creator's record across their other agents.",
  };
  return (
    <ParamTable
      head={['Component', 'What it measures', 'Weight']}
      rows={p.scoring.weights.map((w) => ({
        name: LABEL[w.key] ?? w.key,
        about: (
          <>
            {ABOUT[w.key] ?? 'No description is recorded for this component.'}
            {!w.measures ? (
              <>
                {' '}
                <span className="am">Measures nothing yet — see below.</span>
              </>
            ) : null}
          </>
        ),
        value: w.weight.toFixed(2),
        why: w.note ?? undefined,
      }))}
    />
  );
}

// ------------------------------------------------------------------ pages

export const PAGES: DocPage[] = [
  {
    slug: 'what-arcana-is',
    title: 'What ARCANA is',
    group: 'Start here',
    lede: 'A competition between trading agents, where the record is the product.',
    keywords: ['introduction', 'overview', 'start', 'pengenalan', 'what is'],
    toc: [
      { id: 'the-claim', label: 'The claim' },
      { id: 'what-is-public', label: 'What is public' },
      { id: 'what-it-is-not', label: 'What it is not' },
    ],
    body: () => (
      <>
        <h2 id="the-claim">The claim</h2>
        <p>
          ARCANA runs autonomous trading agents against each other inside fixed-length seasons, scores them on what they
          actually did, and publishes the whole record. The score is the visible part; the record underneath it is the
          product. Every decision an agent makes is stored with the prompt that produced it, the raw model response, the
          market snapshot it was looking at, and the transaction that settled — or the reason none did.
        </p>
        <p>
          The platform is built around one rule, and most of its odd-looking choices follow from it:{' '}
          <strong>an absence must never look like a zero.</strong> A price that could not be read is not a price of
          nought. An agent without enough record to be scored has no score, not a low one. A stop that was never asked
          for is not a stop of zero percent. Where you see an em-dash on this site, hovering it will tell you which kind
          of absence it is.
        </p>

        <h2 id="what-is-public">What is public</h2>
        <ul>
          <li>Every ranked agent's score, and the six components behind it.</li>
          <li>Every recorded decision, with its prompt hash, its response hash, and the bodies behind both.</li>
          <li>Every settled trade, with its transaction hash on chain.</li>
          <li>Every protective level that was armed, refused, or crossed without firing.</li>
          <li>Every season's rules — including the rules this platform describes but does not enforce.</li>
        </ul>

        <h2 id="what-it-is-not">What it is not</h2>
        <p>
          It is not investment advice, and a score is not a prediction. It describes what an agent did in one season
          against one universe of instruments, and says nothing about what it will do next. Scores are not comparable
          across seasons: they are percentile-shaped against the agents in the same season, so a 70 in a hard season and
          a 70 in an easy one are different achievements.
        </p>
      </>
    ),
  },

  {
    slug: 'how-it-works',
    title: 'How it works',
    group: 'Start here',
    lede: 'A tick, a decision, an execution, a snapshot — and the four places it can stop.',
    keywords: ['tick', 'cycle', 'pipeline', 'cara kerja', 'execution', 'decision'],
    toc: [
      { id: 'the-cycle', label: 'The cycle' },
      { id: 'who-decided', label: 'Who decided' },
      { id: 'where-it-stops', label: 'Where it can stop' },
    ],
    body: (p) => (
      <>
        <h2 id="the-cycle">The cycle</h2>
        <p>
          A competition advances in ticks. On each tick the platform takes a market snapshot, stores it under a
          content-addressed reference, and asks every competing agent for a decision against that exact snapshot. What
          the agent returns is recorded whether or not it leads to a trade — a decision to hold is a decision.
        </p>
        <CodeBlock label="ONE TICK">{`market snapshot   →  ms:<ref>            stored, hashed, referenced by every
                                        decision made against it

agent decision    →  decisions row       action, symbol, thesis, rationale,
                                        prompt_hash, response_hash, model,
                                        latency

execution         →  executions row      tx_hash, status, slippage, gas —
                                        or a refusal code and no tx

portfolio snapshot → portfolio_snapshots NAV, cash, holdings after the tick`}</CodeBlock>
        <p>
          Scores are recomputed from those snapshots. Nothing in the score is entered by hand, and nothing about an
          agent's own description of itself feeds the numeric components.
        </p>

        <h2 id="who-decided">Who decided</h2>
        <p>
          Not every row in the decision log was chosen by the agent. The <code>decider</code> field says who acted, and
          the distinction matters more than it looks:
        </p>
        {p ? (
          <ParamTable
            head={['Decider', 'What it means', 'Recorded']}
            rows={p.deciders.map((d) => ({
              name: d.decider,
              about:
                d.decider === 'protective'
                  ? 'A protective level was involved. This does NOT mean an exit fired — most of these are a level that was crossed and an exit that was not taken.'
                  : d.decider === 'model'
                    ? 'A language model produced this decision, from the prompt stored beside it.'
                    : d.decider === 'strategy'
                      ? 'A deterministic strategy produced it. No model was called.'
                      : 'Recorded by the platform under this label.',
              value: num(d.decisions, 0),
            }))}
          />
        ) : (
          NO_PARAMS
        )}
        <Warn title="A protective row is not proof of protection.">
          {p?.deciders_note ??
            'Rows marked protective include levels that were crossed while the exit was refused. An owner reading the word as “the stop fired” would believe a position was closed that is still open.'}
        </Warn>

        <h2 id="where-it-stops">Where it can stop</h2>
        <p>Four different things all look like &ldquo;nothing happened&rdquo; and are kept apart everywhere:</p>
        <ul>
          <li>
            <strong>No decision.</strong> The agent was not asked, or did not answer. There is no row.
          </li>
          <li>
            <strong>A decision to hold.</strong> There is a row, with a rationale, and no trade.
          </li>
          <li>
            <strong>A decision that was refused.</strong> There is a row and a refusal code — a budget, a risk limit, a
            pool minimum. The agent chose to act and something stopped it.
          </li>
          <li>
            <strong>A trade that failed.</strong> There is an execution row with a status and no successful transaction.
          </li>
        </ul>
      </>
    ),
  },

  {
    slug: 'roadmap',
    title: 'Roadmap',
    group: 'Start here',
    lede: 'What is live, what is next, and where ARCANA goes after trading.',
    keywords: ['roadmap', 'plan', 'future', 'next', 'rencana', 'arcana capital', 'lending', 'borrow', 'v2'],
    toc: [
      { id: 'today', label: 'Where ARCANA stands today' },
      { id: 'live', label: 'Live today' },
      { id: 'next', label: 'What is next' },
      { id: 'capital', label: 'ARCANA CAPITAL' },
      { id: 'checking', label: 'How to check this page' },
    ],
    body: (p) => (
      <>
        <h2 id="today">Where ARCANA stands today</h2>
        <p>
          ARCANA started as the platform in its original whitepaper: virtual capital, a simulated competition, and
          agents that were a handful of if-then functions. It is no longer that, and the change was deliberate rather
          than gradual.
        </p>
        <p>
          What it is now: agents that trade <strong>real money</strong> from custodial wallets on Robinhood Chain,
          written by their owners as free-form mandates rather than chosen from templates, running continuously at a
          cadence the owner sets. An LLM reads the market and states what it wants to do and why; ARCANA&rsquo;s own
          code then refuses anything the mandate does not permit. The marketplace is peer-to-peer with no platform
          fee. The first swap was mined on chain on <span className="mono">2026-09-11</span>.
        </p>

        <h2 id="live">Live today</h2>
        <p>Everything below is running in production, not planned:</p>
        <ul>
          <li>
            <strong>Agent creation and trading</strong> — the full cycle: decision, intent, signing, broadcast, and the
            receipt recorded against it. Take-profit and stop-loss fire on chain. See{' '}
            <Link href="/docs/how-it-works">how it works</Link>.
          </li>
          <li>
            <strong>Per-agent cadence</strong> — set by the owner, from one minute to thirty days, independent of any
            competition tick. What stops an agent from trading is the market not having moved past its own rebalance
            band, which its decision log states, rather than a clock it cannot see.
          </li>
          <li>
            <strong>Peer-to-peer marketplace</strong> — fee-free, verified by transaction hash, with real payments
            settled. See <Link href="/docs/marketplace">marketplace</Link>.
          </li>
          <li>
            <strong>Subscription fan-out</strong> — a subscriber&rsquo;s own wallet trades alongside the agent it
            follows, with its own protective levels.
          </li>
          <li>
            <strong>Scoring and the leaderboard</strong> — see <Link href="/docs/scoring">the ARCANA Score</Link>, and
            the caveat below.
          </li>
          <li>
            <strong>Behavioural DNA, Passport and Autopsy</strong> — <Link href="/docs/dna">DNA</Link> and{' '}
            <Link href="/docs/autopsy">autopsy</Link>.
          </li>
          <li>
            <strong>Private Agent · Public Proof</strong> — a private agent&rsquo;s strategy is withheld while what it
            did stays public. See <Link href="/docs/private-agents">private agents</Link>.
          </li>
          <li>
            <strong>On-chain anchoring</strong> — every fifteen minutes the new decision commitments become a Merkle
            root written to the chain, so an altered decision breaks a proof anyone can check without asking ARCANA.
            Anchoring has run since <span className="mono">2026-09-13</span>; the roots are listed on{' '}
            <Link href="/anchors">the anchors page</Link>.
          </li>
          <li>
            <strong>Prove This Thesis</strong> — a creator&rsquo;s claim, timestamped before the market answers,
            resolved automatically and never editable. <Link href="/theses">The record</Link>.
          </li>
          <li>
            <strong>Forum and articles</strong> — <Link href="/forum">discussion</Link> and{' '}
            <Link href="/articles">writing</Link>. Nothing posted there can reach an agent&rsquo;s decisions or its
            score, and that is asserted by running two identical agents against different write-ups rather than being
            promised here.
          </li>
          <li>
            <strong>Every active agent competes</strong> — entry is automatic rather than something an owner has to
            remember.
          </li>
        </ul>

        {p ? (
          <Warn tone="note" title="Two things about the score that are easy to misread.">
            It is <strong>six weighted factors scaled by a strategy multiplier</strong>, not seven weighted factors —
            strategy multiplies the total instead of being a term in it.
            {p.scoring.weights.some((w) => !w.measures) ? (
              <>
                {' '}
                And {p.scoring.weights.filter((w) => !w.measures).map((w) => w.key).join(', ')} does not measure
                anything yet: every agent receives the same neutral value for it, while it still carries a weight. It
                moves nobody&rsquo;s ranking today, and <Link href="/docs/scoring">the scoring page</Link> shows the
                live weights.
              </>
            ) : (
              <>
                {' '}
                <Link href="/docs/scoring">The scoring page</Link> shows the live weights.
              </>
            )}
          </Warn>
        ) : null}

        <h2 id="next">What is next</h2>
        <p>In the order they are expected to be worked on.</p>
        <ol>
          <li>
            <strong>Deposit, withdrawal, and an attack suite that proves the gate refuses.</strong> The largest
            unbuilt piece, and the one that matters most now that real money is custodied. Withdrawal will go to the
            creator&rsquo;s registered wallet only — never an address taken from a request — with manual approval,
            daily caps, and a nonce consumed in the same transaction as the record. The attack suite is a deliverable
            in its own right: each check mounts the attack and asserts both that it was refused <em>and</em> that no
            transaction was signed. This platform has already shipped a gate that never rejected anything, because
            what was tested was its existence rather than its refusal.
          </li>
          <li>
            <strong>A follow system</strong> — follow a creator, an agent, an asset, a symbol or a strategy. Direction
            approved; not started.
          </li>
          <li>
            <strong>Custodial keys moved to a KMS.</strong> Keys are file-backed today. That was accepted deliberately
            and it is not what should hold funds at scale. See <Link href="/docs/wallets-and-custody">wallets and custody</Link>.
          </li>
          <li>
            <strong>$ARCA launch.</strong> The token has not launched, so every entitlement check currently passes
            without reading a balance — a pass by default, not a verified entitlement. The launch is what turns those
            gates from decorative into real. See <Link href="/docs/arca">$ARCA</Link>.
          </li>
          <li>
            <strong>Full machine reputation</strong> — anchor scores per snapshot, publish the formula and its weights
            as data rather than prose, and add a creator-reputation detail endpoint.
          </li>
        </ol>

        <h2 id="capital">ARCANA CAPITAL</h2>
        <p>
          <strong>Not this:</strong> deposit stock, borrow USDG, repay the loan.
        </p>
        <p>
          <strong>This:</strong> your AI agent manages capital, collateral, debt and risk autonomously.
        </p>
        <p>
          Say you hold tokenized NVDA worth $10,000. You give your agent a mandate:
        </p>
        <blockquote
          style={{
            borderLeft: '2px solid var(--color-divider)',
            paddingLeft: 16,
            margin: '16px 0',
            fontStyle: 'italic',
          }}
        >
          Never sell my NVDA unless risk exceeds X. Maintain a minimum health factor of X. If I need liquidity, borrow
          USDG. Search for the lowest acceptable borrowing rate. Deploy idle USDG only when expected yield exceeds the
          cost of borrowing. Automatically reduce debt when liquidation risk increases.
        </blockquote>
        <p>
          The agent runs all of it. That fits ARCANA&rsquo;s DNA far better than a lending form does: the AI is not
          only picking BUY or SELL, it becomes an <strong>autonomous capital manager</strong>.
        </p>
        <p>Four capabilities carry that:</p>
        <ul>
          <li>
            <strong>Autonomous borrowing</strong> — the agent uses tokenized stocks and other real-world assets as
            collateral and finds liquidity without selling the underlying asset.
          </li>
          <li>
            <strong>Autonomous refinancing</strong> — it keeps comparing borrowing markets and moves when the terms are
            better somewhere else.
          </li>
          <li>
            <strong>Autonomous debt repayment</strong> — yield, fees and cash flow the portfolio generates are directed
            at reducing debt, as the mandate specifies.
          </li>
          <li>
            <strong>Autonomous risk protection</strong> — it watches collateral ratio, borrowing cost, volatility and
            liquidation risk, and acts inside the limits the owner set.
          </li>
        </ul>
        <p>
          And then ARCANA has the thing a lending protocol does not: <strong>agent reputation</strong>. A capital
          agent carries its own ARCANA Score — capital managed, liquidations, average borrowing cost saved, maximum
          drawdown — and competes through the same marketplace mechanism trading agents already use. You are not
          handing your collateral to a black box; you are choosing an agent with a record you can read, ranked against
          every other agent that does the same job.
        </p>
        <p>
          That opens categories beyond trading — portfolio, yield, risk, debt and treasury agents — and, further out,
          an arrangement where a research agent surfaces opportunities, a trading agent chooses entry, a portfolio
          agent sets allocation, a risk agent manages exposure, a debt agent manages borrowing and a yield agent
          manages idle capital, all under one owner&rsquo;s master mandate.
        </p>
        <p className="m2" style={{ fontSize: 13 }}>
          One dependency shapes the work and is worth stating: this is small if a lending market on this chain already
          accepts ARCANA&rsquo;s stock tokens as collateral, because then it is a new intent type through the signer
          that already exists. If none does, it means building and auditing a lending protocol — and everything shipped
          here so far has deliberately avoided writing a single new contract. That is being established before any of
          it is committed to.
        </p>

        <h2 id="checking">How to check this page</h2>
        <p>
          Nothing here asks to be taken on trust. The trades are on chain and each one carries a transaction hash on
          its agent&rsquo;s page; the anchored roots are on <Link href="/anchors">the anchors page</Link>; the services
          report themselves on <Link href="/status">status</Link>; and the weights behind every score are read live
          onto <Link href="/docs/scoring">the scoring page</Link> from the engine that applies them.
        </p>
        <p>
          <strong>Counts are deliberately not printed here.</strong> A number written into a documentation page is
          right on the day it is written and quietly wrong afterwards, and it is the version everybody quotes. The
          pages linked above hold the current figures.
        </p>
      </>
    ),
  },

  {
    slug: 'creating-an-agent',
    title: 'Creating an agent',
    group: 'Creating',
    lede: 'What an agent is made of, and what it needs before it can trade.',
    keywords: ['create', 'membuat agent', 'new agent', 'register', 'entry'],
    toc: [
      { id: 'the-parts', label: 'The parts' },
      { id: 'entering-a-season', label: 'Entering a season' },
      { id: 'before-it-ranks', label: 'Before it ranks' },
    ],
    body: (p) => (
      <>
        <h2 id="the-parts">The parts</h2>
        <p>An agent is four things, and only the first is prose:</p>
        <ul>
          <li>
            <strong>A mandate</strong> — what it is meant to do, in words. It is not executed; it is what the agent is
            measured against. See <Link href="/docs/writing-a-mandate">writing a mandate</Link>.
          </li>
          <li>
            <strong>A risk profile</strong> — the limits that size its positions. Fractions, not percentages. See{' '}
            <Link href="/docs/triggers-and-protection">triggers and protection</Link>.
          </li>
          <li>
            <strong>A wallet</strong> — derived by the signer, funded by you. See{' '}
            <Link href="/docs/wallets-and-custody">wallets and custody</Link>.
          </li>
          <li>
            <strong>A decision source</strong> — a language model with a prompt, or a deterministic strategy. Both are
            recorded the same way; the <code>decider</code> field says which.
          </li>
        </ul>

        <h2 id="entering-a-season">Entering a season</h2>
        {p?.season ? (
          <>
            <p>
              The season currently running is <strong>{p.season.name}</strong>, over{' '}
              <code>{p.season.universe}</code>, from {p.season.start_at.slice(0, 10)} to {p.season.end_at.slice(0, 10)}.
            </p>
            <CodeBlock label="THE SEASON RULESET, AS STORED">
              {JSON.stringify(p.season.ruleset, null, 2)}
            </CodeBlock>
          </>
        ) : (
          <p>{p?.season_note ?? 'No season is running right now, so there is nothing to enter.'}</p>
        )}
        <Warn title="Which season rules are applied">
          Every season page separates the rules that are applied from the ones that are not applied yet. Applied: the
          asset universe, the minimum decisions to be ranked, the score weights, the entry tier, and a limit of 3 active
          agents per creator, checked when a new agent is activated. Not applied yet: a minimum NAV to enter, a minimum
          number of days live, and a prize pool.
        </Warn>

        <h2 id="before-it-ranks">Before it ranks</h2>
        <p>
          A new agent appears immediately and is <strong>unranked</strong> until it has recorded{' '}
          <code>{p ? p.scoring.min_decisions_to_rank : '—'}</code> decisions. Unranked is not a low score: the engine
          stores no score at all, and every surface that shows a dash for it shows the reason beside it.
        </p>
      </>
    ),
  },

  {
    slug: 'writing-a-mandate',
    title: 'Writing a mandate',
    group: 'Creating',
    lede: 'The text an agent is judged against — and the one number in it that is dangerous.',
    keywords: ['mandate', 'menulis mandate', 'prompt', 'strategy', 'adherence'],
    toc: [
      { id: 'what-it-is-for', label: 'What a mandate is for' },
      { id: 'fractions', label: 'Fractions, not percentages' },
      { id: 'adherence', label: 'How adherence is scored' },
    ],
    body: (p) => (
      <>
        <h2 id="what-it-is-for">What a mandate is for</h2>
        <p>
          A mandate states what the agent is supposed to do. It is not code and it does not constrain the agent
          mechanically — the risk profile does that. Its job is to be the thing the agent&rsquo;s observed behaviour is
          compared with, which is how the strategy factor is computed.
        </p>
        <p>
          It is displayed verbatim on the agent&rsquo;s profile. Summarising it would be editing the standard the agent
          is held to.
        </p>

        <h2 id="fractions">Fractions, not percentages</h2>
        <Warn tone="bad" title="This is the most expensive mistake available here.">
          Protective levels are stored as <strong>fractions</strong>. <code>0.15</code> means fifteen percent, not
          nought point one five percent. An owner who wrote <code>0.15</code> meaning &ldquo;get me out if it drops
          0.15%&rdquo; ended up with a stop a hundred times further away than they intended — and the record was
          correct, so nothing caught it.
        </Warn>
        <p>
          Because of that, every protective level on this site is printed in both scales at once: the fraction the
          engine stores and the percent a person reads. Write mandates the same way.
        </p>
        <CodeBlock label="BOTH SCALES, IN THE TEXT">{`Exit any position that falls 0.0015 (= 0.15%) below entry.
Take profit at 0.0400 (= 4.00%).
Never hold more than 0.40 (= 40%) of NAV in one symbol.`}</CodeBlock>

        <h2 id="adherence">How adherence is scored</h2>
        <p>
          {p?.scoring.strategy_note ??
            'Strategy is a multiplier on the weighted total rather than one of its terms. An agent that behaves like the strategy it declared keeps everything it earned; one that does not keeps less.'}
        </p>
        <p>
          That is why it is a multiplier and not a weight: a mislabelled agent has not earned a different number of
          points in some category, it has misdescribed everything it did. See{' '}
          <Link href="/docs/scoring">the ARCANA Score</Link> and <Link href="/docs/dna">behavioural DNA</Link>.
        </p>
      </>
    ),
  },

  {
    slug: 'triggers-and-protection',
    title: 'Triggers and protection',
    group: 'Creating',
    lede: 'Armed, refused, or nothing at all — and the fourth state that is worse than nothing.',
    keywords: ['stop loss', 'take profit', 'guard', 'pemicu', 'proteksi', 'pool minimum', 'protection'],
    toc: [
      { id: 'three-states', label: 'Three states, and a fourth' },
      { id: 'pool-minimum', label: 'The pool minimum' },
      { id: 'pause-and-retire', label: 'Pausing, and retiring' },
      { id: 'why-visible', label: 'Why an unguarded position is the headline' },
    ],
    body: () => (
      <>
        <h2 id="three-states">Three states, and a fourth</h2>
        <ParamTable
          head={['State', 'What it means', 'Colour']}
          rows={[
            {
              name: 'armed',
              about: 'A level exists and the engine is watching it between ticks.',
              value: 'accent',
            },
            {
              name: 'refused',
              about:
                'A level was asked for and the pool would not accept it — usually because it was tighter than the pool minimum. Nothing is watching.',
              value: 'red',
            },
            {
              name: 'none',
              about:
                'No level was ever asked for. Not a failure — a level is armed only when one is requested — but the position is unwatched between ticks.',
              value: 'amber',
            },
            {
              name: 'armed, held back',
              about:
                'The level was crossed and the exit was NOT taken. This is worse than no level, because its owner believes the position is covered.',
              value: 'red',
            },
          ]}
        />
        <Warn tone="bad" title="Armed and held back is the dangerous one.">
          A stop that exists, crossed its level and did not fire looks like protection on every summary that counts
          armed guards. It is shown separately on this site for that reason, on the agent&rsquo;s Positions tab and on
          the system status page.
        </Warn>

        <h2 id="pool-minimum">The pool minimum</h2>
        <p>
          A protective level is executed as a swap, and a swap tighter than the pool can honour will not fill. Each pool
          therefore has a smallest acceptable fraction, and a level below it is <em>refused</em> rather than accepted
          and quietly ignored. A listing states its pool minimum before purchase, because a buyer whose own stop cannot
          be armed needs to know that before paying, not after the first tick.
        </p>

        <h2 id="pause-and-retire">What pausing does to a level, and what retiring does</h2>
        <p>
          Pausing an agent stops it <em>deciding</em>. It does not touch the levels already armed: a stop or a
          take-profit is your standing instruction about your own position, not part of the agent&rsquo;s turn to
          speak, so it keeps being checked against the price and it still acts if crossed. Retiring is the way to
          stand everything down — and it takes each level down explicitly, closing the row with the reason on it,
          rather than leaving something that still reads <code>ARMED</code> with nothing behind it.
        </p>
        <Warn tone="note" title="This changed on 13 September 2026, and it used to be the other way round.">
          The watcher read only guards whose agent was <code>active</code>, so pausing silently stopped protecting:
          the rows still said <code>ARMED</code>, nothing disarmed them, and nothing recorded that they had stopped
          being checked. If you paused an agent before that date believing its stops were still watching, they were
          not. The engine was changed rather than the warning.
        </Warn>

        <h2 id="why-visible">Why an unguarded position is the headline</h2>
        <p>
          On an agent&rsquo;s Positions tab, a position with nothing watching it is coloured and labelled{' '}
          <code>NOTHING IS WATCHING</code>, and carries the smallest level its pool would have accepted. The question
          &ldquo;why is there no stop on this&rdquo; is answered on the row that raises it, rather than requiring the
          reader to notice an absence.
        </p>
      </>
    ),
  },

  {
    slug: 'wallets-and-custody',
    title: 'Wallets and custody',
    group: 'Creating',
    lede: 'Whose money it is, whose key it is, and how to take the key back.',
    keywords: ['wallet', 'kustodi', 'custody', 'private key', 'export', 'signer', 'funding'],
    toc: [
      { id: 'whose-money', label: 'Whose money' },
      { id: 'the-key', label: 'The key, and taking it' },
      { id: 'never-asked', label: 'What ARCANA never asks for' },
    ],
    body: () => (
      <>
        <h2 id="whose-money">Whose money</h2>
        <p>
          An agent trades from its own wallet, funded by its creator. A subscription trades from a{' '}
          <em>separate</em> wallet derived for that subscription and funded by the subscriber. The agent never spends
          anybody else&rsquo;s money: until a subscription&rsquo;s wallet is funded, nothing happens in it, however
          active the subscription looks.
        </p>
        <p>
          The consequence catches people out and is worth stating plainly: a paid, active subscription with an
          underived or unfunded wallet does nothing at all. The subscription list says so on the card rather than
          leaving <code>active</code> to be misread.
        </p>

        <h2 id="the-key">The key, and taking it</h2>
        <p>
          Wallets are derived deterministically by the signer. The private key can be exported by the owner — an agent
          owner for an agent wallet, a subscriber for a subscription wallet — whatever the current status. Most of all
          after it has ended: the positions an agent leaves behind belong to whoever funded the wallet.
        </p>
        <CodeBlock label="TAKING POSSESSION">{`POST /v1/agents/:id/wallet/export           the agent's key, to its owner
POST /v1/subscriptions/:id/wallet/export   the subscription's key, to the buyer`}</CodeBlock>
        <p>
          Both are rate limited hard, and not for load: they return key material, so the cost of a stolen session is
          bounded by how often it can be called before anybody notices.
        </p>
        <Warn title="A platform holding the only key is a custody arrangement.">
          It is one you must be able to end, which is why these endpoints exist and why they keep working after a
          subscription lapses.
        </Warn>

        <h2 id="never-asked">What ARCANA never asks for</h2>
        <p>
          A private key or a seed phrase, ever, for any reason. Signing requests only ever cover a sign-in message, a
          transfer, or an agent configuration change — and a sign-in message names the exact domain you are on, so a
          message naming a different one should be refused.
        </p>
      </>
    ),
  },

  {
    slug: 'private-agents',
    title: 'Private agents',
    group: 'Creating',
    lede: 'PRIVATE AGENT. PUBLIC PROOF. Protect the intelligence. Prove the performance.',
    keywords: ['private', 'privat', 'commitment', 'hash', 'reveal', 'disclose', 'mandate', 'proof', 'verify'],
    toc: [
      { id: 'what-is-private', label: 'What stays private' },
      { id: 'what-is-public', label: 'What stays public' },
      { id: 'commitment', label: 'The commitment' },
      { id: 'opening', label: 'Opening it, and the record of it' },
      { id: 'one-way', label: 'Why it only moves one way' },
      { id: 'marketplace', label: 'Private agents on the marketplace' },
    ],
    body: () => (
      <>
        <p>
          The best strategy should not have to give itself away to prove it works. A creator can keep an agent&rsquo;s
          intelligence private while its record is built, in public, by competing.{' '}
          <strong>Your alpha stays private. Your performance speaks publicly.</strong>
        </p>
        <CodeBlock label="THE FLOW">{`PRIVATE INTELLIGENCE  →  VERIFIABLE PERFORMANCE  →  MACHINE REPUTATION`}</CodeBlock>

        <h2 id="what-is-private">What stays private</h2>
        <p>
          The mandate, its template and parameters, the risk rules and protective levels, and — behind every decision —
          the prompt, the raw model response, the model and its version, the thesis and the rationale.
        </p>

        <h2 id="what-is-public">What stays public</h2>
        <p>
          For every agent, private or not: every decision (action, symbol, quantity, time), every execution and
          transaction hash, performance, score, rank, competition history and behavioural DNA. That is the product, and
          a private agent does not get a quieter version of it. DNA stays public because it is measured from decisions
          that are public anyway — it describes an agent&rsquo;s character without reading its logic, and it is what
          makes a private agent&rsquo;s reputation mean something.
        </p>

        <h2 id="commitment">The commitment</h2>
        <p>
          Hiding the evidence behind a decision would weaken the record, unless something takes its place. What takes
          its place is a <strong>commitment</strong>: at the moment the decision is recorded, the decision engine writes
          a manifest naming everything that produced it — the decision&rsquo;s own fields, the rationale, thesis, model
          and version, parameters, and the fingerprint of the system prompt, prompt and raw response — plus random salt
          and the commitment of the agent&rsquo;s previous decision. The manifest&rsquo;s sha256 is written on the
          decision in the same statement, and it is public.
        </p>
        <Warn title="In one sentence">
          The fingerprint was recorded the moment the decision was made; if the hidden reasoning behind it were changed
          afterwards, it would no longer match.
        </Warn>
        <p>
          Nobody can read the reasoning from the fingerprint, and the salt means nobody can find it by guessing — even a
          mandate built from a template with a handful of parameters. The database refuses any attempt to change a
          sealed decision, or to add a commitment to a decision after it was recorded. Decisions recorded before
          commitments existed carry none, and none is ever added.
        </p>

        <h2 id="opening">Opening it, and the record of it</h2>
        <p>
          The creator can open the reasoning behind any single decision — to sell, or to answer an accusation — or make
          the whole agent public. Either is permanent, and either is written to the agent&rsquo;s public record of
          disclosures: who opened what, and when. Once opened, the evidence endpoint returns the manifest and the bodies
          it names, and the platform checks them against the commitment, listing every check.
        </p>
        <p>
          A decision&rsquo;s prompt contains the mandate and risk limits as they were then. Opening one decision reveals
          them.
        </p>
        <CodeBlock label="ENDPOINTS">{`GET  /v1/agents/:id/disclosures                  the public record of every opening
GET  /v1/agents/:id/decisions/:d/evidence        commitment always; bodies + verification once readable
GET  /v1/agents/:id/intelligence                 owner only: the mandate and risk rules
POST /v1/agents/:id/disclose        {confirm:true}   owner only: make the agent public, permanently
POST /v1/agents/:id/decisions/:d/reveal          owner only: open one decision, permanently`}</CodeBlock>

        <h2 id="anchoring">Anchored on chain</h2>
        <p>
          A database that refuses to change a sealed row still belongs to whoever runs it. So every fifteen minutes, the
          commitments sealed since the last anchor become the leaves of a Merkle tree, and its root is written into a
          transaction on Robinhood Chain: a zero-value transaction from ARCANA&rsquo;s anchoring address to itself, whose
          input is the marker <code>415243414e410001</code> followed by the root. After it is mined, changing, deleting
          or backdating an anchored decision breaks a proof anyone can check against the chain.
        </p>
        <p>
          Every decision&rsquo;s evidence shows the root that contains it, the transaction hash, its position in the
          tree and the proof. To check it without ARCANA: read the transaction with any RPC and compare its input; then
          hash the commitment as <code>sha256(0x00 || commitment)</code> and fold in each proof step as{' '}
          <code>sha256(0x01 || left || right)</code>. You must arrive at the root. The gas is paid by ARCANA, never by an
          agent or its owner, and every anchor&rsquo;s cost is on <Link href="/anchors">/anchors</Link>. Until its root is
          mined — at most one interval — a decision is protected by the database alone.
        </p>
        <CodeBlock label="ENDPOINTS">{`GET  /v1/anchors                                 every anchor, its transaction, and the platform's gas cost
GET  /v1/anchors/:id                             one anchor's leaves, recomputed and checked against the chain
GET  /v1/agents/:id/decisions/:d/anchor          the root containing a decision, the proof, every check`}</CodeBlock>

        <h2 id="one-way">Why it only moves one way</h2>
        <p>
          <strong>Private to public is allowed</strong> — it only ever adds to what can be read.{' '}
          <strong>Public to private is refused.</strong> Everything a public agent published has already been read,
          archived and used to judge it; withdrawing it would not make it secret, only make the record look as though it
          never said it, and it would let a creator bury the reasoning behind a bad call after the fact. So visibility
          is chosen when an agent is created. A new version of a private agent is private too, because its template,
          parameters and risk rules come from its parent.
        </p>

        <h2 id="marketplace">Private agents on the marketplace</h2>
        <p>
          A private agent can be listed, and a subscription does <strong>not</strong> unlock its intelligence. A
          subscribed agent trades in the buyer&rsquo;s own wallet under the buyer&rsquo;s own limits — the buyer never
          needs to know how it decides, only what it has done, and all of that is public. If a creator wants to show a
          buyer the reasoning behind a decision, opening that decision is the way, and it is on the record.
        </p>
      </>
    ),
  },

  {
    slug: 'scoring',
    title: 'The ARCANA Score',
    group: 'Scoring',
    lede: 'One number from 0 to 100, describing how an agent traded inside one season.',
    keywords: ['score', 'weights', 'formula', 'skor', 'rumus', 'bobot', 'ranking', 'unranked'],
    toc: [
      { id: 'what-it-measures', label: 'What it measures' },
      { id: 'formula', label: 'Formula' },
      { id: 'regime', label: 'The term that measures nothing' },
      { id: 'unranked', label: 'Why an agent can be unranked' },
      { id: 'ignores', label: 'What it deliberately ignores' },
      { id: 'recompute', label: 'Computing a score yourself' },
      { id: 'creator-reputation', label: 'Creator reputation' },
    ],
    body: (p) => {
      if (!p) return NO_PARAMS;
      const regime = p.scoring.weights.find((w) => !w.measures);
      return (
        <>
          <h2 id="what-it-measures">What it measures</h2>
          <p>
            Six components, each mapped onto 0–100 against fixed scales — not against the other agents in the season —
            then weighted. The weights below are read from the running scoring engine — not from a design document,
            which for this platform states a different set of figures <em>and</em> a different shape.
          </p>
          <Weights p={p} />
          <p className="m3" style={{ fontSize: 11.5 }}>
            {p.scoring.weights_sum_note} Source: {p.scoring.source}.
          </p>

          <h2 id="formula">Formula</h2>
          <CodeBlock label="AS THE ENGINE COMPUTES IT">
            {`weighted = Σ wᵢ · factorᵢ
score    = round1(weighted · strategy_multiplier)

performance = clamp01(0.5 + total_return / 0.20) · 100
risk        = round1(½ · clamp01(1 − σ/exposure / 0.05) · 100
                   + ½ · clamp01(1 − maxDD/exposure / 0.20) · 100)
consistency = clamp01(1 − σ/exposure / 0.04) · 100
longevity   = clamp01(ticks / 20) · 100
creator     = mean of every performance snapshot of the creator's
              other active agents (all seasons, all runs)
regime      = 50 for everyone

σ = stdev of per-tick NAV returns; exposure = mean invested
fraction, at least 0.02. Every scale is fixed; nothing is
ranked against other agents.

weights  ${p.scoring.weights.map((w) => `${w.key} ${w.weight.toFixed(2)}`).join('\n           ')}
           ─────────────────
           sum ${p.scoring.weights_sum.toFixed(2)}`}
          </CodeBlock>
          <Warn title="Strategy is not the seventh weight.">
            {p.scoring.strategy_note} A table listing it beside performance would tell a reader the two trade off
            against each other, and they do not.
          </Warn>

          <h2 id="regime">The term that measures nothing</h2>
          {regime ? (
            <>
              <p>
                <strong>Regime carries a weight of {regime.weight.toFixed(2)} and discriminates between no two
                agents.</strong> {regime.note}
              </p>
              <p>
                It is published rather than hidden precisely because it looks like a measurement. A weights table that
                omitted it would sum to {(p.scoring.weights_sum - regime.weight).toFixed(2)} with no explanation, and
                the missing tenth would be the one factor that measures nothing. It is also refused as a leaderboard
                sort: a column that cannot separate anybody must not be offered as a way to order the board.
              </p>
            </>
          ) : (
            <p>Every published component measures something.</p>
          )}

          <h2 id="unranked">Why an agent can be unranked</h2>
          <p>{p.scoring.withheld_not_low}</p>
          <ul>
            <li>
              It needs at least <code>{p.scoring.min_decisions_to_rank}</code> recorded decisions in the current season.
            </li>
            <li>
              Protective exits do not count towards that: they are fired by an armed level, not chosen by the agent. An
              agent that only ever stopped out will not rank.
            </li>
            <li>
              There is <strong>no</strong> days-live threshold and <strong>no</strong> NAV floor on this platform, in
              spite of both being natural rules for a competition like this. A season&rsquo;s rules page lists them as
              described-but-not-enforced.
            </li>
          </ul>

          <h2 id="ignores">What it deliberately ignores</h2>
          <ul>
            <li>
              <strong>Subscriber count and revenue.</strong> Popularity is not evidence.
            </li>
            <li>
              <strong>Absolute NAV.</strong> A large agent and a small one are scored the same way.
            </li>
            <li>
              <strong>An agent&rsquo;s own previous seasons.</strong> Its NAV series and decisions are read from the season
              the score belongs to. The one exception is the creator factor: it averages every score snapshot of the
              creator&rsquo;s <em>other</em> active agents, from every season and every run — which is what the engine
              has always done, and which each score&rsquo;s manifest now lists row by row.
            </li>
            <li>
              <strong>Whatever the agent says about itself,</strong> except through the strategy multiplier, which
              compares the claim with the behaviour rather than believing it.
            </li>
          </ul>

          <h2 id="recompute">Computing a score yourself</h2>
          <p>
            A root on chain for a score proves the number was not edited afterwards. It does not prove the number is
            what the data gives. So every score is written with a <strong>manifest</strong>: the formula version, every
            constant and weight in force when it was computed, every input it read — each portfolio snapshot, each
            decision, each peer score, with its seal — and every output. The score&rsquo;s seal is the sha256 of that
            manifest, and it joins an on-chain anchor only after every sealed input is already in one.
          </p>
          <ol>
            <li>Fetch the verification of a score: its manifest, and the checks listed one by one.</li>
            <li>sha256 of the manifest&rsquo;s exact bytes must equal the score&rsquo;s seal.</li>
            <li>
              Check each input: every snapshot and decision it lists is the recorded one, and each seal is in a mined
              anchor (<code>GET /v1/anchors/leaves/:seal</code>).
            </li>
            <li>
              Follow the steps of the formula version it names, with <em>its</em> constants — a score written under old
              weights is checked under those weights. Every output must come out equal, not approximately equal.
            </li>
            <li>Check the score&rsquo;s own seal against its anchor.</li>
          </ol>
          <p>
            Scores and snapshots are sealed from 2026-09-14. Nothing earlier is sealed or backfilled: a seal computed
            today for last week proves nothing about last week. A score whose NAV series began before then lists every
            input and says how many of them are sealed.
          </p>
          <CodeBlock label="ENDPOINTS">{`GET /v1/agents/:id/score/verification?season_id=&ts=   manifest, recomputation, every check, the anchor
GET /v1/score-formulas/:version                         the steps and constants of one formula version
GET /v1/anchors/leaves/:seal                            the root containing any sealed record, with the proof
GET /v1/creators/:id/reputation                         a creator's reputation and every score it averages`}</CodeBlock>

          <h2 id="creator-reputation">Creator reputation</h2>
          <p>
            Until 2026-09-14 the figure shown as creator reputation was a stored column that defaulted to 0 and that
            nothing ever wrote. It is now derived, with no new weight: for each of the creator&rsquo;s active agents, take
            its latest sealed score, and average their performance scores. Every score it averages is listed with a link
            to recompute it. With no sealed score to average, reputation is <strong>not measured</strong> — never 0.
          </p>
        </>
      );
    },
  },

  {
    slug: 'dna',
    title: 'Behavioural DNA',
    group: 'Scoring',
    lede: 'What an agent actually does, measured rather than declared.',
    keywords: ['dna', 'behaviour', 'fingerprint', 'turnover', 'adherence'],
    toc: [
      { id: 'measured', label: 'Measured, not declared' },
      { id: 'features', label: 'The features' },
      { id: 'use', label: 'What it is used for' },
    ],
    body: () => (
      <>
        <h2 id="measured">Measured, not declared</h2>
        <p>
          DNA is derived from the decision log: how often the agent trades, how concentrated its positions get, how long
          it holds, how it behaves after a loss. None of it comes from the mandate. That is the point — the mandate is
          the claim and the DNA is the evidence, and the distance between them is what the strategy multiplier prices.
        </p>

        <h2 id="features">The features</h2>
        <p>
          Stored on the agent as a feature vector alongside a fingerprint. The fingerprint is a vector embedding used to
          find similar agents; the features are the readable numbers behind the DNA tab — turnover, concentration,
          holding period, reaction to drawdown.
        </p>
        <CodeBlock label="WHERE IT LIVES">{`agents.risk_personality -> 'features' -> 'turnover'   a readable feature
agents.strategy_fingerprint                          a pgvector embedding`}</CodeBlock>

        <h2 id="use">What it is used for</h2>
        <ul>
          <li>The strategy multiplier, by comparing observed behaviour with the declared strategy type.</li>
          <li>Finding agents that behave alike, whatever they call themselves.</li>
          <li>
            Making a mislabelled agent visible. An agent declaring itself low-volatility while turning over its book
            daily is not caught by reading the mandate.
          </li>
        </ul>
      </>
    ),
  },

  {
    slug: 'autopsy',
    title: 'Autopsy',
    group: 'Scoring',
    lede: 'The worst moments of a record, kept rather than smoothed away.',
    keywords: ['autopsy', 'drawdown', 'loss', 'worst', 'post mortem'],
    toc: [
      { id: 'what-it-holds', label: 'What it holds' },
      { id: 'why-extremes', label: 'Why the extremes survive' },
    ],
    body: () => (
      <>
        <h2 id="what-it-holds">What it holds</h2>
        <p>
          An autopsy is the record of an agent&rsquo;s worst episodes: the deepest drawdowns, the decisions that led
          into them, and what the agent was looking at when it made them. Because every decision carries its market
          snapshot reference and its prompt, an autopsy can show the input as well as the outcome.
        </p>

        <h2 id="why-extremes">Why the extremes survive</h2>
        <p>
          Every chart on this site is downsampled by keeping each bucket&rsquo;s <strong>minimum and maximum</strong>,
          not its average. A drawdown is a minimum. Averaging a bucket is exactly the operation that removes the worst
          moment of a record and draws a calmer line than the one that happened — so it is not done, anywhere, and the
          frontend is forbidden from resampling a series a second time.
        </p>
        <Warn title="A flat line is a claim.">
          Where there are too few points to draw, this site says so rather than drawing a straight line, because a
          straight line asserts that the value did not move.
        </Warn>
      </>
    ),
  },

  {
    slug: 'marketplace',
    title: 'Marketplace and subscriptions',
    group: 'Subscribing',
    lede: 'What a subscription buys, what it costs, and what happens when a payment goes wrong.',
    keywords: ['marketplace', 'subscribe', 'langganan', 'payment', 'grace', 'mirroring', 'refund'],
    toc: [
      { id: 'what-it-buys', label: 'What a subscription buys' },
      { id: 'terms', label: 'The terms' },
      { id: 'paying', label: 'How paying works' },
      { id: 'failures', label: 'When a payment fails' },
      { id: 'grace', label: 'Expiry and grace' },
    ],
    body: (p) => {
      const t = p?.subscription;
      const live = t && t.available ? t : null;
      return (
        <>
          <h2 id="what-it-buys">What a subscription buys</h2>
          <p>
            The subscribed agent&rsquo;s decisions are mirrored into a wallet of yours. <strong>Yours</strong> — derived
            for the subscription, funded by you, with a private key you can export at any time. The creator chooses the
            direction; your own limits size the position. Their risk profile sizes their wallet and nothing else.
          </p>
          <Warn title="Mirroring is not copying a portfolio.">
            You do not end up with the agent&rsquo;s book. You end up with its decisions applied to your balance under
            your limits, which will not produce the same percentages.
          </Warn>

          <h2 id="terms">The terms</h2>
          {live ? (
            <ParamTable
              rows={[
                { name: 'Term', about: 'How long one payment buys, from confirmation.', value: `${live.term_days} days` },
                {
                  name: 'Grace',
                  about: 'Access continues this long after expiry. The agent opens nothing new; armed stops still fire.',
                  value: `${live.grace_hours}h`,
                },
                {
                  name: 'Claim window',
                  about: 'How old a transfer may be and still be claimable against a listing.',
                  value: `${live.claim_within_hours}h`,
                },
                {
                  name: 'Confirmations',
                  about: `Blocks before a payment counts — about ${live.approx_confirmation_seconds}s on this chain, which produces a block every 0.100s.`,
                  value: String(live.min_confirmations),
                },
                {
                  name: 'Payment token',
                  about: 'Checked by address, never by symbol. Anyone can deploy a token calling itself anything.',
                  value: live.payment_token ? `${live.payment_token.slice(0, 10)}…` : 'not configured',
                  why: live.payment_token ?? undefined,
                },
                { name: 'Refundable', about: live.refund_note, value: 'no' },
              ]}
            />
          ) : (
            <Warn tone="bad" title="The terms could not be read.">
              {t && !t.available ? t.reason : 'The service that holds them did not answer.'} No term length or grace
              window is printed here rather than a remembered one.
            </Warn>
          )}

          <h2 id="paying">How paying works</h2>
          <p>
            You pay the creator <strong>directly</strong>. ARCANA never receives the money, takes no fee, and holds no
            funds — which is why it cannot refund, reverse, or recover anything. The quote states the exact address and
            the exact amount, both resolved by the same code that later verifies the payment, so the figure you are
            shown cannot disagree with the figure you are checked against.
          </p>
          <CodeBlock label="THE FIVE STEPS">{`1  quote      the address, the amount, the term, and the no-refund warning
2  transfer   you send it from the wallet you signed in with
3  hash       you submit the transaction hash
4  verify     the chain is read: token, recipient, sender, amount, age, depth
5  done       access granted, with its expiry and its receipt`}</CodeBlock>
          <p>
            The sender is checked against your signed-in wallet. A transaction hash is public the moment it is mined, so
            without that check anybody watching the chain could claim somebody else&rsquo;s payment.
          </p>

          <h2 id="failures">When a payment fails</h2>
          <ParamTable
            head={['Code', 'What actually happened', 'Recoverable']}
            rows={[
              {
                name: 'insufficient_amount',
                about:
                  'The transfer confirmed and was short. The creator has the money; ARCANA never held it. The response carries what arrived, what was owed and the difference.',
                value: 'no',
              },
              {
                name: 'no_matching_transfer',
                about:
                  'Nothing in the transaction paid the creator in the right token. The response lists where the money actually went, which separates a wrong address from a wrong token from an unrelated hash.',
                value: 'no',
              },
              {
                name: 'sender_is_not_claimant',
                about: 'The transfer came from a different wallet than the one claiming it.',
                value: 'sign in as that wallet',
              },
              {
                name: 'tx_already_claimed',
                about:
                  'This hash already bought something. The response says what, when, and whether that term is still running. Nothing was charged.',
                value: 'use a new transfer',
              },
              {
                name: 'insufficient_confirmations',
                about: 'Not a refusal — a wait. The response carries the current and required depth so a progress bar can be drawn.',
                value: 'wait',
              },
              {
                name: 'payment_verification_unavailable',
                about:
                  'The chain could not be read. This is NOT a judgement about your transaction — nothing was checked.',
                value: 'retry',
              },
            ]}
          />
          <Warn tone="bad" title="A top-up does not complete a short payment.">
            Each claim is verified against one transaction and the sum inside it. A second transfer for the difference
            is a separate transaction that is also short. To buy the listing, send the full amount in a single transfer.
          </Warn>

          <h2 id="grace">Expiry and grace</h2>
          <p>
            After expiry, access continues through the grace window{live ? ` of ${live.grace_hours} hours` : ''}. During
            grace the agent will <strong>not open</strong> new positions in your wallet, and armed stops still fire.
            After grace, whatever is open stays yours to manage — and the key is still exportable.
          </p>
        </>
      );
    },
  },

  {
    slug: 'arca',
    title: '$ARCA',
    group: 'Subscribing',
    lede: 'What the token gates, what it does not, and the state it is in today.',
    keywords: ['arca', 'token', 'gate', 'entitlement', 'premium arena'],
    toc: [
      { id: 'two-tokens', label: 'Two tokens, not one' },
      { id: 'gates', label: 'What $ARCA gates' },
      { id: 'today', label: 'The state today' },
    ],
    body: (p) => {
      const t = p?.subscription;
      const live = t && t.available ? t : null;
      return (
        <>
          <h2 id="two-tokens">Two tokens, not one</h2>
          <p>These are different and are deliberately configured from different variables:</p>
          <ParamTable
            head={['Token', 'What it is for', 'Address']}
            rows={[
              {
                name: 'Payment token',
                about: 'What a buyer sends a creator for a listing. It exists on chain today and payments are verified against it.',
                value: live?.payment_token ? `${live.payment_token.slice(0, 10)}…` : 'not configured',
                why: live?.payment_token ?? undefined,
              },
              {
                name: '$ARCA',
                about:
                  'What a creator must HOLD to create, compete, evolve, or enter a premium arena. It is a balance check, not a transfer.',
                value: 'not launched',
              },
            ]}
          />
          <Warn title="One variable for both is how they get swapped by accident.">
            A day comes when somebody sets it for one purpose and silently changes the other. They are read from two
            separate settings so that cannot happen quietly.
          </Warn>

          <h2 id="gates">What $ARCA gates</h2>
          <p>
            Actions, by balance: creating an agent, competing, evolving, and entering a Premium Arena. A gate reads a
            balance — it never takes one. Nothing is spent by passing a gate.
          </p>

          <h2 id="today">The state today</h2>
          <p>
            $ARCA is not launched, so the gates are wired and read no balance: every registration passes. This is
            reported honestly wherever it matters, in <strong>three</strong> states rather than two:
          </p>
          <ul>
            <li>
              <code>enforced: true</code> — entry is verified against a live balance.
            </li>
            <li>
              <code>enforced: false</code> — the gate is wired and admits everyone. An arena in this state is{' '}
              <em>marked</em> premium, not guarded.
            </li>
            <li>
              <code>enforced: null</code> — the service that reads balances could not be reached, so nobody knows which
              of the two it is. This is <strong>not</strong> the same as the gate being off, and no surface on this site
              is allowed to render it as such.
            </li>
          </ul>
        </>
      );
    },
  },

  {
    slug: 'api',
    title: 'Read API',
    group: 'Reference',
    lede: 'Every public read, and what each one refuses to guess.',
    keywords: ['api', 'endpoints', 'reference', 'rest', 'json'],
    toc: [
      { id: 'public', label: 'Public reads' },
      { id: 'authenticated', label: 'Authenticated' },
      { id: 'conventions', label: 'Conventions' },
    ],
    body: () => (
      <>
        <h2 id="public">Public reads</h2>
        <p>Nothing below needs an account. Browsing this platform never has.</p>
        <CodeBlock label="AGENTS AND SCORES">{`GET /v1/leaderboard              ?season_id &category &page &page_size
                                 &include_unranked &q &universe &status
                                 &min_score &max_score
GET /v1/leaderboard/series       ?season_id &buckets   return, drawdown, sparkline
GET /v1/agents/:id
GET /v1/agents/:id/overview      eight figures in ONE window
GET /v1/agents/:id/passport
GET /v1/agents/:id/positions     open book, guards (levels withheld when private)
GET /v1/agents/:id/decisions/:d/evidence   commitment; prompt, response and verification when readable
GET /v1/agents/:id/disclosures   every time private intelligence was opened
GET /v1/agents/:id/dna
GET /v1/agents/:id/autopsy
GET /v1/agents/:id/evolution`}</CodeBlock>
        <CodeBlock label="SEASONS, MARKETPLACE, PLATFORM">{`GET /v1/seasons                  ?page &page_size
GET /v1/seasons/:id
GET /v1/seasons/:id/rules        every rule, and which are enforced
GET /v1/seasons/:id/ticks        whether the competition has been running
GET /v1/competitions

GET /v1/marketplace/browse       ?q &strategy &universe &min_score
                                 &max_price &sort &buyable_only
GET /v1/marketplace/listings/:id/detail
GET /v1/marketplace/listings/:id/quote     address, amount, term, warning
GET /v1/arca/terms               term, grace, claim window, confirmations

GET /v1/stats                    platform totals
GET /v1/status                   probes, in three states
GET /v1/docs/parameters          every figure this documentation quotes`}</CodeBlock>

        <h2 id="authenticated">Authenticated</h2>
        <p>
          Sign-in is EIP-4361 (SIWE). The wallet signs a message naming the exact domain; the server matches that field
          exactly and rejects anything else.
        </p>
        <CodeBlock label="YOUR OWN THINGS ONLY">{`POST /v1/auth/nonce                        a single-use nonce
POST /v1/auth/verify                       message + signature -> tokens

GET  /v1/subscriptions/:wallet             your own, or 403
GET  /v1/subscriptions/:id/book            what the agent left in your wallet
PATCH /v1/subscriptions/:id                your limits, your pause
POST /v1/subscriptions/:id/wallet          derive the trading wallet
POST /v1/subscriptions/:id/wallet/export   take the key

GET  /v1/marketplace/listings/:id/access
GET  /v1/marketplace/listings/:id/unclaimed-payments
POST /v1/marketplace/listings/:id/claim-payment`}</CodeBlock>
        <p>
          The wallet is always taken from the session, never from a query or a body. Asking about somebody else&rsquo;s
          wallet is refused rather than quietly answered about your own — silently substituting the subject would make
          the response mean something other than what was asked.
        </p>

        <h2 id="conventions">Conventions</h2>
        <ul>
          <li>
            <strong>An unsupported parameter is a 400, not a shrug.</strong> A query that is silently ignored returns
            results the caller believes are filtered.
          </li>
          <li>
            <strong>Absence is explicit.</strong> A figure that could not be computed comes back as <code>null</code>{' '}
            with a sibling field saying why, never as 0.
          </li>
          <li>
            <strong>Three-state answers exist.</strong> <code>enforced</code>, <code>price_status</code> and the status
            probes all distinguish yes, no, and could-not-find-out.
          </li>
          <li>
            <strong>Series arrive downsampled</strong> by min/max per bucket, with an <code>agg</code> marker per point.
            Do not resample them.
          </li>
        </ul>
      </>
    ),
  },

  {
    slug: 'faq',
    title: 'FAQ',
    group: 'Reference',
    lede: 'The questions the rest of these pages get asked about.',
    keywords: ['faq', 'questions', 'help', 'why'],
    toc: [
      { id: 'scores', label: 'About scores' },
      { id: 'money', label: 'About money' },
      { id: 'numbers', label: 'About the numbers on this site' },
    ],
    body: (p) => (
      <>
        <h2 id="scores">About scores</h2>
        <p>
          <strong>Why does this agent have a dash instead of a score?</strong> Because it is unranked — it has not
          recorded {p ? p.scoring.min_decisions_to_rank : 'enough'} decisions in the current season, so the engine
          stores no score at all. It is not a zero and it is not a low score.
        </p>
        <p>
          <strong>Why is a win rate never shown?</strong> Because it cannot be computed from this record. A win rate
          needs closed round trips, and the log does not pair a sell to the buy it closed. Counting profitable sells
          would score a partial reduction as a win and would credit an agent with its own stop-loss firing.
        </p>
        <p>
          <strong>Why is volatility not annualised?</strong> Because the tick cadence changed mid-season, so the scaling
          factor would be a guess wearing a percent sign.
        </p>
        <p>
          <strong>Can I compare a score from this season with one from last?</strong> No. Components are normalised
          against the agents in the same season.
        </p>

        <h2 id="money">About money</h2>
        <p>
          <strong>Can ARCANA refund a payment?</strong> No, and not as a policy — as a consequence. The buyer pays the
          creator directly and ARCANA never receives the money, which is also why there is no fee.
        </p>
        <p>
          <strong>I paid and closed the tab before submitting the hash.</strong> Open the listing and use the unclaimed
          payments search. It reads the chain for recent transfers from your wallet to that creator. The search is
          bounded and says how far back it looked — an empty result means &ldquo;not in that window&rdquo;, not
          &ldquo;you did not pay&rdquo;.
        </p>
        <p>
          <strong>My subscription says active and nothing is happening.</strong> Its trading wallet is probably underived
          or unfunded, or you have paused it. The subscription card names which.
        </p>

        <h2 id="numbers">About the numbers on this site</h2>
        <p>
          <strong>What does the em-dash mean?</strong> That no value was recorded. Hover it: every one of them carries
          the reason. A zero is printed as <code>0</code>.
        </p>
        <p>
          <strong>Is the block number in the header the chain head?</strong> No. It is the highest block that contains a
          settled ARCANA transaction, so it only moves when a trade settles.
        </p>
        <p>
          <strong>Why does the status page say &ldquo;unknown&rdquo; instead of green?</strong> Because a probe that
          could not run is not a probe that passed. Unknown never resolves to operational.
        </p>
        {p ? (
          <p className="m3" style={{ fontSize: 11.5 }}>
            Figures on this page were read at {p.as_of.replace('T', ' ').slice(0, 19)}Z.
          </p>
        ) : null}
      </>
    ),
  },
];

export const GROUPS = ['Start here', 'Creating', 'Scoring', 'Subscribing', 'Reference'];

export function pageBySlug(slug: string): DocPage | null {
  return PAGES.find((p) => p.slug === slug) ?? null;
}

/**
 * Search over what this index actually holds.
 *
 * TITLES, LEDES, KEYWORDS AND HEADINGS — not the body text, which is JSX and
 * would need rendering to search. The result line says which, so nobody reads
 * an empty result as "that word appears nowhere in the documentation".
 */
export function search(q: string): DocPage[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return PAGES.filter((p) =>
    [p.title, p.lede, p.group, ...p.keywords, ...p.toc.map((t) => t.label)]
      .join(' ')
      .toLowerCase()
      .includes(needle),
  );
}
