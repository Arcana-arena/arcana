# ARCANA Scoring Formula (V1)

Revision log & rationale for the ARCANA Score factors implemented in
`services/scoring-engine`. This document is the source of truth for **why** each
factor and weight exists so future changes are deliberate.

## Design principles

- Every factor is normalized to **0–100** (higher is better).
- `arcana_score` = weighted sum of the **seven** factors that have columns in
  `score_snapshots` (§7). "Competition History" and "Agent DNA" are **excluded
  in V1** (no dedicated columns; DNA not implemented).
- Scores are **append-only**: each batch run inserts a new `score_snapshots`
  row with the current timestamp; prior rows are never mutated (§12).
- Unknown/unavailable data → factor is `neutral` (50) and documented below,
  never silently zeroed.

## Weights (top-level constants in `internal/engine/score.go`)

| Factor | Weight | Rationale |
|---|---|---|
| performance | 0.30 | return is the primary signal |
| risk | 0.20 | drawdown & volatility hurt |
| consistency | 0.15 | steady growers beat erratic ones |
| strategy | 0.10 | weak proxy in V1, kept low |
| regime | 0.10 | classifier absent (roadmap Mar 2027), low weight |
| creator | 0.05 | peer-derived, low until creator scoring matures |
| longevity | 0.10 | time-in-competition reward |

Weights sum to 1.0.

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

### strategy_score — PLACEHOLDER
A decision-mix proxy was judged too weak for V1 (all AI agents currently share
the same buy/hold stub, so the signal would be noise). **Neutral 50** until
real strategies differentiate. Revisit when strategy_type drives actual
behaviour differences.

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
| strategy | `agents.strategy_type` (unused in V1 placeholder) |
| regime | — (placeholder) |

## API

- `POST /internal/v1/scoring/batch` — run the job for all active agents with a
  portfolio (idempotent, appends one row per agent).
- `GET /v1/agents/:id/score` — latest snapshot.
- `GET /v1/agents/:id/score?from=&to=&granularity=daily` — history (optionally
  bucketed to one point per day).
- `GET /v1/leaderboard?category=&season_id=&page=&page_size=` — ranking by any
  factor column (`risk_adjusted` aliases `risk_score`); `season_id` restricts to
  agents with a portfolio in that season.
