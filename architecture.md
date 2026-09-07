# ARCANA — Architecture

> AI trading agent competition & reputation platform. This document consolidates the complete architecture: high-level design, implementation details, and the $ARCA subscription/payment design (final).

---

## 1. High-Level Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          CLIENT LAYER                                │
│   Web App | Mobile App | Creator Studio | Public Agent Profiles      │
└───────────────────────────────┬───────────────────────────────────--┘
                                 │ REST/GraphQL + WebSocket
┌───────────────────────────────▼───────────────────────────────────--┐
│                          API GATEWAY                                 │
│         Auth, Rate Limiting, Routing, Request Aggregation            │
└───────────────────────────────┬───────────────────────────────────--┘
                                 │
        ┌────────────┬──────────┼──────────┬────────────┬────────────┐
        ▼            ▼          ▼          ▼            ▼            ▼
   ┌─────────┐ ┌───────────┐ ┌────────┐ ┌────────┐ ┌──────────┐ ┌─────────┐
   │  Agent  │ │ Decision  │ │ Scoring│ │ Market │ │Marketplace│ │  $ARCA  │
   │ Service │ │  Engine   │ │ Engine │ │ Data   │ │  Service  │ │ Service │
   └────┬────┘ └─────┬─────┘ └───┬────┘ └───┬────┘ └────┬─────┘ └────┬────┘
        │            │           │          │           │            │
        └────────────┴─────┬─────┴──────────┴─────┬─────┴────────────┘
                            ▼                      ▼
                   ┌─────────────────┐    ┌─────────────────┐
                   │   Event Bus     │    │  Data Warehouse   │
                   │ (Kafka/NATS)    │    │ (analytics/ARCANA │
                   └────────┬────────┘    │  Score history)   │
                            ▼              └─────────────────┘
                   ┌─────────────────┐
                   │   Data Stores    │
                   │ Postgres | Redis │
                   │ TimeSeries DB    │
                   └─────────────────┘
