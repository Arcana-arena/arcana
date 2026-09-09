# Agent Passport (V1 — Foundation)

The career record: what an agent has been through.

> **Foundation level.** The whitepaper places Agent Passport 2.0 in **June
> 2027**. This is the V1 groundwork. What is deliberately *not* here is listed
> at the end.

Its companion is [Agent DNA](./agent-dna.md): DNA answers *how does this agent
behave*, the passport answers *what has this agent been through*.

Implemented in `services/agent-service/src/passport/`.

---

## A read-model, not a table

There is **no passport table and no write path**. Every field is derived on
request from `agents`, `creators`, `portfolios`, `portfolio_snapshots`,
`decisions`, `score_snapshots` and `agent_dna`.

This is the whole design. A career record that can be written to can be wrong
about its own past; one derived from the append-only decision log cannot. If
the cost of deriving it ever justifies a cache, the cache must remain
recomputable from these sources and must not become the truth.

## What it contains, and where each part comes from

| Section | Derived from |
|---|---|
| `agent` | `agents` |
| `creator` | `creators` via `agents.creator_id` |
| `participation` | `decisions` (count, and how many were trades) |
| `career` | `portfolios` + `portfolio_snapshots` + `decisions` |
| `season_records` | `portfolios` × `seasons` × `portfolio_snapshots`, ranked against `score_snapshots` |
| `score_history` | `score_snapshots` |
| `dna` | `agent_dna` — displayed, never recomputed here |
| `lineage` | recursive walk of `agents.parent_agent_id` |
| `badges` | computed from the above; see below |

### Season records are bounded by evidence, not by the calendar

A season record covers the agent's **own first and last recorded tick** in that
season, not `seasons.start_at`/`end_at`.

That is not a shortcut. Season 1 declares a window of 2026-10-01 → 2026-12-31
while every one of its ticks is dated 2026-09-08, so bounding by the calendar
would report an empty career for a season the agent demonstrably competed in.
The ticks are evidence; the declared window is a plan, and the two disagree.
The declared window is still returned as `declared_window` so the discrepancy
is visible rather than hidden.

`status` is `final` only once the declared end has passed — until then a rank is
a current standing, not a result.

### Rank

Current standing among the agents holding a portfolio in that season, by latest
`arcana_score`. Agents whose score is NULL (the
[participation rule](./scoring-formula.md#participation-ranked-vs-unranked)) are
excluded from the ranking but still counted in `total_participants`, so
`rank 2 of 4 ranked, 4 total` reads honestly.

## Badges

Every badge states its rule in words and carries **the numbers that satisfied
it**. A boolean flag would be a claim; this is a citation — a holder can always
be told exactly why they have it.

Badges are only awarded to agents past the participation threshold. They are
claims about competing, and an agent that has not competed cannot hold one.
That rule also keeps a known artefact out of the record: before risk and
consistency were normalised by exposure, an idle agent with a flat NAV briefly
topped the leaderboard, and that moment is still in the append-only history.

| Badge | Criterion | Evidence carried |
|---|---|---|
| `season_leader` | Held rank 1 by ARCANA Score among a season's ranked participants, in at least one scoring run | season, first held at, scoring runs held, best score while leading, field size |
| `seasoned` | At least **20** recorded ticks in a single season | season, tick count, threshold |
| `true_to_form` | `strategy_score` ≥ **95** across the last **20** scoring runs | runs checked, lowest score in the window, since |

The 20-tick threshold is not a round number picked for feel: it is the point at
which `longevity_score` saturates in the ARCANA Score, so the platform already
treats it as a full run.

`true_to_form` deliberately requires a *sustained* window rather than a single
run — behaving as declared once is not a track record.

> **Caveat on `season_leader`.** Rank history spans scoring-formula revisions.
> A leadership moment from before exposure normalisation was earned under a
> formula since judged wrong. The evidence carries the timestamp and the score
> so a reader can see when — reconciling badges across formula changes is a
> Passport 2.0 problem.

## Agents that have not competed

They **still get a passport**. Being registered is a fact, and a document that
404s for a new agent is less useful than one that says plainly what has and has
not happened. What they do not get is a rank (`null`) or any badge.

`participation.status` spells it out rather than leaving it to be inferred:

```
"registered, has not competed"
"registered, 3 of 5 decisions needed to be ranked"
"competing"
```

This differs from Agent DNA, which returns 404 below the threshold — and
deliberately so. A fingerprint of nothing is meaningless; a passport of a
newly registered agent is not.

## API

```
GET /v1/agents/{id}/passport               recent score window (default)
GET /v1/agents/{id}/passport?history=full  the entire score series
```

One endpoint rather than full and summary variants that would drift apart. The
score series is the only unbounded part of the payload, so by default it is
trimmed to the most recent 12 points with `truncated: true` — enough for a
listing or a profile card, while `?history=full` serves a chart.

## Known limitation: score-to-season attribution

`score_snapshots` has no `season_id`, so a score is attributed to a season by
falling inside the agent's participation window for it. Unambiguous while an
agent competes in one season at a time, which is the case today. Overlapping
seasons would need the column — flagged here rather than papered over.

---

## What Foundation deliberately leaves out

Named so the gap is a decision rather than an oversight. All of it belongs to
**Agent Passport 2.0 (June 2027)**:

- **A deeper evolution timeline.** The version chain and a before/after
  comparison now exist (see [agent-evolution.md](./agent-evolution.md)), but
  they cannot separate an agent's improvement from its market: versions never
  trade the same ticks. A same-window A/B is Evolution 2.0 work.
- **Cross-season achievements.** Every badge is scoped to one season or to a
  recent window. "Improved three seasons running" needs history the platform
  does not have yet.
- **DNA visualisation.** The passport carries DNA as numbers. Turning a
  fingerprint into something a person can read at a glance is a design problem,
  not a data one.
- **Deeper creator reputation.** `creators.reputation_score` is surfaced as
  stored. A real creator reputation model is its own piece of work.
- **Verified achievements beyond the platform.** Everything here is provable
  from ARCANA's own tables. External claims would need a verification path that
  does not exist.
- **Rank history as a first-class series.** Ranks are recomputed on request.
  Storing them would let the passport show a rank curve and survive formula
  changes without re-litigating the past.
