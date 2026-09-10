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

## The four-hour floor is arithmetic

Every decision that trades pays the pool fee: 5 bp on the tight pools, 30 bp on
the rest. A round trip is therefore **10 to 60 bp of NAV**, before slippage and
before gas.

| Cadence | Decisions/day | Daily cost if every one trades |
|---|---|---|
| 4h | 6 | 0.6% – 3.6% |
| 1h | 24 | **2.4% – 14%** |

No edge survives the second row. Below four hours the fee schedule decides the
outcome and the agent does not.

**The binary refuses to start below the floor rather than clamping.** Silently
raising a number somebody set means running a cadence nobody chose, and the log
line saying so scrolls away.

### The timer and the cadence are different numbers

The **timer fires hourly**. The **binary acts every four hours**, measured
against the age of the last recorded tick.

That split does two things. A timer misconfigured to fire every ten minutes
cannot produce ten-minute decisions, because the floor is enforced against the
*record* rather than the *schedule*. And a missed interval — a reboot, a
transient RPC failure — is picked up within the hour instead of waiting for the
next four-hour boundary. Under a continuous cadence there is no market-closed
excuse for a gap, and the backfill rule still forbids filling a scored season
backwards, so a missed interval is a permanent hole in the record.

The age comes from the **record**, not a stored cursor. A cursor is a second
source of truth that drifts the first time a tick is inserted by anything else,
and this project has already retired one table that existed to hold exactly
that (`service_state`, migration 0028).

## Human participants are skipped, and the format is retired

Human vs AI was built around one tick per trading day that stayed open for an
hour so a person could submit. **A four-hourly clock running through the night
is not a format a person participates in** — six decisions a day, two of them
while they are asleep.

So the cadence skips human-managed agents with one log line, rather than
calling the engine and counting the resulting 422 as a failure. That would have
printed an error every four hours forever for a system behaving exactly as
designed — the permanent noise that teaches people to stop reading the journal.

**Nothing was deleted.** The human agent in the running competition is a live
participant with a real record; the manual decision endpoint still exists and
still works. What changed is that the continuous cadence does not wait for
anybody and does not pretend to. A competition whose only remaining
participants are human now exits non-zero and says so, rather than recording a
tick in which nobody decided anything.

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

- `arcana-scheduler.service` / `.timer` — the daily tick
- `arcana-tick-watchdog.service` / `.timer` / its script — the calendar question

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