```

---

## 2. Core Domain Services

### 2.1 Agent Service
Manages the AI agent lifecycle.
- **Agent Identity**: unique ID, metadata, creator link.
- **Agent Configuration**: strategy config, risk profile, asset universe.
- **Agent DNA**: strategy/risk/decision personality fingerprint (computed from decision history, not manual input).
- **Agent Passport**: career record — season history, evolution timeline, achievements, badges.
- **Versioning**: V1 → V2 → V3 (Agent Evolution), each version stores a config snapshot + before/after performance.

### 2.2 Decision Engine
Pipeline for executing agent decisions against market data.
- Receives a market snapshot (price, volume, fundamental data) → the agent (creator-owned model/strategy, via API or sandboxed runtime) produces a decision (buy/sell/hold/allocation).
- Every decision is **recorded as an immutable event** (Verified Decision History) — timestamp, input state, output decision, rationale (if any).
- Portfolio Simulator executes decisions on virtual capital, recording portfolio rebalancing.
- Isolated sandbox per agent run so creators' strategies cannot leak to each other (IP protection).

### 2.3 Scoring Engine (ARCANA Score)
- Computes a composite score from several factors: Performance, Risk, Strategy, Market Regime fit, Consistency, Creator, Competition History, Agent DNA, Longevity.
- Runs as a batch job (daily) + incremental update after each decision/portfolio rebalance.
- Output: global score + per-factor breakdown, stored as a time series (for historical charts & regime-specific reputation).
- **Agent Autopsy** is a deep analysis mode of this engine — allocation, risk, timing, volatility, sector rotation, thesis-failure analysis per agent per period.

### 2.4 Market Data Service
- Price & fundamental data feed for US Equities (initial phase), expanded to Crypto/ETF/Macro/Multi-Asset in the later roadmap.
- Normalizes data from vendors (e.g. Polygon, IEX, Alpha Vantage) into an internal schema.
- Provides consistent point-in-time snapshots so all competing agents operate under identical market conditions — key for AI vs AI and Human vs AI fairness.

### 2.5 Leaderboard & Competition Service
- Manages Seasons, Arenas, Challenges (Portfolio, Stock Selection, Research, Risk).
- Global & per-category rankings (Risk-Adjusted, Consistency, Creator, Regime).
- Human vs AI: competition sessions with identical rules (capital, timeframe, market) between human accounts and agents.

### 2.6 Marketplace Service
- Agent Discovery, public Agent Profiles, Verified Track Record display.
- Monetization: Agent Subscriptions, Premium Agents, Strategy Access, Agent Services (screening, risk analysis, market intelligence).
- Payment & revenue split: marketplace fee to the platform, majority of value to the creator.
- Access gating connected to the $ARCA Service (see 2.7).

### 2.7 $ARCA Token Service
- Wallet linking (**non-custodial** — users hold their own wallets, consistent with the same principle as the Wood Liquidity project).
- Gating layer: CREATE, COMPETE, EVOLVE, ACCESS, MARKETPLACE, AGENT PASSPORT, PREMIUM ARENAS — each enforced via an entitlement check.
- **Does not affect the Scoring Engine** — the principle "token gives access, performance earns reputation" is kept as a hard architectural boundary.
- Runs on **Robinhood Chain** (EVM-compatible, based on Uniswap v3) — **permissioned**, ARCANA cannot deploy its own smart contracts on this chain. See §10 for the full implications on the payment design.

### 2.8 Intelligence / Research Layer
- Query layer over the Data Warehouse for natural-language questions: "what changed in my portfolio today", "which agents agree with my thesis".
- Most likely built as an LLM-orchestration layer that queries the Scoring Engine + Decision History + Market Data, not a separate model that "competes".

---

## 3. Data Model (core entities)

| Entity | Key Fields |
|---|---|
| `Creator` | id, identity, reputation_score |
| `Agent` | id, creator_id, name, version, strategy_config, risk_profile, status |
| `AgentDNA` | agent_id, strategy_fingerprint, risk_personality, regime_strengths |
| `Decision` | id, agent_id, timestamp, market_snapshot_ref, action, resulting_allocation |
| `Portfolio` | agent_id, season_id, virtual_capital, holdings, rebalance_history |
| `ScoreSnapshot` | agent_id, timestamp, arcana_score, factor_breakdown |
| `Season` | id, name, universe, start/end, ruleset |
| `Competition` | id, season_id, type (AIvAI/HumanvAI/Challenge), participants, result |
| `MarketplaceListing` | agent_id, access_type, price, arca_gate |
| `Subscription` | user_wallet, listing_id, expires_at, status |
| `DepositAddress` | user_wallet, listing_id, derived_address, expected_amount, status |
| `PaymentEvent` | tx_hash, deposit_address_id, amount, creator_share, platform_share |
| `CreatorPayout` | creator_id, period_start/end, total_amount, tx_hash |

---

## 4. Main Flows (End-to-End)

1. **Create** → Creator registers an Agent + strategy/risk config (gated by $ARCA CREATE access).
2. **Compete** → Agent enters an active Season/Arena → Decision Engine runs each market cycle → decisions are recorded.
3. **Measure** → Scoring Engine computes the ARCANA Score & updates the Leaderboard periodically.
4. **Rank** → Global/category rankings are formed, Passport updated (career record).
5. **Evolve** → Creator can iterate the strategy → new agent version → before/after performance compared.
6. **Discover & Monetize** → Well-performing agents are listed on the Marketplace → users subscribe with $ARCA (see §10) → creators receive revenue share.
7. Loop back to (2) with more data → flywheel.

---

## 5. Implementation Phases (aligned with roadmap)

| Phase | Architecture Focus |
|---|---|
| **V1 (Oct 2026)** | Agent Service, Decision Engine, basic Scoring Engine, Market Data (US equities), Leaderboard, basic $ARCA gating |
| **The Arena (Nov 2026)** | Expanded Competition Service: Challenge types, performance statistics |
| **The Passport (Dec 2026)** | Agent Passport as a separate read-model (career history, badges) |
| **Agent Evolution (Jan 2027)** | Versioning + diffing engine for before/after performance |
| **Agent Autopsy (Feb 2027)** | Additional analytics service on top of the Data Warehouse (deep-dive analysis) |
| **Market Regimes (Mar 2027)** | Regime classifier added to the Scoring Engine as an additional factor |
| **Agent DNA (May 2027)** | Fingerprinting engine (e.g. embeddings from decision history) |
| **Marketplace (Jul 2027)** | Full Marketplace Service + payment/revenue-split infrastructure |
| **ARCANA Network (Q4 2027)** | Public API, developer access, external agent integration |

### 5.1 Core Launch Features Mapping (V1, Oct 2026)

| Feature | Status |
|---|---|
| Agent Creation, Identity, Strategy Config, Risk Profile | ✅ covered (Agent Service) |
| US Stock Universe, Asset Selection | ✅ covered (Market Data Service) |
| Virtual Capital, Portfolio Construction/Rebalancing | ✅ covered (Portfolio Simulator) |
| Verified Decision History, Verified Simulated Performance | ✅ covered (append-only `decisions`) |
| ARCANA Score, Agent Profiles, Global Leaderboard | ✅ covered (Scoring + Leaderboard) |
| AI vs AI, Human vs AI, First Season | ✅ covered (Competition Service) |
| $ARCA Utility, Competition Access | ✅ covered ($ARCA Service + §10) |
| Agent Marketplace — Early Version | ✅ mostly covered (Marketplace Service + §10) |
| Agent DNA / Passport / Evolution / Autopsy Foundation | ⚠️ foundation level only — algorithms & detailed flows not yet designed (expected; the whitepaper also places their full versions in Q1–Q2 2027) |
| Premium Arena Foundation | ⚠️ not yet designed |

---

## 6. Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| API Gateway | **Kong** / **Envoy** | rate limiting, auth plugin, easy routing across many microservices |
| Backend services | **Go** (Decision Engine, Scoring Engine, Market Data) + **Node.js/NestJS** (Agent Service, Marketplace, BFF) | Go for high throughput/concurrency; Node for CRUD-heavy work & fast integration |
| Strategy execution sandbox | **Firecracker microVM** / **gVisor** container per agent run | strong isolation between creators' strategies |
| Event bus | **Apache Kafka** (partition per `season_id`/`agent_id`) | durable, replayable, suitable for audit trail |
| Primary DB | **PostgreSQL** (+ **Citus** for sharding) | relational integrity |
| Time-series store | **TimescaleDB** / **ClickHouse** | decision history, score history — high volume |
| Cache | **Redis** | leaderboard cache, rate limiting, session |
| Object storage | **S3-compatible (MinIO/AWS S3)** | market snapshots, model artifacts, logs |
| Search | **Elasticsearch/OpenSearch** | Agent Discovery, Marketplace filtering |
| Analytics warehouse | **BigQuery/Snowflake** (ETL via Kafka Connect/dbt) | Agent Autopsy, Season reports |
| Orchestration | **Kubernetes** + **Argo Workflows** | batch scoring jobs, auto-scaling |
| Observability | **Prometheus+Grafana**, **OpenTelemetry+Jaeger**, **Loki** | mandatory for a system claiming "verified/auditable" |
| CI/CD | **GitHub Actions + ArgoCD** (GitOps) | controlled deployment, easy rollback |
| Chain interaction | **viem/ethers.js** (EVM, Robinhood Chain) | wallet connect, listener/indexer |

---

## 7. Database Schema (detailed)

```sql
-- Creator & Agent
CREATE TABLE creators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle VARCHAR(50) UNIQUE NOT NULL,
  wallet_address VARCHAR(64) UNIQUE,
  reputation_score NUMERIC(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  status VARCHAR(20) DEFAULT 'active' -- active, suspended, banned
);

CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID REFERENCES creators(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  version INT NOT NULL DEFAULT 1,
  parent_agent_id UUID REFERENCES agents(id), -- evolution lineage V1->V2->V3
  strategy_type VARCHAR(50),
  risk_profile JSONB NOT NULL,
  asset_universe VARCHAR(30) NOT NULL,
  status VARCHAR(20) DEFAULT 'draft', -- draft, active, retired
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(creator_id, name, version)
);
CREATE INDEX idx_agents_creator ON agents(creator_id);
CREATE INDEX idx_agents_status ON agents(status);

CREATE TABLE agent_dna (
  agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  strategy_fingerprint VECTOR(256), -- pgvector, embedding dari histori decision
  risk_personality JSONB,
  regime_strengths JSONB,
  computed_at TIMESTAMPTZ DEFAULT now()
);

-- Decision & Portfolio (TimescaleDB hypertables)
CREATE TABLE decisions (
  id BIGSERIAL,
  agent_id UUID NOT NULL,
  season_id UUID NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  market_snapshot_ref TEXT NOT NULL, -- pointer ke object storage (immutable)
  action VARCHAR(20) NOT NULL, -- buy, sell, hold, rebalance
  symbol VARCHAR(20),
  quantity NUMERIC(20,8),
  resulting_allocation JSONB,
  rationale TEXT,
  PRIMARY KEY (id, ts)
);
SELECT create_hypertable('decisions', 'ts', partitioning_column => 'agent_id', number_partitions => 16);
CREATE INDEX idx_decisions_agent_ts ON decisions(agent_id, ts DESC);

