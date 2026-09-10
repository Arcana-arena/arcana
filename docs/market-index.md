# Market Index

The market as an equal-weighted index, per tick. One definition, read by Agent
DNA, Agent Autopsy and Agent Evolution.

Implemented in `services/agent-service/src/market/market-index.service.ts`.
Verified by `infra/verify/market-index-verify.mjs`.

---

## The rule

```
return(tick) = mean over symbols of (price / previousPrice - 1)
previous     = the preceding tick FROM THE SAME SOURCE
first tick of a source = 0
```

**Scoping by source is load-bearing.** Simulator snapshots are dated around the
vendor switchover while backfilled vendor snapshots span the preceding months,
so a single `tick_time` ordering interleaves them. The "return" between a
generated price and a real one is not a return; it is the gap between two
unrelated worlds, and it would flow into every DNA feature and evolution
comparison that asks what the market did.

**One definition, and only one.** The service was extracted precisely so DNA and
Evolution would stop deriving their own. Since 2026-09-10 the result is *stored*
in `market_snapshots.market_return`, and that changes nothing about who owns it:
the service computes it and writes it, `market-data` deliberately does not
compute it at ingest, and nothing else writes the column. Storing a number is
not defining it.

---

## Why it was rewritten

It rebuilt the whole index on every cache miss by making **one HTTP round trip
per snapshot, across every snapshot ever recorded**. Measured on the production
host:

| Snapshots | Load |
|---|---|
| 260 (today) | 556 ms |
| 2,190 (4-hour cadence, one year) | 4,175 ms |
| 8,760 (hourly cadence, one year) | 14,269 ms |

The Autopsy figure from the earlier audit — 854 ms at 260 decisions — has the
same root, and that was checked rather than assumed: Autopsy cold measured
553 ms and warm 16 ms, so **537 ms of it was the index load**. One fix, both
problems.

**Parallelising is not the answer, and the measurement said so before any was
written.** At 8,760 refs: concurrency 8 gave 9,957 ms, and 16, 32 and 64 gave
the same. The bottleneck is server-side throughput — one object read per
request — not round-trip latency. Any fix had to stop making the requests.

## What made a fix possible

Two properties, both already true:

- **Snapshots are immutable.** Content-hashed, never rewritten. Anything derived
  from them can be *stored* rather than recomputed, and a cache of them can
  never go stale.
- **Consumers read very few prices.** DNA and Autopsy scope to an agent's most
  recent season. Evolution reads no prices at all.

So:

1. **`market_snapshots.market_return`** (migration 0025) holds the index,
   computed once, lazily, for rows that are `NULL`. `double precision`, not
   `NUMERIC`, so a float64 round-trips exactly — anything else would change
   results in the last digits.
2. **Prices are cached for the life of the process with no TTL.** The previous
   60-second TTL discarded 259 snapshots that could not possibly have changed in
   order to pick up one that might have.
3. **`MarketTick.prices` is `Record<string, number> | null`** and callers ask for
   what they read. Nullable rather than an empty object on purpose: an empty map
   would let a caller that forgot to ask read zeros and publish wrong numbers
   silently. `null` makes the compiler ask at every site — it found four.

| Consumer | Asks for |
|---|---|
| Evolution | nothing — it only reads returns |
| DNA | the refs decisions cite |
| Autopsy | its own ticks, plus the ±5 neighbours the timing percentile compares against |

## Result

Measured against a throwaway database built at each size:

| Snapshots | Before | After (cold) | After (warm) |
|---|---|---|---|
| 2,190 | 4,080 ms | 313 ms | 88 ms |
| 8,760 | 14,626 ms | **349 ms** | **112 ms** |

**42× at 8,760**, and — the part that matters — the cost is now flat in the
number of snapshots. It scales with what a caller reads, which is one season,
rather than with how long the platform has been running.

End-to-end on the live host at 260 snapshots: Evolution **582 ms → 28 ms**.
Autopsy and DNA improve only ~10% *at this scale*, and that is expected rather
than disappointing: today's busiest agent traded on nearly every snapshot that
exists, so it genuinely needs nearly all of them. The gap opens as history grows
past a season.

## No regression, proved by diff

DNA, Autopsy and Evolution were captured for **all 13 agents** before the change
and again after, and compared:

```
IDENTICAL — byte-for-byte, 13 agents, 72,872 bytes
```

Behaviour was preserved deliberately, including the edge cases: a tick whose
prices cannot be fetched is still skipped and still does not become the
predecessor of the next one, and a missing symbol price still fails `> 0` rather
than counting as zero.

## The check that keeps "stored" from becoming "second definition"

```bash
node infra/verify/market-index-verify.mjs
```

Recomputes every stored return from the snapshots and compares. The arithmetic
in it is a deliberate independent restatement of the rule rather than a call
into the service — a copy that imported the service could only ever agree with
it. It also pins the two edge cases the rule turns on: an unreadable snapshot
must have **no** stored return, and the first tick of every source must be
exactly 0.

Currently **261 checks, 0 failures**.

---

## Known: the timing window can cross a source boundary

`autopsy.service.ts` builds its ±5-tick price window from **global** positions
in the series, and the series is ordered `(source, tick_time)`. Nothing stops
the window running off the end of one source and into the next.

**It cannot fire today** — every snapshot in the database is `simulator`, and
there are zero `polygon` rows because `MARKET_VENDOR_API_KEY` was never set. It
will fire the moment a second source exists: a trade near a source boundary
would have its entry price ranked against prices from a different market
entirely.

This predates the rewrite and is **not** fixed here, because fixing it would
change Autopsy's output and this change was required to produce identical
numbers. It is recorded so it is a decision rather than an oversight, and it
belongs with the phase that introduces the second source
([on-chain-rollout.md](./on-chain-rollout.md) phase 10).
