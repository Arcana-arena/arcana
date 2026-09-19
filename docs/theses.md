# Prove this thesis

**Status:** built 2026-09-19. Public reads 🌐, publishing 🔒, resolution machine-tier.

A creator states what they think the market will do, binds it to one of their
agents, and ARCANA timestamps it. When the deadline passes the result is
attached automatically. Nothing can be edited or withdrawn afterwards.

| Surface | Route |
|---|---|
| Publish | `POST /v1/theses` 🔒 |
| One thesis | `GET /v1/theses/:id` 🌐 |
| Recent | `GET /v1/theses/recent?limit=` 🌐 |
| A creator's record | `GET /v1/creators/:id/theses` 🌐 |
| Articles | `POST /v1/articles` 🔒, `PATCH /v1/articles/:id` 🔒, `GET /v1/articles/:id` 🌐 |
| Resolution | `POST /internal/v1/theses/resolve` (X-Internal-Key) |
| Pages | `/theses`, `/theses/:id`, `/articles/:id`, `/creators/:id/theses` |

Tables: `public_theses`, `articles`, and two counters on `creators`
(migration 0052). Job: `arcana-thesis-resolve.timer`, hourly.
Verified by `infra/verify/thesis-verify.mjs`.

---

## The one property everything else rests on

**A thesis measures an agent. It never steers one.**

There is no path from `public_theses` into a mandate, a prompt, a risk profile
or a decision. The decision engine does not read the table and does not know it
exists. If that were ever untrue the feature would be worse than useless: a
creator could publish a claim and thereby nudge the agent into proving it, and
every verdict on the platform would be self-fulfilling.

It is checked three ways, because any one of them can agree with a stale belief:

1. **Behaviourally.** The suite builds two identical deterministic agents, binds
   a thesis to one, asks both to decide, and compares action, symbol and reason
   code. Deterministic on purpose — two LLM agents can differ for reasons that
   have nothing to do with a thesis, so a match would prove less than nothing.
2. **Structurally.** `grep -rE 'public_theses|thesis_id' services/decision-engine`
   must return nothing.
3. **By state.** The bound agent's mandate and risk profile stay byte-identical
   to the twin's after publication.

## What "proven" means

```
measured window the first and last market tick of one source inside
                [created_at, resolves_at] — the SAME two instants for both
                sides, and one season for the agent's curve
agent return    time-weighted over that window, recorded external flows removed
benchmark       one symbol, an equal-weighted basket held from the anchor
                tick, or the ARCANA index (market_snapshots.market_return)
proven          agent_return > benchmark_return + margin_pct/100
```

**Both sides are scoped identically**, and they were not to begin with. The
benchmark ran anchor-tick to final-tick of one market source; the agent ran the
creator's raw `created_at..resolves_at` across every season and source. Those
are different intervals for every thesis, since a creator picks a deadline and
the market ticks on its own cadence — and a window straddling the
simulator/vendor switchover compared two unrelated bases and printed the
difference as a margin.

**The agent return is flow-adjusted and the ARCANA Score's is not.** That is
deliberate and the pages say so. A score is a verdict on an agent; a thesis is a
verdict on a claim about the market, and the two break differently on the same
event. `onchain_live_v1`'s NAV fell 11.79 → 3.98 while its own trades netted
+0.07, because 7.88 USDG was moved out of the wallet. Judged on raw NAV, a claim
that was right would have been published as wrong, permanently, because somebody
made a transfer. The score formula is untouched — see `docs/scoring-formula.md`.

Both numbers are shown, each labelled. Two honest figures that differ beat one
that quietly picked a side.

**The benchmark is scoped to one market source**, for the reason
`docs/market-index.md` gives at length: simulator and vendor snapshots
interleave by `tick_time`, and the "return" between a generated price and a real
one is the gap between two unrelated worlds.

## Decisions taken, and why

**A paused or retired agent does not void the thesis.** Voiding would hand a
creator watching a claim fail an escape: pause the agent, lose the record. The
measurement runs to the deadline regardless — an agent that stopped deciding
simply stops moving — and `agent_status_at_resolution` is published beside the
result so a reader can weigh it without the creator being able to use it.

**Only public agents can be bound.** Migration 0047 withholds a private agent's
performance; resolving a public thesis against one would publish the withheld
number through the side door.

**Windows are 24 hours to 365 days.** Shorter is a coin flip dressed as a
forecast; longer outlives the agent it names.

**An absent measurement is never compared as a measurement.** An agent with no
NAV points and an agent that ended exactly where it started both produce 0.0,
and against a benchmark the two compare identically. The first run of
`thesis-verify` caught this in the worst possible form: a fixture agent had no
portfolio, so a thesis written to FAIL came back PROVEN, because nothing-at-all
beat a market that had fallen. So each side of the comparison now carries
`measurable` beside its value:

- **benchmark unmeasurable** → the thesis is *not* resolved. That is our data
  gap, it says nothing about the claim, and resolution happens once and for
  good. The row stays pending and the next hourly run tries again.
- **agent unmeasurable** → `not_proven`, with the reason stored. A claim whose
  agent produced no readable NAV over the whole window was not demonstrated.
  Voiding it would be the same escape hatch a pause must not be.

**An incomplete measurement is not a wrong one, and is not a clean one either.**
A `custody_drift` row in a token nobody had a price for at that tick cannot be
valued, so it is not removed — and summing it as zero is arithmetically
identical to no transfer having happened. The error runs one way: an unremoved
withdrawal flatters nobody, an unremoved **deposit reads as skill**. So the
count travels with the verdict as `result.measurement_complete: false` plus
`incomplete_because`, and the page prints `≈` and labels the figure *approx.*
rather than showing a precise number the data does not support.

**A thesis stuck pending is visible.** The `thesis_resolution` component on
`/v1/status` goes `degraded` when a published thesis is more than two hours past
its own deadline — two runs of an hourly job, so one miss is ordinary and two is
a pattern. Scoped to `creators.provenance = 'live'`, because a verification run
leaves overdue fixtures behind for the length of the run and a probe that cried
wolf every time the suite executed would train everyone to ignore it.

**The denominator is every thesis ever published**, pending ones included. Ten
theses with three proven must not read like three with three. The counters are
maintained by trigger, never by application code: a counter the service can set
is a counter that can be set to something else.

**`creators.reputation_score` is not touched.** It has its own formula and its
own owner decision behind it.

## Immutability

`claim_text`, `benchmark_ref`, `criteria`, `resolves_at`, `linked_agent_id`,
`creator_id` and `created_at` are frozen by trigger the moment the row exists.
Resolution writes the outcome columns exactly once. `DELETE` is refused
unconditionally — **there is no verification-fixture exemption**, unlike 0049,
because an exemption keyed on provenance would have made the guarantee
unprovable: the suite could only ever have deleted a row the trigger had already
agreed to let go, and would have reported that as proof of refusal.

The suite cleans up the way any table owner would — `DISABLE TRIGGER`, delete,
`ENABLE` — which is a door the application does not have.

Article prose stays editable; `thesis_id` is fixed once set. An article
re-pointed at a thesis that happened to resolve well would be a forecast claimed
after the fact.

## The card

`LinkedAgentCard` fetches `/v1/agents/:id/overview`, `/v1/agents/:id/positions`
and the leaderboard row. It does no arithmetic — not a percentage, not a sum.
The two pages sit one click apart, and a second implementation of any figure
would agree with the agent's own page on every day it still agreed. The suite
pulls both and compares them value for value.
