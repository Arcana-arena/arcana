# ARCANA Arbitrage — market-intelligence scanner

The first slice of `architecture.md` §20: a **read-only** service that scans the
venues a Stock Token trades on, compares executable buy/sell quotes, and records
one net-profit estimate per token per scan.

**It signs and sends nothing.** Execution (manual or autonomous) is out of scope
for this slice.

It also keeps the LP position registry (`lp_positions`, migration 0065) in step
with the chain: it discovers position NFTs from ERC-721 Transfer logs, refreshes
each one's state, and **proposes** the action an out-of-range or empty position
needs. Proposing is the whole of it — nothing in ARCANA calls the signer's
`lp_*` shapes yet, so a proposal is a plan with a paper trail, not a queue with
a worker.

## The honest steady state

The same-chain go/no-go ([go-no-go-arbitrage.md](./go-no-go-arbitrage.md),
2026-10-18) returned **NO**: Stock Tokens trade on exactly one liquid venue
(Uniswap v3), the v2 pairs are dust, and no spread clears the round-trip fees.
So today the scanner is expected to mark every row `indicative`, never
`executable`. It exists as the foundation Phase 2 (cross-chain) and Phase 3
(DEX↔CEX) build on — the detector and the profitability math are venue-agnostic.

## Configuration

Two reviewed files, never runtime settings:

- **Venues** come from the signer allowlist
  (`services/signer/allowlist/robinhood-mainnet.json`): each token's traded v3
  pool, plus its 1% referee pool when it has one. Reading the signer's file
  directly means the scanner and the signer cannot drift on what a token's pool
  is.
- **`services/arbitrage/config/robinhood-arbitrage.json`** adds venues the
  allowlist does not name (the dust Uniswap v2 pairs) and holds the scanner's
  settings: `min_net_profit_bps`, `reference_size_usd`, `gas_cost_usd`, and
  `impact_buffer_bps`.

## Quote and classification model

Each venue is read by its own DEX: a Uniswap v3 pool with `slot0` (spot price)
and `liquidity()` (in-range liquidity); a Uniswap v2 pair with `getReserves()`
and `token0()`, priced as `(quote_reserve / token_reserve) × 10^(token_dec −
quote_dec)` and carrying its quote-side reserve as the audit value. Mixing the
two readers is what made every v2 venue log `execution reverted` on every scan
until 2026-10-20 — `slot0()` on a v2 pair does not exist.

The executable quotes are the mid price fee-adjusted:

- `buy_price = mid × (1 + fee_bps/10000)`
- `sell_price = mid × (1 − fee_bps/10000)`

For each token the scanner picks the two **distinct pools** with the largest
`sell_price − buy_price`, then:

- `gross_spread_bps = (sell_price − buy_price) / buy_price × 10000` — already
  net of both venues' fees, because the fees are inside the quotes.
- `est_net_profit_bps = gross_spread_bps − gas_bps − impact_buffer_bps`, where
  `gas_bps = gas_cost_usd / reference_size_usd × 10000`.

A row is `executable` when `est_net_profit_bps ≥ min_net_profit_bps`, else
`indicative`.

**Two rules keep rows honest, added 2026-10-20 after the live scanner was
audited against its own output:**

1. **Distinct pools, not distinct venue names.** A token whose venues are one
   pool produced a row comparing that pool with itself: bought at
   `mid × (1+fee)` and sold at `mid × (1−fee)`, i.e. exactly −2×fee. That is the
   round-trip cost, not an opportunity, and it was the only row every
   single-venue token ever recorded. Those tokens produce **no row** and are
   counted in the scan's `single_venue_tokens` instead.
2. **A venue that cannot carry the reference size cannot make a row
   `executable`.** A v2 pair whose quote-side reserve is below
   `reference_size_usd` is dust: the config lists those pairs "so the scanner can
   measure them, not because they are tradeable" (see `extra_venues`), and a
   price that looks profitable there says nothing about a fill. Such rows are
   recorded `indicative` and the reason is logged. Only v2 venues can be
   checked this way today; v3 venues carry no reserve figure, so the
   `impact_buffer_bps` placeholder stands in for them.

