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

## Environment

Heavy builds, large tests, and Docker runs are executed on the remote VPS (`projecteon`), not locally. Copy service env files from their `.env.example`.

## Status

Foundation / V1 (target: Oct 2026). See [architecture.md §5](./architecture.md#5-implementation-phases-aligned-with-roadmap) for the roadmap.
