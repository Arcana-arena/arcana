# Capacity — what the VPS actually holds

Measured on the production host, not estimated. Numbers here are re-measured
when something changes rather than carried forward.

Host: 1963 MB RAM, 4095 MB swap, 40 GB disk.

---

## 2026-09-10 — removing Kafka and Redis

Both had been running since the project started. Neither was ever used: no
client library in any `go.mod` or `package.json`, no producer, no consumer, no
cache call, and — on the live host — **zero client connections to `:9092` or
`:6379`**.

| | Before | After | Freed |
|---|---|---|---|
| RAM used | 1279 MB | **619 MB** | 660 MB |
| RAM available | 481 MB | **1141 MB** | 2.4× more headroom |
| Swap in use | 1175 MB | **442 MB** | 733 MB |

**Nearly 1.4 GB of memory pressure removed from a 1963 MB machine**, for
components with no clients.

The bulk of it was one line in an image: Kafka's JVM runs `-Xmx1G -Xms1G`, so it
reserved a gigabyte up front — 648 MB resident and 740 MB pushed to swap. The
host was swapping 1175 MB in total, which means the idle broker was the reason
everything else was being paged out.

Reversible: the named volumes (`arcana-data_kafka_data`,
`arcana-data_redis_data`) are left in place.

**Verified after:** all six services `active`, all six `/healthz` returning 200.

> One unit shows `failed`: `arcana-scheduler.service`, which exited 1 at 03:00
> UTC — twelve hours before this change — because `MARKET_VENDOR_API_KEY` is
> unset and no snapshot could be fetched. That is the documented, muted case in
> [alerting.md](./alerting.md#the-vendor-mute-lifts-itself), it predates this
> work, and the unit is retired in phase 4 anyway.

---

## Where the memory goes now

| Component | Resident |
|---|---|
| MinIO | 113 MB |
| Postgres + TimescaleDB | 41 MB |
| agent-service (Node) | 40 MB |
| marketplace-service (Node) | 23 MB |
| arca-service (Node) | 17 MB |
| decision / scoring / market-data (Go) | 4 MB each, plus a `go run` parent each |

Provider agents (`YDService`, `barad_agent`) and one unrelated user project on
the same host account for the rest. Worth knowing when reading `free -m`: not
all of this box is ARCANA.

## Known waste, not yet fixed

**The three Go services run under `go run` in production.**

```
ExecStart=/usr/local/go/bin/go run ./cmd/server
```

`go run` compiles, then execs the binary as a **child**, so each service leaves
a parent `go` process resident alongside it — about 6–7 MB each, ~20 MB across
the three, for nothing. It also recompiles on every restart, keeps a build cache
on disk, and puts a process between systemd and the thing it is supervising, so
signals and exit codes arrive one hop removed from where they were sent.

`install.sh` already builds the scheduler into `scheduler-bin/`. The pattern
exists; it was simply never applied to the three long-running services.

Deliberately **not** bundled with the Kafka removal: two changes to the same
host at once make the memory figures above unattributable, and the point of this
document is that its numbers mean something.

---

## What breaks first as agents are added

In order, and none of these is RAM:

1. **`MarketIndexService.load()`** — one HTTP round trip per snapshot across
   *every snapshot ever recorded*, behind a 60-second in-process cache, inside
   the service that answers web requests. 854 ms at ~250 snapshots. Four
   consumers each trigger it. **This breaks when the cadence changes, before a
   single agent is added.** Phase 5.
2. **The scoring batch** — sequential, six queries per agent. Fine daily;
   arithmetic against a continuous cadence.
3. **RPC read volume** — every decision needs balances and pool prices. A free
   public endpoint rate-limits long before the CPU notices. More RAM does not
   help; one shared multicall read per batch does.
4. **Gas** — an economic ceiling, not a technical one. See
   [on-chain-direction.md §i](./on-chain-direction.md#i-cadence--the-user-chooses-within-a-floor-the-arithmetic-sets).
5. **RAM** — only after the four above are fixed.

## Sizing

| Agents | Host | What binds first |
|---|---|---|
| 10 | this box, Kafka gone | nothing; there is now 1141 MB available |
| 100 | 4 GB / 2 vCPU | items 1 and 2 above, **before** RAM |
| 1000 | 8 GB / 4 vCPU, signer on its own host, paid RPC, Postgres moved off | not RAM: the signer sharing a host with public services, and Postgres competing for page cache |

**When one VPS stops being the answer** is a money question, not a technical
one: when user funds exceed what can be lost to a single host compromise.
