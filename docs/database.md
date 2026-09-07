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

## Seed data

```bash
psql "$DATABASE_URL" -f packages/db-migrations/seed.sql
```

Inserts one dummy creator, one dummy agent (status `draft`), and one dummy season
(idempotent — safe to re-run).
