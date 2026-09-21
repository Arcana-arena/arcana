# ARCANA — Architecture

> AI trading agent competition & reputation platform. This document consolidates the complete architecture: high-level design, implementation details, and the $ARCA subscription/payment design (final).

> ### Direction change, 2026-09-10 — read this first
>
> ARCANA is moving from a **virtual-capital competition** to **LLM agents trading real money on-chain, continuously**. Wallets for agents are **custodial**. The decisions this forced — and the measurements behind them — are in **[docs/on-chain-direction.md](./docs/on-chain-direction.md)**; the test that established it was possible at all is in **[docs/go-no-go-stock-tokens.md](./docs/go-no-go-stock-tokens.md)**.
>
> Sections of this document are superseded and each says so where it is affected: **§2.2** (deterministic strategies), **§2.4** (virtual capital, daily cadence, exchange calendar), **§2.5** (Human vs AI, retired), **§2.7** (custody), **§10** (the entire payment design), **§11** (sandbox). Where the direction doc and this one disagree, the direction doc is current.
>
> Nothing here is deleted while the code implementing it still runs. Each superseded block is removed in the phase that removes its code, so a document and its implementation are never out of step in opposite directions.

---

## 1. High-Level Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          CLIENT LAYER                                │
│   Web App | Mobile App | Creator Studio | Public Agent Profiles      │
└───────────────────────────────┬───────────────────────────────────--┘
                                 │ REST/GraphQL + WebSocket
┌───────────────────────────────▼───────────────────────────────────--┐
│                    API GATEWAY  (NOT DEPLOYED)                       │
│      planned: Rate Limiting, Routing, Request Aggregation            │
│      AUTH IS NOT HERE — each service verifies its own tokens         │
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

### Where authentication actually lives

The gateway box above is a plan, not a deployment. For a long time this diagram
said the gateway handled Auth while no gateway existed and no service checked
anything — every endpoint was open, and the only thing keeping the platform
private was the provider firewall in front of it.

That is fixed, and the fix is not a gateway. Authentication runs **inside each
service**, so a request is checked by whatever answers it, with no component
that must be deployed for the checks to exist:

- **Sign-in** — Sign-In with Ethereum (EIP-4361). agent-service owns it,
  because it owns `creators`, the table a wallet proves control of. It is the
  only service that mints tokens.
- **Verification** — arca-service and marketplace verify the same HS256 access
  tokens using the shared `@arcana/auth` package. No hop through a gateway.
- **Machine tier** — `/internal/*` endpoints take a shared `X-Internal-Key`,
  and every service binds to `127.0.0.1`. Two layers, neither sufficient alone.

If a gateway is introduced later it should take over rate limiting and routing.
Auth should stay where it is: a gateway that authenticates leaves each service
trusting a header it cannot verify, which is the arrangement this codebase just
spent a migration getting out of.

