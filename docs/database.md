# Database & Migrations

The ARCANA database is **PostgreSQL 16 + TimescaleDB + pgvector**, running on the
VPS (projecteon) via `infra/docker/docker-compose.yml`.

## Centralized migrations

All schema changes live in **one place**: [`packages/db-migrations/`](../packages/db-migrations/README.md).

- Tool: golang-migrate (language-agnostic — all services share this schema)
- Migrations: numbered `<seq>_<name>.up.sql` / `.down.sql` pairs under
  `packages/db-migrations/migrations/`
- Plain tables are created first, then converted to TimescaleDB hypertables in
  dedicated migrations (`0009`–`0011`) so each step is explicit and separately
  reversible.

## Running migrations

```bash
cd packages/db-migrations
make migrate-up       # DATABASE_URL read from repo-root .env
```

See the [db-migrations README](../packages/db-migrations/README.md) for all targets
(`migrate-down`, `migrate-create NAME=...`, `migrate-version`, npm equivalents).

## Tests that need the database

Some Go tests run against a real Postgres, because the defects they exist for are
ones the compiler cannot see — `CloseGuard` shipped a query the planner rejects
(`inconsistent types deduced for parameter $2`) and every compile-time check
passed. They read `DATABASE_URL`, from the same repo-root `.env` the migrations
use.

Run them with the documented target, which sources that file:

```bash
make test-go        # from the repo root
```

**A bare `go test` will not quietly pass them.** Six store tests used to skip when
`DATABASE_URL` was absent while the package still summarised as `ok`. They now
behave differently depending on the machine, which is the distinction that
matters:

| the machine | outcome | why |
| --- | --- | --- |
| Postgres reachable, `DATABASE_URL` unset | **FAIL** | the test could have run and did not |
| no Postgres reachable | SKIP, and the run says so | it genuinely cannot run here |
| `DATABASE_URL` set | runs | |

Which case applies is decided by asking the database, not the configuration: the
gate opens a socket to the address this repo's compose file publishes Postgres on
(`127.0.0.1:${HOST_POSTGRES:-5432}`) and checks that something there answers the
Postgres protocol. It sends an SSLRequest and reads one byte — no startup packet,
no credential, nothing written. Checking `DATABASE_URL` instead would only
re-describe the skip, since that is the variable that is missing. Set
`ARCANA_TEST_PG_ADDR` if your Postgres is somewhere else.

See [`db_required_test.go`](../services/decision-engine/internal/store/db_required_test.go).

## Schema source of truth

The canonical schema definitions live in `architecture.md` §7. Migrations must
match it exactly — do not add columns not present in that document without
confirmation. Tables added beyond §7 (each documented in its migration file):

- `market_snapshots` (0012) — refs for immutable point-in-time market snapshots
  stored in object storage (MinIO/S3).
- `competition_ticks` (0013) — turn/session state for competitions
  (human_vs_ai rounds), referencing an immutable snapshot per tick.
- `agents.cadence_seconds` (0054) — how often THIS agent is asked to decide, in
  seconds, chosen by its owner. It replaced an interval that lived in a systemd
  unit per competition, where one number governed every strategy in the room.
  CHECK 60..2592000: the floor is the pool snapshot ref's minute resolution
  (`decisions.market_snapshot_ref` is a foreign key into `market_snapshots`), not
  a view about fees — those are the owner's, and the platform's exposure is bounded
  by the signer's per-agent daily signature cap and the engine's token budget.
- `competition_entries` (0053) — when each agent entered each competition, and
  after how many ticks. `competitions.participant_ids` still answers who is in
  one NOW; this answers since when, which became a question the moment entry
  stopped closing at the first tick. Without it, an agent seated on tick 37 and
  one seated on tick 0 are the same row to the standings, and the shorter record
  reads as the worse one.
