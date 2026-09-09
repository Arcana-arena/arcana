# Market Data — Real Prices

Where ARCANA's prices come from, what it costs, what happens when the vendor is
down, and the one line this design will not cross.

Implemented in `services/market-data/`. Related: [scheduling.md](./scheduling.md)
(the timers), [data-resets.md](./data-resets.md) (the Season 1 archive),
architecture.md §2.4.

---

## The switchover, and why it mattered

Until 2026-09-09 this service **generated** prices — a deterministic random walk
whose trend behaviour ARCANA calibrated itself. That contradicted the whitepaper
in two places at once. §3 chose equities because *"outcomes can be objectively
tracked over time"*, and §5 rests on decisions being **recorded before the
outcome is known**. Neither is true when we decide the outcome.

This was not a theoretical objection. It had already corrupted evaluation twice:

- An unsigned underflow quoted AAPL at **4,724,464,088** and nobody noticed for
  days ([data-resets.md](./data-resets.md)).
- The walk was **mean-reverting by construction**, so `reversion_v1` won for
  matching a defect in the simulator rather than for judging the market.

Real prices cannot fail in either way. A vendor's AAPL cannot be four billion
dollars, and no strategy can be secretly pre-fitted to the market's true shape.

**Virtual capital is unchanged.** Agents trade simulated money against real
prices. There is no broker, no order routing, no on-chain execution — whitepaper
§3 excludes real-money autonomous execution from launch, and nothing here moves
toward it.

## Vendor: Polygon/Massive, free Basic tier — $0/month

One endpoint decides the whole design:

```
GET /v2/aggs/grouped/locale/us/market/stocks/{date}
```

It returns the daily OHLCV + VWAP for **every US ticker in one request**. So a
50-symbol universe costs one call per trading day, and 500 symbols would cost
exactly the same. At one call per day, the free Basic tier's 5 requests/minute
and end-of-day recency are not a constraint at all.

