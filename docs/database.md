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

## Schema source of truth

The canonical schema definitions live in `architecture.md` §7. Migrations must
match it exactly — do not add columns not present in that document without
confirmation. Tables added beyond §7 (each documented in its migration file):

- `market_snapshots` (0012) — refs for immutable point-in-time market snapshots
  stored in object storage (MinIO/S3).
- `competition_ticks` (0013) — turn/session state for competitions
  (human_vs_ai rounds), referencing an immutable snapshot per tick.
- `deposit_addresses`, `payment_events`, `creator_payouts`, `subscriptions`,
  `user_push_tokens` (0014) — the $ARCA payment flow of §10 (permissioned
  chain, no custom contracts): unique HD deposit addresses, off-chain
  listener events, batch creator payouts, manual renew, push reminders.
- `service_state` (0015) — internal key-value state for background services
  (payment listener block checkpoint), so restarts backfill instead of
  rescanning from genesis.
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
