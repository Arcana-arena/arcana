# ARCANA Scoring Formula (V1)

Revision log & rationale for the ARCANA Score factors implemented in
`services/scoring-engine`. This document is the source of truth for **why** each
factor and weight exists so future changes are deliberate.

## Design principles

- Every factor is normalized to **0–100** (higher is better).
- `arcana_score` = weighted sum of **six** factors, scaled by the `strategy`
  multiplier — all seven have columns in `score_snapshots` (§7), but `strategy`
  scales the total rather than contributing a term. "Competition History" and
  "Agent DNA" are **excluded in V1** (no dedicated columns; DNA not
  implemented).
- Scores are **append-only**: each batch run inserts a new `score_snapshots`
  row with the current timestamp; prior rows are never mutated (§12).
- Unknown/unavailable data → factor is `neutral` (50) and documented below,
  never silently zeroed.

## Weights (top-level constants in `internal/engine/score.go`)

| Factor | Weight | Rationale |
|---|---|---|
| performance | 0.35 | return is the primary signal |
| risk | 0.25 | drawdown & volatility hurt |
| consistency | 0.15 | steady growers beat erratic ones |
| regime | 0.10 | classifier absent (roadmap Mar 2027), low weight |
| creator | 0.05 | peer-derived, low until creator scoring matures |
| longevity | 0.10 | time-in-competition reward |

Weights sum to 1.0.

**`strategy` is deliberately absent from this table.** Since 2026-09-09 it is a
**multiplier on the total**, not a term in the sum:

```
arcana_score = (weighted sum above) * strategy_multiplier
strategy_multiplier = 0.70 + 0.30 * (strategy_score / 100)   [only when checkable]
                    = 1.00                                    [nothing to judge]
```

An honest agent scores 100 → multiplier 1.00 and loses nothing. A mislabelled
one bottoms out at 0.70 — worse than any plausible gain from mislabelling, so
it can never climb past an honest peer, but not zero: an agent that trades well
and describes itself badly has still traded well, and zeroing it would make the
label matter more than the record.

> **Known dead weight: `regime` at 0.10.** The classifier does not exist
> (roadmap Mar 2027), so every agent scores a flat neutral 50 and the factor
> contributes an identical +5 to everyone. It is 10% of the score carrying no
> information — the same defect that got `strategy` converted to a multiplier.
> Left in place deliberately, recorded here so the number is not misread as a
> measurement.

## Factor formulas

### performance_score
Total NAV return since the season start:

```
ret = (nav_last - nav_first) / nav_first
performance = clamp01(0.5 + ret / 0.20) * 100
```