**Price impact is not yet computed from liquidity.** `impact_buffer_bps` is a
deliberate first-slice placeholder (default 0.1%), documented in the config;
exact impact via an `exactInputSingle` simulation replaces it in a later slice.
The raw `liquidity()` value is still recorded per row, so the placeholder is
auditable.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | identity + build commit |
| GET | `/v1/arbitrage/venues` | the configured token/venue list (read-only) |
| GET | `/v1/arbitrage/opportunities` | the most recent scan's rows (read-only, never triggers a scan) |
| GET | `/v1/arbitrage/opportunities/history?limit=` | the last N rows across scans |
| GET | `/v1/arbitrage/lp/plan?symbol=&size_usd=&range_pct=` | a concrete `lp_mint` plan for the token's v3 pool (read-only) |
| GET | `/v1/arbitrage/lp/position?token_id=` | one position read back: in-range, amounts, stored fees (`tokens_owed`), exact accrual (`fees_owed`, recomputed from `feeGrowthInside`), recommendation (read-only) |
| GET | `/v1/arbitrage/lp/positions?status=&limit=` | the registry — what agent wallets own and the state last read |
| GET | `/v1/arbitrage/lp/actions?limit=` | outstanding proposals (nothing executes them) |
| GET | `/v1/arbitrage/lp/executions?limit=` | what the executor signed, sent and was answered with, per intent |
| GET | `/v1/arbitrage/lp/opens?limit=` | the opens recorded by the capped open tool, with token id and transaction |
| POST | `/internal/v1/arbitrage/scan` | run a scan and record it (machine tier, `X-Internal-Key`) |
| POST | `/internal/v1/arbitrage/lp/sync` | run one registry pass now (machine tier, `X-Internal-Key`) |

The background scanner runs every `SCAN_INTERVAL` (default 60s) and once at
startup; the `/internal` trigger lets a timer or an operator force one.

The LP registry loop runs every `LP_SYNC_INTERVAL` (default 5 minutes) and once
at startup: it refreshes every open position, discovers new ones from ERC-721
Transfer logs filtered to the agent wallets in `agent_wallets`, and keeps the
proposals in step with the recommendations. Discovery is incremental — the
cursor in `lp_sync_heartbeat.discovery_block` is the next block to read —
because the providers cap a recipient-filtered `eth_getLogs` at 100,000 blocks
(measured 2026-10-19), so the loop reads in windows and resumes where a failed
window stopped instead of moving past it. A pass already running answers 409
(`sync_busy`) rather than stacking: the endpoint and the loop share one syncer.

## Schema

Migration `0064_arbitrage_opportunities`: two standalone, namespaced tables —
`arbitrage_opportunities` (append-only, one row per token per scan) and
`arbitrage_scan_heartbeat` (single-row liveness). No §7 core table is altered,
and nothing in the core schema reads these rows.

Migration `0065_lp_positions`: three standalone, namespaced tables for the LP
registry — `lp_positions` (one row per position NFT, state overwritten on every
sync), `lp_position_actions` (append-only; a proposal stands while the
recommendation that produced it holds, then is superseded), and
`lp_sync_heartbeat` (single-row liveness + the discovery cursor). Same
boundary: no §7 core table is altered.

## Running and verifying

Build and deploy through the normal path (`infra/systemd/install.sh`, which
builds `cmd/server` into `scheduler-bin/arbitrage` and runs
`arcana-arbitrage.service`). Verify with:

```bash
node infra/verify/run-all.mjs arbitrage-verify
node infra/verify/run-all.mjs arbitrage-lp-verify
```

The suites prove the invariants, not the prices: identity, sane venues, the
spread/net/status arithmetic, a fresh heartbeat, and that the core `agents`
table is untouched. The LP suite adds: the registry endpoints answer, a pass
runs and reports no errors, the heartbeat is fresh with a discovery cursor,
every row belongs to the configured position manager, every outstanding action
is only ever `proposed` with named intents, and the signer's journal shows zero
`lp_*` signings — the check that "proposes but never executes" is still true.
It also exercises the registry's read path with a self-removing
`provenance='verification'` row, and checks the fee math against the chain
itself: for a live position it finds by scanning back from the position
manager's `totalSupply`, `fees_owed0/1` must equal a simulated
`collect(max,max)` from the owner — the contract's own answer, not ours.