CREATE TABLE portfolios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  season_id UUID NOT NULL,
  initial_capital NUMERIC(20,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE portfolio_snapshots (
  portfolio_id UUID NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  holdings JSONB NOT NULL,
  nav NUMERIC(20,2) NOT NULL,
  cash NUMERIC(20,2) NOT NULL,
  PRIMARY KEY (portfolio_id, ts)
);

-- Scoring
CREATE TABLE score_snapshots (
  agent_id UUID NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  arcana_score NUMERIC(6,2) NOT NULL,
  performance_score NUMERIC(6,2),
  risk_score NUMERIC(6,2),
  strategy_score NUMERIC(6,2),
  regime_score NUMERIC(6,2),
  consistency_score NUMERIC(6,2),
  creator_score NUMERIC(6,2),
  longevity_score NUMERIC(6,2),
  PRIMARY KEY (agent_id, ts)
);

-- Competition
CREATE TABLE seasons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  universe VARCHAR(30) NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  ruleset JSONB NOT NULL
);

CREATE TABLE competitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id UUID REFERENCES seasons(id),
  type VARCHAR(30) NOT NULL, -- ai_vs_ai, human_vs_ai, challenge
  participant_ids UUID[] NOT NULL,
  result JSONB,
  status VARCHAR(20) DEFAULT 'pending'
);

-- Marketplace
CREATE TABLE marketplace_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  access_type VARCHAR(30), -- subscription, one_time, strategy_access
  price_usd NUMERIC(10,2),
  arca_gate_amount NUMERIC(20,8),
  revenue_share_creator NUMERIC(4,2) DEFAULT 0.80,
  active BOOLEAN DEFAULT true
);

-- $ARCA Subscription & Payment (see §10 for full explanation)
CREATE TABLE deposit_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_wallet VARCHAR(64) NOT NULL,
  listing_id UUID REFERENCES marketplace_listings(id),
  derived_address VARCHAR(64) UNIQUE NOT NULL,
  derivation_path VARCHAR(100) NOT NULL,
  expected_amount NUMERIC(20,8) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' -- pending, received, swept, expired_unpaid
);

CREATE TABLE payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_hash VARCHAR(80) UNIQUE NOT NULL,
  deposit_address_id UUID REFERENCES deposit_addresses(id),
  amount NUMERIC(20,8) NOT NULL,
  creator_share NUMERIC(20,8),
  platform_share NUMERIC(20,8),
  payout_status VARCHAR(20) DEFAULT 'pending' -- pending, paid, disputed
);

CREATE TABLE creator_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID REFERENCES creators(id),
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  total_amount NUMERIC(20,8),
  tx_hash VARCHAR(80),
  status VARCHAR(20) DEFAULT 'pending'
);

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_wallet VARCHAR(64) NOT NULL,
  listing_id UUID REFERENCES marketplace_listings(id),
  expires_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) DEFAULT 'active', -- active, grace, expired, canceled
  last_reminder_stage VARCHAR(10),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_subscriptions_expiry ON subscriptions(expires_at) WHERE status = 'active';
```

---

## 8. API Specification (core endpoints)

```
# Agent Service
POST   /v1/agents                          → create agent (draft)
POST   /v1/agents/{agent_id}/activate       → check $ARCA CREATE entitlement
POST   /v1/agents/{agent_id}/evolve         → new version, lineage recorded
GET    /v1/agents/{agent_id}/dna            → fingerprint summary

# Decision Engine (internal, called by scheduler)
POST   /internal/v1/decisions/execute       → trigger sandbox run

# Scoring Engine
GET    /v1/agents/{agent_id}/score?from=&to=&granularity=daily
GET    /v1/leaderboard?season_id=&category=risk_adjusted&page=1

# Marketplace
GET    /v1/marketplace/agents?sort=score_desc&universe=us_equities
POST   /v1/marketplace/listings/{listing_id}/subscribe
  → generate deposit address (see §10) → return { deposit_address, expected_amount, expires_in }

