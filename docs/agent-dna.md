# Agent DNA (V1 — Foundation)

A behavioural fingerprint of an agent, derived from what it **actually did**.

Its companion is the [Agent Passport](./agent-passport.md): DNA answers *how
does this agent behave*, the passport answers *what has this agent been
through*.

> **Foundation level.** The whitepaper places full Agent DNA in **May 2027**.
> This is the V1 groundwork: a hand-built feature vector, not a learned
> embedding. What is deliberately *not* here is listed at the end.

Implemented in `services/agent-service/src/dna/` — §8 places
`GET /v1/agents/{id}/dna` under the Agent Service, alongside agent identity and
configuration.

---

## The principle: conduct, not labels

DNA never reads `agents.strategy_type`. That comparison already has an owner:
`strategy_score` asks whether behaviour matched the declared label, and
duplicating it here would produce two answers to one question.

DNA answers a different one — *what does this agent actually do?* — and the
answer holds whether the label is accurate, stale, or wrong. Two agents both
registered `momentum` can behave nothing alike, and the fingerprint says so.

The declared type is returned by the API purely as context. A mismatch between
it and the fingerprint is informative, not an error.

## Features (8)

All derived from the append-only `decisions` log, `portfolio_snapshots`, and
market prices from the Market Data service.

| # | Feature | Definition | What it captures |
|---|---|---|---|
| 1 | `turnover` | (buys + sells) / decisions | how often it acts at all |
| 2 | `sellShare` | sells / trades | direction bias: adding vs reducing |
| 3 | `exposure` | mean(1 − cash/nav) | how much of the book is at stake |
| 4 | `concentration` | normalised Herfindahl over position **values** | concentrated vs spread |
| 5 | `tradeSizePct` | mean(**buy** notional / NAV) | typical entry size |
| 6 | `trendAlignment` | mean(sign(market move) × sign(buy=+1, sell=−1)) | trend-following (+) vs contrarian (−) |
| 7 | `volPerExposure` | stdev(NAV returns) / exposure | volatility for the risk taken |
| 8 | `drawdownPerExposure` | max drawdown / exposure | loss tolerance for the risk taken |

**Why `trendAlignment` earns its place.** Momentum and mean reversion trade at
similar rates and hold similar exposure — on features 1–5 they look alike. What
separates them is *direction*: one buys into strength, the other into weakness.
Without a signed feature the fingerprint would collapse the two strategies the
platform most needs to tell apart.

Features 7 and 8 divide by exposure for the same reason `risk_score` does: raw
NAV movement measures how much was invested, not how well it was handled.

## The fingerprint vector

`agent_dna.strategy_fingerprint` is `VECTOR(256)` per §7. **Eight dimensions
carry a measurement; the other 248 are zero.**

This is deliberate, and it is not padding for its own sake:

- **Cosine similarity is unaffected.** A dimension that is zero in both operands
  contributes to neither the dot product nor either norm, so similarity over
  these vectors is identical to similarity over the 8 real features.
- **The room is reserved, not filled.** DNA 2.0 will replace these features with
  a learned embedding that wants the space. Shrinking the column now would mean
  migrating twice.
- **No invented features.** Manufacturing 248 more numbers to look thorough
  would be noise disguised as signal. Empty is honest.

Each component is **centred on 0** rather than running 0..1. With all-positive
components every vector sits in the same orthant and cosine reads high for
agents that behave nothing alike; centring lets a high-turnover/low-exposure
agent point in a genuinely different direction from a low-turnover/high-exposure
one.

Mapping: features naturally in 0..1 become `v*2 − 1`. Unbounded ones are first
divided by a ceiling (`tradeSizePct` 0.5, `volPerExposure` 0.05,
`drawdownPerExposure` 0.20) then centred. `trendAlignment` is already signed
and passes through.

## `risk_personality` (JSONB)

Measured risk character, human-readable:

```json
{
  "avg_exposure": 0.7420,
  "max_exposure": 0.9012,
  "volatility_per_exposure": 0.0134,
  "max_drawdown_per_exposure": 0.0502,
  "avg_trade_size_pct": 0.1408,
  "position_concentration": 0.5511,
  "risk_budget_utilisation": 0.9387,
  "configured_trade_size_pct": 0.15,
  "configured_max_position_pct": 0.4
}
```

