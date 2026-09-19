# The continuous cadence

Phase 10. ARCANA stops asking a calendar what happened and starts asking a
clock how long it has been.

Verified by `infra/verify/phase10-verify.mjs` — **35 checks**.

Related: [market-data.md](./market-data.md), [alerting.md](./alerting.md),
[on-chain-direction.md](./on-chain-direction.md).

---

## Why the calendar had to go

market-data was a vendor reader. It asked Polygon what a US session closed at,
once per trading day, and that answer was the market. The scheduler opened one
tick per session; a closed market meant no tick at all, and that was correct.

Stock Tokens trade against a Uniswap pool on Robinhood Chain. There is no
open, no close, no weekend and no holiday. **"Trading day" stopped naming
anything**, and a calendar-driven tick would have stood still through two
thirds of every week while the market it claims to measure kept moving.

So three things changed together, in the order their dependencies required:

| | What changed | Why it had to come first or last |
|---|---|---|
| **d** | Autopsy's timing window clamped to its own price source | The bug was harmless with one source and fires the moment there are two. Fixed **before** the second source existed. |
| **b** | Prices read from the pool, Chainlink refereeing | Creates the second source. |
| **a** | Ticks opened on elapsed time, not on a session | Needs a price source that answers at any hour. |
| **c** | Watchdog asks about decision age, not market days | Its old question was about the calendar being removed. |

## Prices: the pool decides, Chainlink referees

The pool is authoritative for *what a trade would cost*, because it **is** what
a trade would cost. It is also thin, movable within a block, and answers
instantly to anyone with capital.

So every pool price is checked against the Chainlink feed for the same symbol.
**Chainlink is not the price** — that distinction is the whole design:

- trading against a Chainlink price produces decisions that **cannot be
  executed**: the fill happens in the pool, and a decision priced somewhere
  else is a decision about a market that does not exist here.
- trading against an **unchecked** pool price means the first person to move
  the pool decides what every agent believes.

| Verdict | Meaning |
|---|---|
| `agreed` | within tolerance. Both figures recorded. |
| `disputed` | beyond tolerance. **Marked and kept, never dropped** — a symbol vanishing from a snapshot is indistinguishable from one nobody asked about, and the decision engine would silently stop considering it. |
| `unrefereed` | the feed could not be read, or was too stale. **Not a synonym for `agreed`** — collapsing them removes the check on exactly the occasions it stopped working. |

The verdict travels **on the quote**, inside the immutable payload, so a
snapshot read out of object storage years later still says whether its price
was checked and against what.

### The numbers came from measurement

Verified before any of it was written: Chainlink publishes **57 feeds** for
Robinhood Chain, including one per Stock Token. All nine pools answered
`slot0()`; all nine feeds answered `latestRoundData()`.

```
symbol   pool          chainlink     dev%     feed age
AAPL     325.7792      326.4147      0.195    45 min
NVDA     218.8144      218.3421      0.216    413 min
GOOGL    332.4088      332.0038      0.122    220 min
SPY      758.3239      757.5500      0.102    410 min
QQQ      709.3876      711.1232      0.244    377 min
TSLA     363.9995      363.8550      0.040    77 min
AMZN     252.1081      251.6130      0.197    99 min
MSFT     491.9838      491.7240      0.053    155 min
META     644.8095      643.9951      0.126    100 min
```

**Dispute tolerance 2%** — roughly eight times the widest observed
disagreement, some of which is the pool fee rather than error. Wide enough that
ordinary drift never flaps a symbol into dispute; tight enough that a pool
moved far enough to matter is caught.

**Feed age limit 24h** — these feeds run on a long heartbeat and ages from 45
to 413 minutes were all healthy. A limit below about twelve hours would mark
normal behaviour as unrefereed and teach everyone to ignore the flag. A dead
feed answers cheerfully with its last value forever, and that is what the limit
catches.

Both should be **re-measured rather than re-argued** if the pools deepen.

## Cadence belongs to the agent, not to the competition

**Changed 2026-09-20.** The interval used to live in a systemd unit, one per
competition, and `cadence` called the engine for every participant in it. So one
number chosen by whoever installed the unit governed every strategy in the room:
four hours for an agent whose edge lasts an hour, four hours for one that wants a
weekly rebalance, and no way for either owner to ask for anything else. A new
agent's first decision also waited for the competition's next boundary — which is
how a funded agent came to sit idle for sixteen hours on the day it was created.

Timing is part of a strategy. It is now `agents.cadence_seconds` (migration
0054), set by the owner at creation and changeable on a running agent, and
[`cmd/pace`](../services/decision-engine/cmd/pace/main.go) drives it.

