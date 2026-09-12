# ARCANA

AI trading agent competition & reputation platform.

> Platform for AI trading agent competitions and reputation. This repository is the implementation of the architecture described in [architecture.md](./architecture.md).

## Repository layout

```
services/
  decision-engine/   # Go — executes agent decisions against market data (sandboxed)
  scoring-engine/    # Go — computes the multi-factor ARCANA Score (batch + incremental)
  market-data/       # Go — normalized price & fundamental data feeds (point-in-time snapshots)
  agent-service/     # Node/NestJS — agent lifecycle, identity, configuration, evolution
  marketplace/       # Node/NestJS — listings, subscriptions, agent discovery
  arca-service/      # Node/NestJS — $ARCA entitlements, wallet linking, payments
packages/            # shared code across services
infra/
  docker/            # data stack compose files (Postgres, Redis, Kafka, ...)
  k8s/               # Kubernetes manifests (namespaces per deployment topology)
docs/                # supplementary documentation
```

## Tech stack

See [architecture.md §6](./architecture.md#6-tech-stack). In short: Go for high-throughput engines, Node.js/NestJS for CRUD-heavy services, PostgreSQL/TimescaleDB for storage, Kafka for the event bus, Redis for caching, sandboxed (Firecracker/gVisor) strategy execution.

## Getting started

```bash
# 1. Start the data stack (Postgres, Redis, Kafka)
docker compose -f infra/docker/docker-compose.yml up -d

# 2. Run a service — see each service's own README
```

## Testing the Node services

`npm test` at the repo root. It is green, and **four of the five Node workspaces
have no tests at all** — it says so, every run:

```
  @arcana/agent-service    0  runs jest, has NO tests
  ...
  4 workspace(s) run jest over nothing and pass on --passWithNoTests
```

Those jest runs used to exit 1, which made the suite permanently red for a reason
nobody intended to fix — and a suite nobody reads is worse than a green one. So
they pass on `--passWithNoTests`, and the absence is an ASSERTION rather than a
comment: [`test-inventory.json`](./infra/verify/test-inventory.json) declares how
many test files each workspace has and why, and
[`test-inventory.mjs`](./infra/verify/test-inventory.mjs) fails the suite if disk
and ledger disagree in either direction. Write the first test for a service and
the suite fails until the ledger agrees; lose a suite to a rename and it fails
too, which is the drift `--passWithNoTests` would otherwise hide entirely.

## Building and testing the Go services

Use the root `Makefile`. **`go build ./...` and `go test ./...` do not work from
the repo root** — the root is not a module, `go.work` lists five, and the wildcard
matches none of them:

```
pattern ./...: directory prefix . does not contain modules listed in go.work
```

That reads like a broken checkout and is not one. Build and test per module, or
let the Makefile walk the workspace for you:

```bash
make build-go   # go build ./... in each module listed in go.work
make test-go    # go test ./... in each, with DATABASE_URL sourced from .env
make help       # list targets
```

`make test-go` is the documented way to run the suite because it sources the
repo-root `.env`, and some tests need a real database. **A bare `go test ./...`
inside a module will not silently pass those tests.** Six store tests — the
customer-gas billing, the once-only decline, the four guard-lifecycle tests —
used to skip when `DATABASE_URL` was absent, while the package still summarised
as `ok`. They now **fail** on any machine where Postgres is reachable, because
there the test could have run and did not. On a clone with no Postgres they still
skip, and say so. See
[`db_required_test.go`](./services/decision-engine/internal/store/db_required_test.go)
for how the two are told apart without consulting the variable that is missing.

## Environment

Heavy builds, large tests, and Docker runs are executed on the remote VPS (`projecteon`), not locally. Copy service env files from their `.env.example`.

## Status

Foundation / V1 (target: Oct 2026). See [architecture.md §5](./architecture.md#5-implementation-phases-aligned-with-roadmap) for the roadmap.

**Direction change, 2026-09-10.** ARCANA is moving from a virtual-capital competition to **LLM agents trading real money on-chain, continuously**, with custodial wallets per agent. Start with:

- [docs/on-chain-direction.md](./docs/on-chain-direction.md) — the ten decisions and the measurements behind them
- [docs/go-no-go-stock-tokens.md](./docs/go-no-go-stock-tokens.md) — the test that established it is possible at all
- [docs/on-chain-rollout.md](./docs/on-chain-rollout.md) — the phases, and what each one has to prove

Where `architecture.md` and the direction doc disagree, the direction doc is current.