Full detail, including the public/protected endpoint table and the 401 / 403 /
502 / 503 distinctions, is in **docs/auth.md**.

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

  > **Superseded (2026-09-10).** Three of the four lines above change.
  >
  > **The decider is an LLM**, behind a provider abstraction, not a creator-supplied model or the three deterministic Go functions (`momentum`, `mean_reversion`, `buy_and_hold`) that actually shipped. Those functions are what the whitepaper called "AI agents" while being if-then rules; replacing them is the point of this change, not a feature on top of it.
  >
  > **The Portfolio Simulator is replaced by real execution**: a signed swap against a Uniswap v3 pool, with NAV *read back from the chain* rather than computed from a snapshot. A trade that cannot settle is no longer degraded to a hold — it is `tx_failed`, and its gas was still spent.
  >
  > **The sandbox is not needed.** Calling an LLM API does not require a microVM. §11 goes with it.
  >
  > What survives unchanged: every decision is still an immutable append-only event. What "verified" means changes — see [on-chain-direction.md §b](./docs/on-chain-direction.md#b-evidence--attested-not-reproducible).

### 2.3 Scoring Engine (ARCANA Score)
- Computes a composite score from several factors: Performance, Risk, Strategy, Market Regime fit, Consistency, Creator, Competition History, Agent DNA, Longevity.
- Runs as a batch job (daily) + incremental update after each decision/portfolio rebalance.
- Output: global score + per-factor breakdown, stored as a time series (for historical charts & regime-specific reputation).
- **Agent Autopsy** is a deep analysis mode of this engine — allocation, risk, timing, volatility, sector rotation, thesis-failure analysis per agent per period.

### 2.4 Market Data Service
- Price & fundamental data feed for US Equities (initial phase), expanded to Crypto/ETF/Macro/Multi-Asset in the later roadmap.
- Normalizes data from a vendor into an internal schema. Candidates were Polygon and Alpha Vantage — **IEX Cloud was listed here for years after it ceased to exist** (IEX Group retired all IEX Cloud API products on 31 August 2024), which is exactly the kind of claim a document keeps making long after it stopped being true.
- Provides consistent point-in-time snapshots so all competing agents operate under identical market conditions — key for AI vs AI and Human vs AI fairness.

  **Implementation status (2026-09-09). This service READS the market; it does not generate it.** Until this date it produced a deterministic random walk that ARCANA calibrated itself, which contradicted §3 (equities were chosen because "outcomes can be objectively tracked over time") and §5 (decisions recorded before the outcome is known) — neither holds when we decide the outcome. It had already corrupted evaluation twice: an unsigned underflow quoted AAPL at 4,724,464,088, and a walk that was mean-reverting by construction handed a mean-reversion agent a win for matching a defect. See [docs/market-data.md](./docs/market-data.md).

  | | |
  |---|---|
  | **Vendor** | Polygon/Massive, free Basic tier ($0/mo). Its grouped-daily endpoint returns every US ticker in one request, so a 50-symbol universe costs one call per trading day — and 500 would cost the same. |
  | **Universe** | 50 liquid US large caps across all 11 GICS sectors, defined in a version-controlled file (`services/market-data/universe/`), because which symbols an agent may trade is a rule of the competition rather than a deployment setting. Not the full S&P 500: without point-in-time membership data a fixed 500-name list encodes survivorship bias. |
  | **Cadence** | One tick per US trading day, 23:00 UTC, with idempotent retries at 01:00 and 03:00 UTC. Matches §3's own example of a 30-day season with weekly rebalancing. |
  | **Market closed** | **No tick at all** — not a tick flagged as closed. A tick that does not exist needs no exclusion logic in scoring, DNA, Autopsy, the Passport or the leaderboard. The trading calendar is the vendor's: weekends are skipped locally, holidays and unscheduled closures are whatever the vendor reports no session for. |
  | **Vendor failure** | No snapshot, no tick, ERROR logged, season paused (§13). Never a substitute price, never a stale price presented as fresh, and never a partial universe (<95% priced is refused). "Market closed" and "could not find out" are distinct outcomes with distinct exit codes. |
  | **Provenance** | Every snapshot records `source`, `ingest_mode`, `trading_date` and `fetched_at`, so simulator-era data is self-labelling and consumers can scope to one market. |

  **Backfill is allowed; replay is not.** Historical sessions may be loaded as snapshots (real prices, no decisions attached) to give `/previous` and Agent DNA depth. A *scored* season may never run over them: the outcome was already knowable when they were fetched, so the operator could re-run until the results looked good, and §5 would quietly stop being true. Enforced structurally — `market_snapshots.ingest_mode`, a production fetch endpoint that takes no date parameter, and agent-service refusing to open a tick on a backfill snapshot — rather than by discipline, which is what failed the last time this codebase relied on it.

  **Virtual capital is unchanged**: agents trade simulated money against real prices. No broker, no order routing, no on-chain execution (§3 excludes real-money autonomous execution from launch).

  > **Superseded (2026-09-10).** Real money, real on-chain execution. And the parts of this section that the change costs are worth naming precisely, because most of them were finished barely a day before it:
  >
  > | Retired | Why |
  > |---|---|
  > | `internal/session` — trading-day resolution, weekend skip | there is no trading day; the pools never close |
  > | vendor-as-calendar, `ErrMarketClosed`, "market closed → no tick at all" | nothing to be closed |
  > | cadence 23:00 / 01:00 / 03:00 UTC and its idempotent retries | replaced by a per-agent cadence the user chooses, staggered |
  > | `arcana-tick-watchdog.sh` (~200 lines) | its whole premise is "was the market open on date D" |
  > | `us-large-cap-50.json` as the universe | on-chain the universe is set by pool depth, not GICS coverage; ~9 symbols have real liquidity |
  >
  > **The vendor is not retired, its role changes**: from *being* the market to *refereeing* it. Execution price is the pool's; a Chainlink feed is the independent sanity check, because it answers on a Sunday and Polygon does not.
  >
  > **What survives and gets stronger**: the backfill-vs-replay rule (a real trade cannot be replayed, so reality now enforces what discipline had to), and `market_snapshots` provenance — which simply gains a third `source`, `pool`.

### 2.5 Leaderboard & Competition Service
- Manages Seasons, Arenas, Challenges (Portfolio, Stock Selection, Research, Risk).
- Global & per-category rankings (Risk-Adjusted, Consistency, Creator, Regime).
- Human vs AI: competition sessions with identical rules (capital, timeframe, market) between human accounts and agents.

  > **Retired (2026-09-10)** — retired, not paused. A person submitting trades that the platform executes from a wallet the platform controls is a materially different activity from an autonomous agent trading its owner's funds, and it is not one this project has decided to answer for. The mechanic also does not survive the cadence change: `HUMAN_WINDOW` means "the tick is open for an hour", and continuous trading has no ticks to open. Its fairness premise — identical capital, identical snapshot, identical window — was retired by [on-chain-direction.md §a](./docs/on-chain-direction.md#a-fairness--decision-quality-and-execution-quality-are-scored-separately).
  >
  > **Nothing is deleted.** Season 1's human participants keep their decisions, portfolio snapshots, score history and Passport, exactly as a retired agent does. What stops is accrual: the record closes, it is not erased.

### 2.6 Marketplace Service
- Agent Discovery, public Agent Profiles, Verified Track Record display.
- Monetization: Agent Subscriptions, Premium Agents, Strategy Access, Agent Services (screening, risk analysis, market intelligence).
- Payment & revenue split: marketplace fee to the platform, majority of value to the creator.
- Access gating connected to the $ARCA Service (see 2.7).

### 2.7 $ARCA Token Service
- Wallet linking for **$ARCA entitlements** is non-custodial — a user proves control of their own wallet via SIWE and the balance is only ever read.

  **This is now the narrow case, not the general one.** Since 2026-09-10 ARCANA also creates and holds a wallet per **agent**, and signs trades from it: agent trading is **custodial**. The two are deliberately separate — an entitlement wallet is the user's and is never signed for; an agent wallet is the platform's to sign and the user's to fund and withdraw. See [docs/on-chain-direction.md](./docs/on-chain-direction.md).
- Gating layer: CREATE, COMPETE, EVOLVE, ACCESS, MARKETPLACE, AGENT PASSPORT, PREMIUM ARENAS — each decided by an entitlement check against the actor's $ARCA balance.

  **Implementation status (2026-09-09).** The check exists for all seven actions and is wired at four call sites: CREATE on agent activation, EVOLVE on `POST /v1/agents/:id/evolve`, COMPETE on competition registration (per participant, at entry — never per tick), and PREMIUM ARENAS on registration into a season marked `access_tier='premium'` — checked *in addition to* COMPETE, never instead of it, so the effective requirement is the larger of the two thresholds rather than whichever gate happens to be cheaper. ACCESS, MARKETPLACE and PASSPORT are answerable but nothing calls them yet. See [docs/premium-arena.md](./docs/premium-arena.md).

  **Nothing is enforced yet, and that is visible rather than implied.** The $ARCA token has not launched, so no balance can be read and every check passes. Each response carries `balance_checked` and a `reason`, so `allowed: true` cannot be mistaken for a verified entitlement; the boot log warns in the same terms. This paragraph exists because the line above it previously described a gating layer that had never been built, and a promise in a document is indistinguishable from a feature until someone checks. See [docs/arca-entitlements.md](./docs/arca-entitlements.md).
- **Does not affect the Scoring Engine** — the principle "token gives access, performance earns reputation" is kept as a hard architectural boundary.
- Runs on **Robinhood Chain** (EVM-compatible, Arbitrum Orbit L2, chain id **4663**, gas paid in ETH).

  > **Correction (2026-09-10).** This line said the chain was **permissioned** and that ARCANA **cannot deploy its own smart contracts**. That was never true. Robinhood Chain launched its public mainnet permissionless on 1 July 2026: anyone can deploy, with no review. The claim survived here long enough to shape a whole subsystem — §10's deposit-address design exists *because* of it — which is the same failure mode as "IEX Cloud" and "the gateway handles auth". Verified by execution, not by documentation: see [docs/go-no-go-stock-tokens.md](./docs/go-no-go-stock-tokens.md).
  >
  > ARCANA nonetheless deploys **no contracts**, for a different and deliberate reason: nothing in the current design needs one. Trading is custodial, and the marketplace verifies payments by transaction hash.

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
| `Season` | id, name, universe, start/end, ruleset, access_tier |
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
| Premium Arena Foundation | ⚠️ foundation level only — a premium arena is a season gated on $ARCA (`seasons.access_tier`), which is the half of "specialized competitive environments" the whitepaper actually specifies. What makes an arena *specialized* beyond access — different universes, dedicated formats, prizes — remains a product decision; the options and their prerequisites are written up in [docs/premium-arena.md](./docs/premium-arena.md) rather than guessed at. |

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
  strategy_fingerprint VECTOR(256), -- pgvector, embedded from the decision history
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
  arcana_score NUMERIC(6,2),          -- NULL = unranked: not enough participation to measure (0018)
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
  ruleset JSONB NOT NULL,
  -- 0020: 'standard' | 'premium'. A Premium Arena (§2.7) is a season whose
  -- registration also requires the $ARCA premium_arena entitlement. On the season
  -- because a season IS the environment; on a competition it would let an ungated
  -- competition exist inside a premium arena. Threshold stays in
  -- ARCA_GATE_PREMIUM_ARENA, not here. See docs/premium-arena.md.
  access_tier VARCHAR(20) NOT NULL DEFAULT 'standard'
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

> ## ⛔ SUPERSEDED (2026-09-10). RETIRED IN CODE (2026-09-11). This section describes a design that no longer exists.
>
> **The code is gone, not merely dormant.** `HdWalletService`,
> `DepositAddressesService`, `PaymentListenerService`, their three entities and
> every route they served were removed on 2026-09-11, once phase 11 proved the
> replacement (22/22 against real USDG transfers). The tables survive, empty and
> marked `RETIRED` by migrations 0024 and 0028. What replaced it is
> [docs/marketplace-payments.md](./docs/marketplace-payments.md).
>
> The SQL and sequence diagrams below are kept as a record of a design that was
> built, shipped and then found to rest on a false premise. That is worth being
> able to read back.
>
> **Two of its three premises were false, and the third was dropped.**
>
> 1. *"The chain is fully permissioned, ARCANA cannot deploy its own smart contracts."* **Never true.** Robinhood Chain mainnet has been permissionless since 1 July 2026. The derived-deposit-address design below exists solely because of this belief.
> 2. *"Funds transit through the ARCANA treasury and the split is computed off-chain."* The marketplace is now **P2P with no fee**: the buyer pays the creator's wallet directly, there is no split, and no treasury transit.
> 3. Payment matching is now by **transaction hash submitted by the buyer and verified against the chain** — the transfer exists, is confirmed, the amount matches the listing, and the recipient is that listing's creator.
>
> **What is retired:** the HD-derived deposit addresses (§10.1), the payment listener and its scan floor (§10.2), the sweep/split/payout batch (§10.3), the reminder job (§10.4), and their two systemd timers.
>
> **What is kept, because it was learned the hard way and applies to any verifier:** a payment that arrives and is never credited is logged at **ERROR**, never swallowed; the verifier must check the *recipient*, not merely that a transfer happened; and `payment_events.tx_hash UNIQUE` is now load-bearing against hash replay rather than merely tidy.
>
> The replacement is specified in [docs/on-chain-direction.md §g](./docs/on-chain-direction.md#g-marketplace--tx-hash-confirmation). The text below is kept until the code implementing it is removed, so the two cannot drift apart while both exist.

**Chain**: Robinhood Chain (EVM-compatible, Arbitrum Orbit L2, chain id 4663) — **permissionless**; the "fully permissioned" claim that shaped this section was wrong.
**Wallet model** *(as designed)*: **non-custodial** — users hold their own wallets.
**Renewal model**: **manual renew** — no auto-debit; users explicitly trigger each payment.
**Reminder channel**: **in-app push notification**.

Because custom contracts were believed impossible, this design only uses capabilities that are guaranteed available: **native transfer** of the $ARCA token (built-in token function) + **read-only listener/indexer** via RPC. Consequently, the revenue split (creator vs platform) is **not automatic on-chain** — it is done off-chain, and funds transit through the ARCANA treasury before being paid out to creators (this portion is temporarily custodial, although users still trigger the transfer from their own wallets).

### 10.1 Unique Deposit Address per Subscription
Native transfers have no memo field, so the backend needs a reliable way to match payments:
- When a user clicks Subscribe/Renew, the backend generates a **derived deposit address (HD wallet derivation)** specific to `(user, listing, period)` — not a contract, just a key derived from the master wallet. *(The original text said "still valid on the permissioned chain". The chain is permissionless; this design needed no such workaround.)*
- The user transfers exactly the listing price to that address → 1 address = 1 expected transaction, unambiguous matching.
- Funds are **swept** periodically from deposit addresses to the main treasury.

### 10.2 Payment Listener (Indexer)
- The listener monitors the `Transfer` event built into the $ARCA token (ERC-20 standard, automatically emitted by the existing $ARCA token contract).
- Filters `to` = deposit addresses currently awaiting payment; can use the internal RPC gateway (your project RPC gateway) as the data source.
- Incoming event → wait for the confirmation threshold (anti-reorg) → match against pending `(user, listing)` → record in `payment_events`.

**Scan floor.** The block checkpoint says where scanning *got to*; on its own it cannot say where scanning must *begin*. A deposit address issued while the listener is behind — or before it has ever run — can sit below the checkpoint, and its payment is then never scanned at all. So every deposit address records the chain height at which it was issued (`deposit_addresses.created_at_block`), and the listener starts no later than the oldest still-pending deposit:

```
scan_start = min(checkpoint + 1, oldest pending deposit's created_at_block)
```

With nothing pending there is no address a payment could have landed on, so the head is a safe start. A deposit address is never issued while the chain is unreadable, since its issue height could not be recorded and the payment would be invisible to every later scan.

An address that is issued and never paid would otherwise pin that floor at its block forever, widening every `getLogs` call for the life of the system — a degradation that surfaces as "the RPC is slow", nowhere near its actual cause. So an unfunded address is retired after its TTL (`deposit_addresses.created_at`, the same lifetime as the `expires_in` promised at subscribe) and stops counting toward the floor. Retiring is the *only* way out: an address that holds funds is never retired, however old it is.

**Deposit audit (backstop).** A log scan only finds what it looked at, so a periodic pass asks the chain directly: for every pending deposit past confirmation depth, does the address hold a balance? A hit means funds arrived and access was never granted — logged at **ERROR**, never merely warned, because it is a user who paid and got nothing. This is a safety net, not part of the happy path; it firing at all means the scan floor above has a hole.

The same pass retires unfunded addresses, and the order of its two checks is load-bearing:

```
1. read the on-chain balance
2. balance > 0  → STRANDED PAYMENT (ERROR); status untouched, so a pending
                  address keeps holding the scan floor and the payment can
                  still be found
3. balance == 0 AND older than the TTL → status = 'expired_unpaid'
```

Reversed, the TTL would retire addresses on age alone — including one whose payment simply had not been credited yet. That releases the scan floor and loses the payment permanently: the same silent failure the scan floor exists to prevent, reintroduced by its own cleanup. Age can never overrule a non-zero balance.

Retired addresses stay in the audit for a bounded window afterwards, so a payment sent to an address after it expired still raises the ERROR rather than disappearing quietly.

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
- Grace period of 24–48 hours after expiry before access is revoked. The lifecycle is `active` → `grace` (at `expires_at`) → `expired` (at `expires_at + grace`), and the entitlement check honours the same clock: during `grace` the user **keeps access**. A grace period that only relabels an already locked-out subscription is not a grace period.
- The entitlement rule (status + grace window) lives in the $ARCA service alone; other services ask it rather than re-deriving it from subscription rows, so the two cannot drift apart.
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
| **Checkpoint sits ahead of a payment** | The original design assumed the checkpoint is always *behind* the payment, so "backfill from the checkpoint" was enough. It is not: a deposit address issued while the listener was behind (or before its first run) can sit below the checkpoint, and its transfer is then never scanned — funds arrive, access is never granted, and nothing warns. Handled by the scan floor in §10.2: the listener starts no later than the oldest still-pending deposit's `created_at_block`, and refuses to issue an address it could not record a height for. |
| **Payment stranded despite the scan floor** | Deposit audit (§10.2) reads the on-chain balance of every pending deposit past confirmation depth and logs an **ERROR** naming the address, user and listing. Silent loss of user funds is the one failure mode this design will not tolerate — if it cannot be prevented, it must at least be loud. |
| Sweep/payout job fails midway | Idempotent per `payment_event`/`creator_payout` (checkpoint by ID) |
| HD wallet deposit key management leaks | Derivation private keys stored in KMS/HSM — the most critical security point in the entire design |
| Payment tx fails after access was briefly granted (race) | Saga pattern: automatic reversal (revoke access) if `payment_events` is never confirmed within a given window |

---

## 11. Strategy Execution Isolation & Security

> **Superseded (2026-09-10).** Never built, and no longer needed: an agent is now an LLM prompt, and calling an API does not require a microVM. Its cost was zero, because it stayed a plan.
>
> The security problem it was solving does not disappear — it moves and gets sharper, because the platform now signs transactions. The replacement is the six-layer authority model in [on-chain-direction.md §f](./docs/on-chain-direction.md#f-agent-authority--six-layers-and-only-one-of-them-binds), whose load-bearing layer is a **signer process that accepts only a fixed set of transaction shapes and refuses any raw transfer to an arbitrary address**. Isolation is now about what a compromised caller can make the keys do, not about what a creator's code can read.

- Each `decision execute` request → spin up a short-lived **microVM** (Firecracker) or **gVisor sandbox** (per tick, then destroyed).
- The sandbox has no outbound network access (egress) except to the Market Data Service via an internal API — preventing exfiltration/"cheating" strategies.
- Strict resource limits (CPU/mem/timeout) per run — a timeout is treated as an automatic `hold`, recorded as `timeout_decision`.
- Creator-owned strategy models/code are stored **encrypted at rest** (S3 + KMS), only decrypted inside the sandbox at run time.
- Agent Service only exposes *outcomes* (decision, score) via API — strategy code is never exposed through public endpoints.

---

## 12. Data Consistency & Fairness

> **Partly superseded (2026-09-10).** Two of the four rules below change; two survive and are load-bearing.
>
> **"All agents within the same window use the identical snapshot" is gone.** It cannot survive real execution: agents trading the same pool move each other's prices, and with a per-agent cadence two agents four hours apart see different markets by construction. What the rule protected — that the score measures judgement, not the luck of the minute — is preserved differently: the ARCANA Score is computed on **decision quality**, marked against a reference price at the moment of the decision, while realised execution is scored separately. See [on-chain-direction.md §a](./docs/on-chain-direction.md#a-fairness--decision-quality-and-execution-quality-are-scored-separately) and [§c](./docs/on-chain-direction.md#c-slippage-gas-and-failed-transactions).
>
> **"Idempotent score recompute, deterministic from the same input" no longer holds for the decision itself.** An LLM can answer the same prompt differently. Scoring stays deterministic — it reads a NAV series and a decision log — but a *decision* is now **attested rather than reproducible**: prompt, raw response, model id and version, and the transaction hash. That is a weakening of the platform's central claim, and [§b](./docs/on-chain-direction.md#b-evidence--attested-not-reproducible) states it as one rather than letting marketing find it first.
>
> **Unchanged and still enforced:** the append-only decision log, and the foreign key binding a decision to the snapshot it cites. A decision without its evidence is not a weaker record, it is an unverifiable one — and that is now true of the transaction receipt as well.

- **Point-in-time snapshot**: one snapshot per tick window, immutable, hashed as `market_snapshot_ref`. All agents within the same window must use the identical snapshot.
- **Append-only Decision Log**: the `decisions` table is never UPDATE/DELETE'd — corrections via new compensating events (event sourcing).
- **Idempotent score recompute**: results are stamped with the last `computed_from_decision_id`, deterministic from the same input.
- **Snapshot retention is bound to the decisions that cite it**: a `market_snapshots` row cannot be deleted while any decision references it. Enforced by a foreign key with `ON DELETE RESTRICT` (migration 0019), not by convention.

  A decision without its snapshot is not a weaker record, it is an unverifiable one: what survives is a note that an agent did *something*, with no way to say against what market. "Verified Decision History" rests entirely on that pairing, and so does every consumer of it — Agent DNA prices trades and positions against the snapshot, and reads missing prices as zeros indistinguishable from real behaviour.

  The two tables are a **pair**. To retire old market data, retire the decisions that depend on it first, and record why ([docs/data-resets.md](./docs/data-resets.md)). This is a constraint rather than a note because the convention was already broken once: the Season 1 reset cleared `market_snapshots` while keeping decisions, orphaning 26 of them.

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