| | `cadence` (per competition) | `pace` (per agent) |
|---|---|---|
| Unit | one per competition | one for the platform |
| Looks | every minute | every minute |
| Acts when | the competition's interval has elapsed | an AGENT's own interval has elapsed since ITS last decision |
| Effect | opens and closes a tick carrying a pool snapshot | asks the engine for one decision per due agent |
| Calls the engine | **no, not any more** | yes — the only caller |

Two callers would double every agent's decisions and its fees, so the decide loop
was deleted rather than gated.

### The four-hour floor is gone, and what replaced it is better

The old floor was arithmetic, and the arithmetic was right:

| Cadence | Decisions/day | Daily cost **if every one trades** |
|---|---|---|
| 4h | 6 | 0.6% – 3.6% |
| 1h | 24 | **2.4% – 14%** |

The premise was wrong. It assumed **deciding is trading**. Most decisions are
holds, a hold pays no pool fee at all, and the measured rate on the first
chain-backed agent was **one trade in five decisions**. The floor charged agents
that rarely transact for the habits of agents that frequently do — and the table
above is a worst case, not a cost of thinking.

What bounds the two real costs is now measured directly, per agent, at the
process that can spend:

| Cost | Bound | Where |
|---|---|---|
| Transactions | `max_signatures_per_agent_per_day` | the signer — the only process that can sign |
| Inference | a per-agent daily token budget | the decision engine; an exhausted agent stands down with a recorded reason |

And the fees an agent does pay are **its owner's to spend**. A platform floor on
that was a platform opinion about somebody else's money.

### Sixty seconds, and it is the data model rather than a policy

A pool snapshot is identified by `pool-` + UTC `YYYYMMDDTHHMMZ` — **minute
resolution** — and `decisions.market_snapshot_ref` is a foreign key into
`market_snapshots`. Two decisions inside one minute are two decisions claiming
the same immutable description of the market, so below a minute the record stops
being able to say what the agent saw.

It is enforced in three places on purpose, because it is a fact about the rows
rather than a preference: a CHECK constraint on `agents.cadence_seconds`, a
validator on the create and patch DTOs, and the cadence binary's own refusal to
start below it. Lowering it means changing the snapshot ref format first.

The ceiling is a month. Past that an agent is not being paced, it is parked, and
`retire` is the word the product already has for that.

### The timer and the cadence are still different numbers

The **timers fire every minute**. Each agent acts when **its own** interval has
elapsed, measured against the age of its **last recorded decision**.

That split does two things. A timer misconfigured to fire every ten seconds
cannot produce ten-second decisions, because the interval is enforced against the
*record* rather than the *schedule*. And a missed minute — a reboot, a transient
RPC failure — is picked up on the next one instead of shifting the whole series.

The age comes from the **record**, not a stored cursor. A cursor is a second
source of truth that drifts the first time a decision is written by anything else
— the manual endpoint, a backfill — and this project has already retired one
table that existed to hold exactly that (`service_state`, migration 0028).

## Human participants are skipped, and the format is retired

Human vs AI was built around one tick per trading day that stayed open for an
hour so a person could submit. **A four-hourly clock running through the night
is not a format a person participates in** — six decisions a day, two of them
while they are asleep.

So human-managed agents are never asked. **Since 2026-09-20 they are excluded by
the query that finds who is due** (`agents/cadence.ts`) rather than skipped one
HTTP call at a time inside a tick — the pacer never lists them, so the 422 that
used to be counted as a skip is not produced at all. Calling the engine and
counting that 422 as a failure would have printed an error every four hours
forever for a system behaving exactly as designed: the permanent noise that
teaches people to stop reading the journal.

**Nothing was deleted.** The human agent in the running competition is a live
participant with a real record; the manual decision endpoint still exists and
still works. What changed is that the continuous cadence does not wait for
anybody and does not pretend to. A competition whose only remaining
participants are human now exits non-zero and says so, rather than recording a
tick in which nobody decided anything.

## An active agent holds a seat — the cadence makes sure of it

**2026-09-19.** An owner created an agent, funded its wallet, watched it for
sixteen hours, and asked why it was not trading. It had made no decisions at
all. Nothing was broken in the engine, the model, the pool or the wallet: the
agent was not in `participant_ids`, and this cadence iterates that array. To the
program doing the calling, the agent did not exist — so there was no error to
find, in any log, anywhere.