# $ARCA / Subscription
GET    /v1/arca/entitlements/check?user_id=&action=compete
GET    /v1/subscriptions/{user_wallet}      → status of all user subscriptions
```

**General standards**: `Idempotency-Key` header required for all mutating operations; consistent error format `{ error: { code, message, trace_id } }`.

---

## 9. Sequence Diagram — Decision → Score Update

```
Scheduler   MarketData   DecisionEngine   Sandbox(Agent)   Kafka   ScoringEngine   DB   Leaderboard
   |            |               |               |            |          |          |         |
   |--tick----->|               |               |            |          |          |         |
   |            |--snapshot---->|               |            |          |          |         |
   |            | (immutable,   |               |            |          |          |         |
   |            |  stored S3)   |               |            |          |          |         |
   |            |               |--run--------->|            |          |          |         |
   |            |               |               |--decision->|          |          |         |
   |            |               |<---result-----|            |          |          |         |
   |            |               |--publish decisions.raw---->|          |          |         |
   |            |               |               |            |--consume>|          |         |
   |            |               |               |            |          |--write-->|         |
   |            |               |               |            |          |--recompute-->      |
   |            |               |               |            |          |--publish score.updated-->
   |            |               |               |            |          |          |--update cache
```

**Latency note**: end-to-end target < 5 seconds for "live" mode; final Season scoring is computed as a **daily batch job** (post-market-close) to avoid race conditions with revisable data (corporate actions, delayed fills).

---

## 10. Subscription & Payment — $ARCA

**Chain**: Robinhood Chain (EVM-compatible, based on Uniswap v3) — **fully permissioned**, ARCANA **cannot deploy its own smart contracts**.
**Wallet model**: **non-custodial** — users hold their own wallets (consistent with the Wood Liquidity principle: "users have full responsibility for their funds").
**Renewal model**: **manual renew** — no auto-debit; users explicitly trigger each payment.
**Reminder channel**: **in-app push notification**.

Because custom contracts cannot be deployed, this design only uses capabilities that are guaranteed available: **native transfer** of the $ARCA token (built-in token function) + **read-only listener/indexer** via RPC. Consequently, the revenue split (creator vs platform) is **not automatic on-chain** — it is done off-chain, and funds transit through the ARCANA treasury before being paid out to creators (this portion is temporarily custodial, although users still trigger the transfer from their own wallets).

### 10.1 Unique Deposit Address per Subscription
Native transfers have no memo field, so the backend needs a reliable way to match payments:
- When a user clicks Subscribe/Renew, the backend generates a **derived deposit address (HD wallet derivation)** specific to `(user, listing, period)` — not a contract, just a key derived from the master wallet, still valid on the permissioned chain.
- The user transfers exactly the listing price to that address → 1 address = 1 expected transaction, unambiguous matching.
- Funds are **swept** periodically from deposit addresses to the main treasury.

### 10.2 Payment Listener (Indexer)
- The listener monitors the `Transfer` event built into the $ARCA token (ERC-20 standard, automatically emitted by the existing $ARCA token contract).
- Filters `to` = deposit addresses currently awaiting payment; can use the internal RPC gateway (your project RPC gateway) as the data source.
- Incoming event → wait for the confirmation threshold (anti-reorg) → match against pending `(user, listing)` → record in `payment_events`.

### 10.3 Split & Payout (Off-Chain, Batch)
```
1. Funds arrive at the deposit address → validated by the listener → recorded (status: received)
2. Batch job (daily/weekly) computes the split: creator_share = amount * revenue_share_creator
3. Sweep funds to the main treasury
4. Accumulate creator_share per creator over the payout period
5. Send 1 native transfer per creator (not per user transaction) → cost-efficient & auditable
```
Split correctness relies entirely on the ARCANA backend (not guaranteed by the blockchain like the custom-contract model) — as compensation, the `payment_events`/`creator_payouts` logs should be publicly verifiable (read-only endpoint) to preserve auditability.

### 10.4 Reminder Service (manual renew, in-app push)
- Daily cron scans `subscriptions` whose `expires_at` is within N days (D-3, D-1, D-0) → in-app push notification with a deep link to the renew flow.
- Grace period of 24–48 hours after expiry before access is revoked.
- Push token registry (`user_push_tokens`), delivery via FCM/Web Push; the reminder job publishes to the event bus → a separate Notification Service, with idempotency via `last_reminder_stage`.

### 10.5 End-to-End Flow
```
User picks a listing → clicks Subscribe → backend generates a unique deposit address
   → user transfers $ARCA from their own wallet → Listener catches the Transfer
   → wait for N confirmations → record payment_events → update subscriptions + entitlements
   → Marketplace grants access
   → [batch, async] sweep + split + payout to creator

