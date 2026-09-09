# Agent Autopsy (V1 — Foundation)

Why an agent performed the way it did, read out of its own decision record.

> **Foundation level.** The whitepaper places full Agent Autopsy in **February
> 2027**. Six of its eight sections are provided; the other two are refused,
> with reasons, below.

Companions: [Agent DNA](./agent-dna.md) (how it behaves),
[Agent Passport](./agent-passport.md) (what it has been through),
[Agent Evolution](./agent-evolution.md) (what changed between versions).

Implemented in `services/agent-service/src/autopsy/`.
`GET /v1/agents/{id}/autopsy`.

---

## The rule this feature is built around

An autopsy is the easiest place in this platform to smuggle in a narrative that
sounds authoritative and is supported by nothing. So:

**Every statement must be traceable to specific rows, and the response carries
the evidence.**

```
"bought at the 100th percentile of the surrounding 11-tick range"   — a fact
"the agent misread the market"                                      — not ours
```

The line is drawn at causation. Co-occurrence is reported as co-occurrence:
trades that happened inside a drawdown window are listed *and labelled* as
having happened inside it, with an explicit note that this is not a causal
claim.

Sections with nothing to measure **say so** rather than returning zeros that
read like findings. `holder_v1` has no trades at all, and its timing section
returns:

> "No trades recorded, so there is no timing to analyse. This is an absence of
> data, not a timing score of zero."

## Where it lives, and why not the Scoring Engine

architecture.md §2.3 assigns Autopsy to the Scoring Engine (Go). It is
implemented in **agent-service** (NestJS) instead.

Following §2.3 would have required a third Go implementation of "what the market
did" alongside `MarketIndexService` — which Agent DNA and Agent Evolution
already share — plus a duplicate of the portfolio-snapshot/decision pairing and
a Go reader for `agent_dna`. Two definitions of the market would eventually
disagree. Keeping the analysis next to its data beat following the document into
duplication.

Autopsy **explains** the score and never changes it. Nothing here reaches the
Scoring Engine, and `regime_score` is untouched.

## What is analysed

| Section | Question it answers | Source |
|---|---|---|
| `summary` | how long, how active, what return | `portfolio_snapshots`, `decisions` |
| `allocation` | which symbol produced the return, and what idle cash cost | holdings × price change, `market_snapshots` |
| `decision_timing` | did it trade near local peaks or troughs | trade price vs the ±5-tick range for that symbol |
| `risk` | when the deepest fall happened, how long, what was decided during it | NAV series + decisions in the window |
| `volatility` | did the book move more than the market it took | NAV returns vs market returns, per unit of exposure |
| `market_regime` | how it fared in rising/falling/flat markets | **read from `agent_dna.regime_strengths`**, not recomputed |
| `historical_decisions` | the plain shape of the record | `decisions` |

### Decision timing

For each trade, the execution price is placed in the range of the surrounding
±5 ticks for that symbol. **0** = traded at the lowest price in the window,
**100** = the highest. A buy near 0 is well-placed; a sell near 100 is
well-placed. Forward return over the next 5 ticks is reported alongside, because
a good entry price and a bad subsequent move are different facts.

The three best and three worst entries are returned individually — with
timestamp, symbol, price, percentile, forward return and the decision's own
`rationale` — so any average can be traced to the trades behind it.

Worked example, verified against the source rows:

```
momentum_v1, worst entry: MSFT @ 211.95, percentile 100, forward −5.58%
rationale: "momentum: MSFT up 1.27% since last tick, adding 75.43 shares"
```

The surrounding window: 204.06, 205.64, 206.95, 206.22, 209.30, **211.95**,
208.76, 206.34, 205.13, 201.73, 200.12. It bought the highest price in the
window and the price fell 5.58% over the next five ticks. Both halves are facts;
the analysis stops there and does not tell the reader what the agent "should"
have done.

### Cash drag

An estimate, and labelled as one: idle cash at each tick × the market index
return into the next tick. It assumes cash could have been deployed at market
rate, which the agent never attempted.

The sign is explained in the payload because it inverts the usual reading: a
**negative** drag is a *benefit* — the market fell while the cash sat out.
`momentum_v1` reports −20,488, which is cash sheltering the book, not losing it.

### Volatility attribution

The ratio compares NAV volatility per unit of exposure against the market's own
volatility. A ratio above 1 has at least two possible causes — the agent's
trading, and holding a mix that differs from the equal-weighted index — and this
measure **separates neither**. The response says so.

The one case where it can conclude something is zero trades: with no trades,
trading is ruled out and position composition is what remains. That conclusion
is drawn only because the data supports it.

## Small samples

- Fewer than **5 decisions** → no autopsy at all, same threshold as scoring,
  DNA, passport and evolution. The response explains why and still lists the
  refused sections.
- Fewer than **5 trades** → timing is not characterised. Two trades can look
  like impeccable or catastrophic timing purely by luck, and a confident figure
  from a sample that small is a lie with a decimal point.

## What is NOT analysed, and why

Returned inside the payload as `not_analysed`, not merely documented here — a
consumer should be able to see what is missing without knowing what to expect.

**`sector_rotation`** — the universe is two symbols (AAPL, MSFT) and no sector
classification exists anywhere in the schema. Any sector analysis would be
invented.

**`thesis_failure`** — `decisions.rationale` is populated for **every** row
(324 buys, 110 sells, 478 holds, none empty), which makes this the tempting one.
But it records the rule that fired — *"momentum: AAPL up 0.26% since last tick,
adding 155.79 shares"* — not a forward-looking thesis. There is no claim about
the future to test against the outcome, so testing one would mean inventing the
thesis first. Analysing "thesis failure" here would be analysing a thesis nobody
made.

## The caveat every response carries

> The market these decisions were made in is a simulator whose trend behaviour
> ARCANA calibrated itself. Findings describe conduct in that market and do not
> carry to a real one.

That is not boilerplate. The drift strength, the trend block length and the noise
band were all chosen by this project (see [data-resets.md](./data-resets.md)),
so a timing result partly measures the simulator.

---

## What Foundation deliberately leaves out

For **Agent Autopsy 2.0 (Feb 2027)**:

- **Sector rotation**, once the universe has more than two symbols and a sector
  classification exists.
- **Thesis analysis**, once agents state a thesis distinguishable from the rule
  that fired — which is a Decision Engine change, not an analysis one.
- **Attribution that separates trading from composition.** Today the volatility
  ratio names both candidates and picks neither. Separating them needs a
  counterfactual buy-and-hold book to compare against.
- **Statistical significance.** No confidence intervals: with tens of trades in
  a simulated market, any such number would be false precision.
- **Cross-agent comparison.** Autopsy examines one agent. "Did it time entries
  better than its peers" needs a cohort baseline.
- **Recommendations.** The feature deliberately stops at measurement. Telling a
  creator what to change would require the causal claims it refuses to make.