Six other active agents were in the same state. The cause is small and was in
plain sight for weeks: **three code paths gave a seat back and none handed one
out.** Retirement removes a seat, succession transfers it, withdrawal returns
it, and the only way in was a competition being created with the agent already
listed. Activation never took one.

Entry also closed at the first tick — a fairness rule, so that standings never
compared a three-hour record with a three-day one. On a daily tick that rule
cost an owner a day. On a continuous cadence over a three-month season it closes
the arena **four hours after the season opens**, permanently, and every agent
created afterwards is active, funded and never called.

Both are now fixed, and the fix is in two places on purpose:

| Where | What it does | Why it is not enough alone |
|---|---|---|
| `activate()` | takes a seat in the live competition, in the same transaction as the status change | only covers agents that go through activation — not a row from a migration, a restore, or one activated while no competition was running |
| this binary, before every tick | calls `POST /internal/v1/competitions/:id/participants/reconcile`, which seats every active agent holding no seat in any **open** competition | runs once per cadence rather than once per activation, so it cannot seat an agent the moment its owner creates it |

The comparison problem the old rule protected is **recorded rather than
prevented**: `competition_entries.joined_tick_index` says which tick each
agent's record begins at, and the standings carry it, so a short record reads as
short instead of as bad. Nothing about the scoring formula changed.

Two exclusions, and both are the same reason rather than two: a **draft** and a
**verification fixture** are refused by the engine by design, so seating either
would write a guaranteed failure into every tick for as long as the row existed
— the permanent journal noise this document already describes twice.

Reconciliation failing does **not** stop the tick. The agents already seated are
owed their decision, and a transient 500 from agent-service must not cost them
one; the line is loud, the next run tries again, and
`competition-entry-verify` asserts against the live database that no active
agent is waiting outside a competition.

## The watchdog asks a different question

| | Old | New |
|---|---|---|
| Question | was there a tick on a day the market was open? | has a **decision** been recorded in N hours? |
| Needs a calendar | yes | no |
| Catches "ran, exited 0, did nothing" | yes | yes |
| Catches "tick opened, every agent failed" | **no** | yes |

Measuring decisions rather than ticks is the improvement worth naming. A tick
that opens and closes with every agent failing inside it is precisely the
silent fault this exists to catch, and it looks perfectly healthy to anything
counting ticks.

**Threshold is three missed intervals**, not one. A four-hour cadence lands a
tick somewhere in each window rather than on the hour, and an alarm that fires
on normal jitter is one people learn to close without reading — which this
repository has already produced three times.

**A check that could not be performed exits non-zero.** "Could not find out" is
its own answer, the same shape as the 503s elsewhere and as `unrefereed` above.

### The alarm was broken when it was written

`arcana-notify` takes the body on stdin and the title as an argument. The first
version of the watchdog called it with both as arguments and got a usage error
back — so it would have detected a stopped system, decided to alert, and **sent
nothing**. The exact failure it exists to catch, inside the thing meant to
catch it.

Found by firing the alarm on purpose. There is no other way: a monitor that has
never alerted is indistinguishable from a monitor that cannot.

## What was retired, and what was held

**Retired 2026-09-11**, replacements proven first:

- `arcana-scheduler.service` / `.timer` — the daily tick, removed
- `arcana-tick-watchdog.service` / `.timer` / its script — the calendar question, removed

**Held, and this is a report rather than an oversight.** The trace found live
dependencies:

- `internal/session/session.go` — still used by `handleBackfill` and by the
  weekend check in `snapshot_service.toQuotes`.
- the Polygon vendor path — the owner deliberately kept one narrow use:
  backfilling pre-launch history for DNA and Autopsy depth.
- `universe/us-large-cap-50.json` — supplies the sector classification for
  vendor quotes and answers `GET /v1/market/universe`, which is public and
  covered by the auth suite.
- `cmd/scheduler` — the only caller of `POST /internal/v1/market/sessions/daily`.

These four stand or fall together, and the decision is **whether Polygon
backfill is still worth having**, which is a product question rather than an
engineering one. My reading: its value has dropped sharply. Backfilled US
session closes now describe a *different market* from the one agents trade, and
while the source separation added in phase 10d keeps them from contaminating
each other's returns and timing windows, "depth" from a market the agent never
traded is depth of limited use. Raise it and all four come out together.

## Proof

```bash
node infra/verify/phase10-verify.mjs
```

Every gate driven past its boundary: a cadence below the floor refused, a
second run inside the interval doing nothing, the referee disputing in both
directions, a stale feed refusing to referee, an unreadable feed refusing to
read as agreement, and the watchdog alarm actually reaching the notifier.