`risk_budget_utilisation` is the one that needs explaining: the ratio of the
agent's *actual* average trade size to the limit its own `risk_profile` grants
it. Both sides count entries only: a sell exits the whole position, so
averaging buys and sells together produced a ratio above 1.0 against a limit the
agent had not breached. Near 1.0 means it trades right at its declared limit; well under means it is
more cautious than it is allowed to be. It answers "how boldly does this agent
use its own allowance" — a question neither the score nor the config alone can.

The raw `features` object is nested here too, so the numbers behind the
fingerprint are inspectable rather than locked inside a vector.

## `regime_strengths` (JSONB)

How the agent fared while the market was rising, falling, or flat — bucketed
post-hoc on the market's own per-tick move (|move| ≤ 0.15% counts as flat, below
which direction is noise).

```json
{
  "up":   {"ticks": 19, "agent_return_pct": 3.41, "market_return_pct": 5.62},
  "down": {"ticks": 31, "agent_return_pct": -1.88, "market_return_pct": -6.70},
  "flat": {"ticks": 6,  "agent_return_pct": 0.02, "market_return_pct": 0.01}
}
```

> **This is not the regime classifier.** The classifier on the Mar 2027 roadmap,
> and the `regime_score` factor, are separate things. This is descriptive
> arithmetic over recorded history and **nothing here reaches the Scoring
> Engine**. `regime_score` remains a placeholder.

## Minimum participation

An agent with fewer than **5 decisions** gets **no `agent_dna` row at all** —
not a zero vector, which would sit in the table looking like a measurement and
would answer similarity queries with nonsense. `GET /v1/agents/:id/dna` returns
404 with the reason.

Same threshold as the scoring engine's participation rule, for the same reason:
below it there is conduct to describe but not enough of it to characterise.

## API

```
GET  /v1/agents/{id}/dna              summary, risk_personality, regime_strengths
GET  /v1/agents/{id}/dna/similar?limit=5   nearest behavioural neighbours
POST /internal/v1/agents/dna/compute  run one batch (driven by the timer)
```

`/similar` is why the fingerprint is a `VECTOR` and not a JSONB blob of the same
numbers: pgvector's cosine distance operator (`<=>`) answers "which agents
behave like this one" in one indexed query. Without it the column type buys
nothing.

The `/dna` response returns a readable summary plus the 8 named features, never
256 raw numbers — a wall of floats is not a profile.

## Schedule

`arcana-agent-dna.timer` → `arcana-agent-dna.service`, **daily at 11:00 UTC**
(18:00 WIB). DNA is an average over an agent's whole history, so one more tick
barely moves it; recomputing more often would re-read every market snapshot to
produce nearly the same vector. See [scheduling.md](./scheduling.md).

---

## What Foundation deliberately leaves out

Named so the gap is a decision rather than an oversight. All of it belongs to
**Agent DNA 2.0 (May 2027)**:

- **Learned embeddings.** The fingerprint is hand-specified. 2.0 derives it from
  the decision sequence itself, which is what the 248 spare dimensions are for.
- **Sequence and timing.** Every feature here is an average over the whole
  history. Order is discarded: an agent that changed character halfway through a
  season fingerprints as its own mean. Regime shifts and drift over time are
  invisible.
- **Clustering.** `/similar` compares one agent to others on demand. There is no
  clustering into named behavioural archetypes.
- **Cross-season identity.** DNA aggregates all of an agent's history rather
  than tracking how it changed from season to season. Adequate while agents have
  run one season each; revisit before the second.
- **Feeding the score.** DNA describes; it does not judge. Whether behavioural
  similarity should ever affect reputation is a product question, not a V1 one.

---

## Dependency: features that need prices need the snapshot

`tradeSizePct`, `trendAlignment`, `concentration` and every `regime_strengths`
bucket price positions and trades against the market snapshot the decision was
made on. If that snapshot is gone from `market_snapshots`, those features read
as 0 for the affected decisions — not because the behaviour was absent, but
because it cannot be seen.

Observed during the first batch: `holder_v1`'s only two trades pointed at refs
deleted during an earlier market reset, so its `tradeSizePct` came out 0 against
a configured 0.45. The fingerprint still separated it clearly, but two of its
eight features were blind.

`regime_strengths` additionally requires **both** ends of a tick pair to be
priced. Bucketing a NAV change whose starting point is unpriced attributes
several ticks of movement to a single market move — first run reported a flat
bucket at +8% while the market had gone nowhere.

The broader point is not about DNA: a decision whose market snapshot no longer
exists cannot be audited either, and §12 calls the snapshot the immutable
evidence behind the decision. Pruning `market_snapshots` while keeping
`decisions` breaks that pairing.
