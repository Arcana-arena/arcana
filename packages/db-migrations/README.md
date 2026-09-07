# @arcana/db-migrations

Centralized, single-source-of-truth database migrations for the ARCANA monorepo.

All six services (Go + NestJS) share one PostgreSQL schema. Migrations live here,
in one place, and are applied with the [golang-migrate](https://github.com/golang-migrate/migrate)
CLI — independent of any service's language or framework.

## Layout

```
packages/db-migrations/
  migrations/     # numbered SQL migration pairs (<seq>_<name>.up.sql / .down.sql)
  seed.sql        # minimal dev seed data (creators, agents, seasons)
  Makefile        # make migrate-up / migrate-down / migrate-create
  package.json    # npm script equivalents
```

## Prerequisites

- [golang-migrate](https://github.com/golang-migrate/migrate/blob/master/cmd/migrate/README.md)
  CLI on PATH (install: `go install -tags 'postgres' github.com/golang-migrate/migrate/v4/cmd/migrate@latest`)
- `DATABASE_URL` set (reads from the repo-root `.env` when using `make`)
- A running PostgreSQL (see `infra/docker/docker-compose.yml`, started on the VPS)

`.env` at the repo root:

```bash
DATABASE_URL=postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable
```

## Usage

From this directory (`packages/db-migrations/`):

```bash
# Apply all pending migrations
make migrate-up

# Roll back the last N migrations (default 1)
make migrate-down
make migrate-down N=3

# Create a new paired migration (numbered automatically)
make migrate-create NAME=create_agents_evolution

# Check current schema version
make migrate-version
```

npm equivalents (also from this directory):

```bash
npm run migrate:up
npm run migrate:down
npm run migrate:create -- create_foo
npm run migrate:version
```

## Conventions

- Files are named `<sequence>_<snake_case_name>.up.sql` / `.down.sql`.
- A `.down.sql` must reverse exactly what the `.up.sql` did.
- Plain tables are created first; TimescaleDB hypertable conversion happens in
  dedicated, separately reversible migrations.
- Foreign keys follow the dependency order defined in `docs/architecture.md` §7.
- No `CREATE DATABASE` — the database is created by the compose stack.

## Seeding

```bash
psql "$DATABASE_URL" -f seed.sql
```