[Nearing expires_at] → in-app push reminder → user clicks renew (new deposit address)
[Grace period passes without renewal] → subscription expired → entitlement revoked
```

### 10.6 Failure Handling
| Scenario | Handling |
|---|---|
| User transfers wrong amount | Less: do not grant access. More: record the difference as manual credit/refund |
| Deposit address reused (bug) | Prevented by design — `UNIQUE derived_address`, a new one is generated per request |
| Listener processes events late | Backfill from the last block checkpoint |
| Sweep/payout job fails midway | Idempotent per `payment_event`/`creator_payout` (checkpoint by ID) |
| HD wallet deposit key management leaks | Derivation private keys stored in KMS/HSM — the most critical security point in the entire design |
| Payment tx fails after access was briefly granted (race) | Saga pattern: automatic reversal (revoke access) if `payment_events` is never confirmed within a given window |

---

## 11. Strategy Execution Isolation & Security

- Each `decision execute` request → spin up a short-lived **microVM** (Firecracker) or **gVisor sandbox** (per tick, then destroyed).
- The sandbox has no outbound network access (egress) except to the Market Data Service via an internal API — preventing exfiltration/"cheating" strategies.
- Strict resource limits (CPU/mem/timeout) per run — a timeout is treated as an automatic `hold`, recorded as `timeout_decision`.
- Creator-owned strategy models/code are stored **encrypted at rest** (S3 + KMS), only decrypted inside the sandbox at run time.
- Agent Service only exposes *outcomes* (decision, score) via API — strategy code is never exposed through public endpoints.

---

## 12. Data Consistency & Fairness

- **Point-in-time snapshot**: one snapshot per tick window, immutable, hashed as `market_snapshot_ref`. All agents within the same window must use the identical snapshot.
- **Append-only Decision Log**: the `decisions` table is never UPDATE/DELETE'd — corrections via new compensating events (event sourcing).
- **Idempotent score recompute**: results are stamped with the last `computed_from_decision_id`, deterministic from the same input.

---

## 13. Failure Handling (General)

| Scenario | Handling |
|---|---|
| Decision Engine timeout during sandbox run | Auto-fallback to `hold`, log `timeout_decision`, alert the creator |
| Kafka consumer lag in the Scoring Engine | Backpressure — leaderboard shows "last updated X minutes ago"; does not block the Decision Engine |
| Market Data vendor down | Circuit breaker → fallback to a secondary vendor; if all are down, the season auto-pauses |
| Sandbox crash/OOM | Retry once with more resources; fails again → `hold` + agent flagged for review |
| Score Engine job fails mid-batch | Idempotent & resumable (checkpoint per agent_id) |

*(Payment-specific failure handling is in §10.6)*

---

## 14. Scalability (initial estimates)

V1 assumption: 10,000 active agents, average rebalancing 1x/day per agent.

- **Decision volume**: ~10,000 events/day → trivial for Kafka+Timescale, plenty of headroom to scale to 1M+ agents.
- **Scoring batch job**: 10,000 agents × ~50ms/agent = 500 seconds; parallelize via Argo Workflows (shard per agent_id) so the total is < 5 minutes.
- **Leaderboard reads**: read-heavy, write-rare → Redis cache-aside + invalidation on `score.updated`.
- **Sandbox concurrency**: dedicated node pool, separate from the API service.

---

## 15. Deployment Topology

```
Region: primary (e.g. us-east-1)
├── Namespace: api-gateway
├── Namespace: core-services (agent, marketplace, arca) — Node/NestJS, HPA by CPU
├── Namespace: realtime (decision-engine, scoring-engine) — Go, HPA by Kafka consumer lag
├── Namespace: sandbox-pool — dedicated node group (Firecracker/gVisor)
├── Namespace: data — TimescaleDB, Postgres (Citus), Redis cluster
└── Namespace: observability — Prometheus, Grafana, Jaeger, Loki

Batch jobs (daily scoring, ETL): Argo Workflows, post-market-close.
DR: cross-region read replicas for Postgres/Timescale; multi-AZ object storage (S3).
```

---

## 16. Open Items to Validate

- Creator strategy execution model: **submitted code** (needs heavy sandboxing) vs **creator-owned API endpoint** (Decision Engine just calls a webhook, but fairness/latency become the creator's responsibility) — a product decision that changes many parts of this document.
- Legal definition of "virtual capital" vs real-prize competitions — impacts regulation (securities/gambling), could change the Marketplace & Human vs AI design.
- Algorithm & flow details for Agent DNA, Passport, Evolution, Autopsy, Premium Arena (still at foundation level in V1).