- `deposit_addresses`, `payment_events`, `creator_payouts` — **all RETIRED**
  (0024, 0028); `subscriptions` and `user_push_tokens` — **still live** (0014) — the $ARCA payment flow of §10: unique HD deposit
  addresses, off-chain listener events, batch creator payouts, manual renew,
  push reminders. The design was shaped by the belief that the chain was
  permissioned and no contract could be deployed; **that was never true**.

  **Retired 2026-09-10 (0024), marked in the schema rather than dropped.**
  `COMMENT ON TABLE` carries the story on each object, so `\d+` answers "what
  was this, and what happened to it" without anyone finding a changelog. All
  four payment tables were empty at retirement, so nothing was preserved for
  its content — what was preserved is the record that they existed.

  **`subscriptions` is NOT retired and must not be swept up with the rest.** It
  is the access record: `hasAccess()` and the `active → grace → expired`
  lifecycle both read and write it, and `GET /v1/arca/access` is the single
  place the grace rule lives. It was only ever a neighbour of the payment
  tables, never part of the payment model. Its comment in 0024 says so.
- `service_state` (0015) — **RETIRED 2026-09-11** (0028). Introduced as generic
  key-value state for background services. It never became that: its only
  consumer in the whole codebase was ever the payment listener block
  checkpoint, and the listener was removed. Empty, kept, commented. A service
  needing durable state should own a table that names it.
The next two describe columns on `deposit_addresses`, which was **retired on
2026-09-11** along with the service that wrote them. They are kept here rather
than deleted because the reasoning is the interesting part — both were
after-the-fact fixes for real failures, and the same two failures are available
to anything that scans a chain for payments.

- `deposit_addresses.created_at_block` (0016) — chain height when the address
  was issued. The listener's scan never starts above the oldest pending
  deposit's height, closing the case where the checkpoint lands *ahead* of a
  payment and the transfer is never scanned (§10.2/§10.6). Nullable: rows
  predating the migration have no known height and are skipped by the clamp.
- `deposit_addresses.created_at` (0017) — wall-clock issue time, the clock the
  deposit TTL runs on. Needed separately from `created_at_block` because a TTL
  is a real-time concept and block height cannot express "24 hours have passed"
  without assuming a block time. Lets the audit retire an unfunded address to
  `expired_unpaid` so it stops holding the listener's scan floor (§10.2) — only
  ever after its on-chain balance is proven zero.
- `seasons.access_tier` (0020) — `standard` or `premium`. A Premium Arena is a
  season whose registration additionally requires the $ARCA `premium_arena`
  entitlement (§2.7). On the season rather than the competition because a season
  *is* the competitive environment: putting the tier on competitions would allow
  an ungated competition inside a premium arena. No amount column — the
  threshold stays in `ARCA_GATE_PREMIUM_ARENA` alongside every other one.
  Defaults to `standard`, so no existing season changes tier. See
  [premium-arena.md](./premium-arena.md).
- `market_snapshots` provenance (0021) — `source`, `ingest_mode`, `trading_date`,
  `fetched_at`. Records where each snapshot's prices came from, so simulator-era
  data and real vendor data can never be read as the same thing. `source` scopes
  `PreviousRef` and the market index (a backfilled July snapshot and a simulator
  September one would otherwise interleave by `tick_time`, and the "return"
  between them is the gap between two unrelated worlds). `ingest_mode` is the
  structural half of the backfill/replay rule: agent-service refuses to open a
  competition tick on a `backfill` snapshot. All 260 pre-existing rows were
  labelled `simulator` — the only producer that had ever existed. See
  [market-data.md](./market-data.md).
- `score_snapshots.season_id` (0022) — binds every score to the season it was
  earned in, and joins the primary key `(agent_id, season_id, ts)`. It also
  fixes a live bug: the batch writes one row per (agent, portfolio) i.e. per
  season, so an agent in two seasons produced two rows with the same
  `(agent_id, ts)` and the old conflict target **silently dropped the second**.
  Season 2 would have hit it on its first run. Existing rows were attributed via
  the agent's portfolio; the migration fails rather than guess if any row cannot
  be attributed.

## Data resets

Competition data is occasionally deleted on purpose — when the measurements
themselves turn out to be broken, keeping them is riskier than removing them.
Every such deletion is recorded in [data-resets.md](./data-resets.md) with its
reason, scope and backup location.

## Seed data

```bash
psql "$DATABASE_URL" -f packages/db-migrations/seed.sql
```

Inserts one dummy creator, one dummy agent (status `draft`), and one dummy season
(idempotent — safe to re-run).