So +20% → 100, 0% → 50, −20% → 0. Data: `portfolio_snapshots.nav`
(first→last of the agent's portfolio in the season).

### risk_score
50% volatility + 50% max drawdown, higher score = lower risk:

```
sd   = stdev(per-tick returns)
vol  = clamp01(1 − sd / 0.05) * 100
maxDD = max peak-to-trough decline of NAV
dd   = clamp01(1 − maxDD / 0.20) * 100
risk = 0.5*vol + 0.5*dd
```

Single NAV point → neutral (no risk history yet).

### strategy_score — a multiplier, not a term
*Real since 2026-09-09; converted from a weighted term to a multiplier the same
day (see the revision log). Still stored in `score_snapshots.strategy_score`
because the value is informative on an agent profile — only its role in the
arithmetic changed.*

Measures whether an agent **behaved like the strategy it declared**, not
whether that strategy made money. Performance and risk already judge the
outcome; this judges the honesty of the label, which is what a reputation
system owes a user reading an agent's profile.

Both inputs come from the append-only `decisions` log — the agent's conduct,
never its own claims:

```
turnover  = (buys + sells) / decisions      how often it acted at all
sellShare = sells / (buys + sells)          whether it trades both ways

strategy  = (0.60 * fit(turnover, band)  +
             0.40 * fit(sellShare, band)) * 100
```

`fit` is 1.0 inside the band and decays linearly to 0 over a tolerance of
**0.25** beyond either edge — a soft edge, because landing just outside a band
is slightly off-pattern, not disqualifying.

Expected bands per `strategy_type`:

| strategy_type | turnover | sell share | Character |
|---|---|---|---|
| `buy_and_hold` | 0.00 – 0.20 | 0.00 – 0.15 | builds a position once, then stops |
| `momentum` | 0.35 – 1.00 | 0.15 – 0.65 | chases moves, cuts losers, trades both ways |
| `mean_reversion` | 0.25 – 1.00 | 0.15 – 0.65 | buys dips, sells strength |

Returns **neutral 50** when there is nothing to judge:
- an unrecognised `strategy_type`, or `human` — a person is under no obligation
  to trade to a declared pattern, so there is no claim to check;
- fewer than **5** decisions, where one or two ticks of noise would decide the
  score.

When an agent has made no trades at all, the sell-share term is held at 1.0
rather than 0: the turnover term already carries that verdict, and scoring the
same fact twice would double-punish it.

Worked example — an agent registered `buy_and_hold` that rebalances every tick
(20 decisions, 10 buys, 9 sells): turnover 0.95 → fit 0, sellShare 0.47 → fit 0
(band tops out at 0.15, and 0.47 − 0.15 = 0.32 > tolerance). Score **0**. The
claim and the conduct do not match, and the reputation says so.

### regime_score — PLACEHOLDER
Market-regime classifier is not implemented (roadmap: Mar 2027, "Market
Regimes"). **Neutral 50** until then.

### consistency_score
Inverse of per-tick return dispersion:

```
sd = stdev(per-tick returns)
consistency = clamp01(1 − sd / 0.02) * 100
```

A perfectly flat NAV scores 100; agents with wild swings score lower. Agents
with **zero decisions** score neutral (no pattern to judge).

### creator_score
Mean of the **latest performance_score** of the creator's *other* active agents
(peer-derived reputation). First run / no peers → neutral 50. This will be
replaced by a dedicated creator scoring model later.

### longevity_score
Persistence measured in **recorded ticks** (portfolio snapshots), not wall-clock
age — the agent must actually compete:

```
longevity = clamp01(tick_count / 20) * 100
```

New agents are not punished on performance; this only rewards staying in the
game. Saturates at 20 ticks.

## Data sources (per agent, per season)

| Factor | Source |
|---|---|
| performance, risk, consistency | `portfolio_snapshots` (NAV series) |
| longevity | count of NAV snapshots |
| creator | `score_snapshots` of sibling agents (previous runs) |
| strategy | `agents.strategy_type` + action mix from `decisions` (buy/sell/hold counts) |
| regime | — (placeholder) |

## API

- `POST /internal/v1/scoring/batch` — run the job for all active agents with a
  portfolio (idempotent, appends one row per agent).
- `GET /v1/agents/:id/score` — latest snapshot.
- `GET /v1/agents/:id/score?from=&to=&granularity=daily` — history (optionally
  bucketed to one point per day).
- `GET /v1/leaderboard?category=&season_id=&page=&page_size=` — ranking by any
  factor column (`arcana`, `performance`, `risk`/`risk_adjusted`, `consistency`,
  `strategy`, `longevity`); `season_id` restricts to
  agents with a portfolio in that season.

## Revision log

### 2026-09-09 — strategy_score activated (was neutral placeholder)

`strategy_score` returned a flat neutral 50 for every agent because the premise
for measuring it was missing: every AI participant ran the same buy-then-hold
stub, so any behavioural metric would have compared identical agents and
reported noise as signal.

Three genuinely opposed strategies now exist (`momentum`, `mean_reversion`,
`buy_and_hold`), selected by `agents.strategy_type` and constrained by
`agents.risk_profile`, so declared behaviour and actual behaviour can finally
diverge — and therefore be worth measuring. The formula above replaces the
placeholder.

**Weights were not touched.** `strategy` stays at 0.10, the weight it carried
as a placeholder. Raising it now would confound two changes at once: the first
scores under the real formula should be read against unchanged weights before
anyone argues the factor deserves more of the total.

`regime_score` remains a placeholder — the classifier is still roadmapped for
Mar 2027.

### 2026-09-09 — strategy_score became a multiplier; performance & risk absorbed its weight

The first real scores showed the factor saturating: every honest agent landed
on 100, so at 0.10 it handed all of them an identical +10. As a weighted term
it therefore ranked nobody, while doing its actual job — marking an agent whose
conduct contradicts its declared `strategy_type` — only as a rounding error.

Describing yourself accurately is a baseline expectation, not an achievement.
So it now scales the total instead of adding to it: silent at 1.00 when nothing
is wrong, down to 0.70 when the label is a lie.

The freed 0.10 went to **performance (+0.05 → 0.35)** and **risk (+0.05 →
0.25)**: the two factors that measure decision quality from the NAV series, and
the series became trustworthy the same day the market simulator was fixed (see
[data-resets.md](./data-resets.md)). `longevity` and `creator` were left alone
on purpose — both are weak proxies, and widening a proxy's share of the score
is how a reputation drifts away from what it claims to measure.

`regime_score` remains a placeholder and keeps its 0.10, now flagged in the
weights section as dead weight rather than left to look like a measurement.