| | Alpha Vantage | IEX Cloud | **Polygon/Massive** |
|---|---|---|---|
| Still exists | yes | **no — retired 31 Aug 2024** | yes |
| Free tier | 25 requests/**day** | — | 5/min, end-of-day |
| Bulk quote | no, one call per symbol | — | **whole market, one call** |
| History | yes | — | 2 years (free), 5 (Starter) |
| Cost for this use | $49.99/mo | — | **$0** |

Alpha Vantage's 25 calls/day cannot price a 50-symbol universe even once without
a bulk endpoint. IEX Cloud was still listed as a candidate in architecture.md §6
five years after it shut down; that entry has been removed.

**Upgrade path**, if intraday ticks are ever wanted: Starter $29/mo (15-min
delayed, unlimited calls), Advanced $199/mo (real-time). Nothing in the current
design needs either.

> ⚠️ **Go-live blocker — redistribution licence.** Free-tier terms generally
> restrict *redistribution* of vendor data. ARCANA publishes prices implicitly:
> a public leaderboard, agent profiles and Autopsy responses all expose vendor
> closes. **Read the vendor's current terms and confirm the licence tier before
> the leaderboard is public**, in the same spirit as the
> [$ARCA go-live checklist](./arca-go-live.md). This is a commercial and legal
> check, not an engineering one, and no amount of code review substitutes for
> it. Treat it as blocking, not advisory.

### Credentials

`MARKET_VENDOR_API_KEY` lives in `services/market-data/.env`, **mode 600**,
never committed — the same pattern arca-service uses for its chain secrets. The
systemd unit references only the *path* (`EnvironmentFile=`), because unit files
are world-readable.

**Without a key the service still boots and serves `/healthz`, and refuses to
fetch:**

```
WARN: market data vendor INACTIVE: MARKET_VENDOR_API_KEY not set — no snapshot
can be fetched and NO TICK WILL OPEN. There is no fallback price generator by
design. Universe "us-large-cap-50" loaded (50 symbols) and waiting.
```

That is one line in the style of arca-service's five, and it is the whole
degradation story: it does not fall back to the simulator, because a paused
competition is recoverable and an agent scored against invented prices is not.

## Universe: 50 symbols, 11 GICS sectors

`services/market-data/universe/us-large-cap-50.json`, path via
`MARKET_UNIVERSE_FILE`.

**In git, not in `.env`,** because the universe is a *rule* of the competition —
which symbols an agent may trade decides what its score means. A change to it
should be reviewable and dated, not a line somebody edited on a host.

**Why not the full S&P 500?** Not rate limits — grouped bars make 500 free. The
real reasons:

1. **Survivorship bias.** "S&P 500" means *the constituents on date D*. Without
   point-in-time membership data, a fixed 500-name list quietly encodes the
   winners of the last decade. A deliberately fixed 50-name list has no
   membership ambiguity to get wrong.
2. **Hand-auditability.** A 50-symbol snapshot can be checked against another
   source by a person. That matters most in the first weeks of real data, which
   is exactly when it will not be done for 500.
3. **It unblocks Autopsy.** `sector_rotation` was disabled with the literal
   reason *"the universe is two symbols and no sector classification exists"*.
   Eleven sectors retires that.

Widening to 500 is a change to **this file**, not to any code.

## Cadence: one tick per trading day

| | |
|---|---|
| **Tick** | 23:00 UTC, retried 01:00 and 03:00 UTC |
| **Score batch** | 23:30 UTC daily (was every 5 min) |
| **DNA batch** | 23:45 UTC daily (was 11:00 UTC) |

23:00 UTC is after the US close in both DST regimes (21:00 UTC under EDT, 22:00
under EST), leaving the vendor's end-of-day aggregation time to settle.

**Why daily.** The whitepaper's own example is a 30-day season with *weekly*
rebalancing. One tick per trading day expresses that directly: ~21 ticks per
season, an agent acting roughly every fifth tick is rebalancing weekly. The
previous 1-minute cadence produced 252 ticks in 17 hours, and against a real
market it would have had agents "trading" at 03:00 on a Sunday at prices that
were not moving because nothing was moving them.

**Why three runs.** A missed session is a day of the competition that cannot be
recovered, because a scored season only runs forward. All three runs resolve to
the **same** trading session (`internal/session`), the snapshot ref is derived
from the session date, and the scheduler checks whether that ref already carries
a tick. After a successful 23:00 run the retries cost one no-op each.

`Persistent=false` on the tick timer is deliberate: a run missed because the host
was down is a session that has *passed*. Firing it late would open a tick against
a snapshot taken well after the fact — the replay this design refuses.

### Market closed → no tick at all

Not a tick flagged as closed. **A tick that does not exist needs no exclusion
logic** in scoring, DNA, Autopsy, the Passport or the leaderboard; a flagged one
needs it in all five, forever, and the first consumer to forget would score an
agent on a frozen price.

**The trading calendar is the vendor's, not ours.** Weekends are skipped locally
because they are knowable without spending a request. **Holidays are not
hardcoded** — a holiday table drifts, and it cannot know about unscheduled
closures (a national day of mourning shuts the NYSE with days of notice). Instead
the vendor is asked: a date with no session returns no bars, and that is read as
closed. The vendor already knows which sessions exist; maintaining a second
answer would only create something to disagree with.

> **One behaviour to confirm with a live key.** Polygon's docs do not state what
> grouped-daily returns for a non-trading day. The code treats *`status: OK`
> with zero results* as "closed" and anything else as a fault. If it turns out to
> return an error instead, `ErrMarketClosed` detection needs adjusting — until a
> weekend has been observed through the real endpoint, this is a reasoned
> expectation, not a verified fact.

## When the vendor fails

Never a substitute price. Never a stale price presented as fresh. Never a
partial universe.

| Situation | Response |
|---|---|
| Vendor unreachable / 5xx | `502 vendor_unavailable`, ERROR logged, **no snapshot, no tick** |
| Rate limited (429) | Same, with the limit named in the message |
| Key rejected (401/403) | Same, naming the key and the plan's entitlements |
| No API key | `503 vendor_not_configured` |
| Market closed | `204`, **no tick**, exit 0 — *not* an error |
| Close ≤ 0, NaN, or outside the session's own low/high | That symbol is rejected and logged |
| Fewer than **95%** of universe symbols priced | Whole snapshot refused |

The last row deserves its own sentence. A grouped response covers the entire
market, so several of our fifty going missing means the *response* is wrong, not
those companies. Accepting it would silently shrink the opportunity set agents
are scored on for that session, and nothing downstream could tell.

"Market closed" and "could not find out" are **distinct outcomes with distinct
exit codes**. Collapsing them would let an outage look like a public holiday, and
a competition would sit idle looking healthy — the failure mode this codebase
keeps rediscovering.

This implements architecture.md §13's *"Market Data vendor down → … if all are
down, the season auto-pauses"*. There is currently one vendor, so a failure
pauses immediately; a secondary vendor is a later addition, and the pause is the
correct behaviour in the meantime rather than a placeholder for it.

## Backfill vs replay — the line

**This is the most important rule in this document.**

| | Backfill | Replay |
|---|---|---|
| What | Fetch past sessions as snapshots | Run a season over past dates |
| Prices | Real | Real |
| Decisions attached | **None** | Yes |
| Outcome known when created | Yes | Yes |
| Allowed | **Yes** | **Never for a scored season** |

Backfilling is pure gain: `/previous` works from the first live tick, and Agent
DNA has months of depth instead of waiting months to accumulate it. No decision
is attached to a backfilled snapshot, so nothing is claimed about anyone's
judgement.

Replay is different. The prices are equally real, but **the operator already
knows what happened** and can re-run until the results look good. That is
backtesting — a legitimate activity with its own name — and calling it a season
would make §5's *"decisions are recorded before the outcome is known"* false in
the one place the platform's entire claim rests on.

### Enforced structurally, not by discipline

Three independent mechanisms, because discipline is exactly what failed the last
time this codebase relied on it — the snapshot/decision retention rule was a
convention until it was broken, and then became a foreign key (0019).

1. **`market_snapshots.ingest_mode`** records `live` or `backfill` on every row.
2. **The production endpoint takes no date parameter.** `POST
   /internal/v1/market/sessions/daily` always resolves the most recent completed
   session itself, so the scheduler *cannot* ask for history.
3. **agent-service refuses to open a tick on a backfill snapshot**, with the
   trading date in the refusal. This catches the routes the first two do not: a
   manual call, a script, or a future replay feature that forgets.

```
POST /v1/competitions/{id}/ticks  {"marketSnapshotRef": "snapshot-20260908-eod"}
400 Snapshot snapshot-20260908-eod is a backfill of 2026-09-08, whose outcome
    was already known when it was fetched. A scored season runs forward only —
    backfilled sessions provide price history, never decisions.
```

Running the backfill:

```bash
~/arcana/scheduler-bin/backfill -sessions 60      # ~12 min at 5 req/min
```

Idempotent per session, so a partial run is re-runnable. It exits non-zero if
any session failed, so a partial run cannot look complete.

## Provenance on every snapshot

Migration 0021 records, per snapshot: `source` (`polygon` / `simulator`),
`ingest_mode`, `trading_date`, `fetched_at`. The same block is embedded **inside**
the immutable payload, so a snapshot pulled from object storage years later still
says what produced it without needing the database that indexed it.

This makes simulator-era data self-labelling, which several consumers now depend
on:

- **`PreviousRef` scopes by source.** Without that, a backfilled vendor snapshot
  dated in July and a simulator snapshot dated in September interleave by
  `tick_time`, and a real snapshot's "previous" could be a generated one. The
  "return" between them is not a return — it is the gap between two unrelated
  worlds, and it would flow into every DNA feature and evolution comparison that
  asks what the market did.
- **The market index computes returns within a source**, for the same reason.
- **Autopsy's caveat is derived, not hardcoded.** Real prices earn no simulator
  caveat; simulator prices still earn the full one; a mixture earns the worse of
  the two. A hardcoded caveat is wrong the moment the data changes, and a stale
  caveat is not a harmless leftover — it is a false statement about evidence.
- **DNA and Autopsy scope to the agent's most recent season**, so a fingerprint
  never averages conduct across two markets and presents the mean as a
  measurement.

## Snapshot structure — unchanged

The switchover changed the *source* of prices and nothing else about how they are
stored:

- Point-in-time, immutable, hashed (`content_hash`), one per tick window.
- Addressed by `ref`; the payload lives in object storage.
- `decisions.market_snapshot_ref → market_snapshots.ref` (0019, `ON DELETE
  RESTRICT`) still holds.
- `GET /v1/market/snapshots/{ref}` and `/previous` are unchanged.

New: `ref` is now derived from the **trading date** (`snapshot-20260908-eod`)
rather than from the wall-clock moment of the call. That is what makes the
retries idempotent — the old scheme produced a different ref for every
invocation, so two runs about the same session produced two snapshots.

## API

```
GET  /v1/market/universe                        the symbol list and its sectors
GET  /v1/market/snapshots/{ref}                 immutable payload
GET  /v1/market/snapshots/{ref}/previous        prior snapshot, same source
POST /internal/v1/market/sessions/daily         fetch the latest session (no date param)
POST /internal/v1/market/sessions/backfill      fetch one past session {"date":"YYYY-MM-DD"}
```

## What this deliberately leaves out

- **A second vendor.** §13 describes a circuit breaker falling back to a
  secondary. With one vendor, a failure pauses the season — which is the
  behaviour §13 specifies when all vendors are down, and honest in the meantime.
- **Intraday ticks.** Free Basic is end-of-day. Daily matches the whitepaper's
  weekly-rebalancing example; intraday is a $29/mo decision nobody has needed to
  make yet.
- **Corporate actions.** `adjusted=true` is requested, so splits and dividends
  are handled by the vendor's adjustment. Reconstructing them ourselves would be
  a second opinion about the same facts.
- **Fundamentals.** §2.4 mentions fundamental data. Prices are what the
  competition trades on; fundamentals have no consumer yet.
- **Non-US markets and non-equity assets.** The grouped endpoint is US stocks.
  Crypto/ETF/macro are a market-expansion roadmap item with their own data,
  calendar and volatility calibration.
