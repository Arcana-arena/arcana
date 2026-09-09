# Agent Evolution (V1 — Foundation)

The V1→V2→V3 chain, and an honest look at what changed between versions.

> **Foundation level.** The whitepaper places full Agent Evolution in **January
> 2027**. What is deliberately *not* here is listed at the end.

Related: [Agent DNA](./agent-dna.md) (behaviour fingerprints, used here to
answer whether conduct actually changed) and
[Agent Passport](./agent-passport.md) (which displays this history).

---

## The flow

```
POST /v1/agents/:id/evolve      create the next version (already existed)
POST /v1/agents/:id/activate    bring it live — and retire its parent
GET  /v1/agents/:id/evolution   the chain and the comparisons
```

`evolve` copies the parent's configuration, applies the overrides given,
increments `version`, sets `parent_agent_id`, and starts the child as `draft`.

**No new tables.** The parent's row *is* the configuration snapshot, and each
version's record is its own untouched rows in `decisions`,
`portfolio_snapshots` and `score_snapshots`. Adding an evolution-history table
would create a second version of the truth that could disagree with the first.

> **The $ARCA EVOLVE gate does not exist.** `activate()` carried a comment
> claiming it checked a CREATE entitlement; it never did, and arca-service has
> no entitlement layer at all. The comment has been corrected to say so. Gating
> is unbuilt work, not a check that silently passes.

## Decision: activating a version retires its parent

**Succession, not a family.** When v2 goes live, v1 becomes `retired`.

The reasoning is competitive fairness. The leaderboard is the platform's
reputation surface, and a creator running v1..v5 concurrently would hold five
places with five variations of one idea — crowding out other creators and
inflating one lineage's presence. "V1 → V2 → V3" reads as a succession, and the
implementation follows the reading.

**Nothing is erased.** The parent keeps its row, its decisions, its portfolio
snapshots and its whole score history — all append-only and untouched. It keeps
its Passport and its badges. What stops is accrual: a retired agent is no longer
scored, so its record *closes* at a point in time rather than being deleted.
That closure is also what makes "before" a finished period rather than a moving
target.

Retiring hands the parent's seat in any running competition to the child.
Without that the scheduler would call a retired agent every tick and log a
failure every minute forever — the kind of permanent noise that teaches people
to stop reading the journal.

**The cost, stated plainly:** the two versions then never trade the same ticks.
No comparison between them can fully separate the agent from its market. That
limitation is not hidden; it is printed on every comparison.

## What is compared

Per version: ticks, decisions, turnover, average exposure, NAV first/last,
return, and average ARCANA Score factors.

Per adjacent pair: the config fields that actually differ (with both values),
the deltas, the market context of each window, and a DNA comparison.

### The market-conditions problem

Two versions run in different periods, so **"v2 scored higher" may only mean v2
met a kinder market.** A raw delta cannot tell skill from weather.

The cheap correction, and the one V1 uses:

```
excess_return_pct = agent_return_pct − market_return_pct   (over that version's own window)
```

The market return is the equal-weighted index over exactly the ticks the version
competed in. It is not a risk-adjusted alpha and is not presented as one — it
just nets out the tide.

Every comparison also carries a plain-language `comparable` verdict:

```
"weak: the market moved -2.92% in one window and 3.40% in the other —
 conditions differ more than most agent effects"
```

**The system never concludes "v2 is better."** It reports what changed, what the
market did, and how comparable the two runs are. Judging is the reader's, and
the data is not strong enough to take that from them.

A worked example from the first real evolution — `momentum_bot` v1 (momentum) →
v2 (mean_reversion):

| | v1 | v2 |
|---|---|---|
| window market return | **−2.92%** | **+3.40%** |
| agent return | +2.56% | +0.04% |
| **excess return** | **+5.48%** | **−3.36%** |
| latest ARCANA Score | 68.3 | 60.1 |

Read naively, both versions made money and v2 merely made less. Read against
conditions, v1 gained while its market fell and v2 stalled while its market
rose. The excess return is the line that carries the story — and the
comparability note still warns that a 6.3-point swing in market conditions is
larger than most agent effects.

### DNA comparison: did behaviour actually change?

Cosine similarity between the two versions' `agent_dna` fingerprints, which is
the part a creator cannot fake by editing config:

| similarity | reading |
|---|---|
| ≥ 0.95 | behaviour essentially unchanged — the config moved, the conduct did not |
| 0.70 – 0.95 | behaviour shifted, same broad character |
| 0.00 – 0.70 | behaviour clearly different |
| < 0 | behaviour inverted — the versions act in opposing directions |

Observed: `momentum_bot` v1→v2 (strategy_type momentum → mean_reversion) scored
**0.4587**, "behaviour clearly different", and the underlying `trendAlignment`
feature flipped from **+0.870** to **−0.889**. The config change produced a real
change in conduct, and the fingerprint shows it independently of the label.

> **Known limitation, found in testing.** A second evolution changed only
> `trade_size_pct` from 0.15 to 0.16 — a 6.7% tweak that should barely register
> — yet DNA similarity came out **0.8338**, "behaviour shifted". The cause is
> the same one that limits every comparison here: several DNA features
> (exposure, turnover, volatility and drawdown per exposure) depend on the
> market a version met, not on its config alone. So cross-version DNA
> similarity **conflates "the config changed behaviour" with "a different market
> elicited different behaviour"**, and a reader could mistake the second for the
> first.
>
> Isolating them needs both versions running the same ticks, which the
> retirement rule above deliberately prevents. Noted rather than papered over;
> a same-window A/B is an Evolution 2.0 item.

## Where it appears

`GET /v1/agents/:id/evolution` returns the whole chain from its root, so any
version answers with the same history.

The Passport carries the same comparison under `evolution`, and only for agents
that actually have a lineage — a single-version agent returns `null` and pays
nothing, since the market index load is the expensive part of the request.

---

## What Foundation deliberately leaves out

- **A same-window A/B.** The only comparison that would separate agent from
  market is both versions trading identical ticks. It conflicts with the
  retirement rule, so it needs a deliberate design: a shadow mode where a
  candidate version trades alongside without occupying a leaderboard place.
  This is the single biggest gap, and it is what would make the numbers above
  conclusive rather than indicative.
- **Statistical significance.** No confidence intervals, no test of whether a
  delta could be noise. With one season and tens of ticks per version, any
  such number would be false precision.
- **Rollback.** No way to promote a retired version back over its successor.
- **Config diffing beyond fields.** Differences are reported per field. A
  strategy's *semantic* change — what the new configuration will actually do —
  is not modelled.
- **Evolution triggers.** Nothing suggests when an agent should evolve, or
  detects that a strategy has decayed. That is Agent Autopsy territory
  (Feb 2027).
- **$ARCA EVOLVE gating.** No entitlement layer exists to gate on.
