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

## The opt-in: who may use it

**Arbitrage is OFF for every agent until its creator switches it on.** Migration
`0069_arbitrage_agent_settings` holds one row per agent that has been switched,
and an **absent row means disabled** — so every agent that existed before the
feature and every agent created after it starts off, with no backfill.

The owner's side:

| Where | What |
|---|---|
| `GET /v1/agents/:id/arbitrage` 🔒 | the agent's switch (owner only; agent-service checks ownership) |
| `PUT /v1/agents/:id/arbitrage` 🔒 | `{"enabled": true\|false}` — the creator's decision, recorded with the wallet that made it |
| Agent page → **Arbitrage** tab | the same control, with what each state does and does not stop |

The machine side (agent-service is the only caller):

| Where | What |
|---|---|
| `GET /v1/arbitrage/agents/settings?limit=` | the switches that have been touched (public; an absent agent is disabled) |
| `GET /v1/arbitrage/agents/{agent_id}/settings` | one agent's switch; a missing row answers `exists:false, enabled:false` — the default, not a 404 |
| `POST /internal/v1/arbitrage/agents/{agent_id}/settings` | `{"enabled":bool,"actor":"0x…"}` — machine tier (`X-Internal-Key`); `enabled` and `actor` are both required and neither defaults |

**What "off" gates, and what it deliberately does not** (the wind-down rule):

- **Gated:** opening a new position, and rebalancing a range the price has left —
  a rebalance burns the old position and mints a new one, which is new exposure.
  A rebalance proposal queued *before* the switch was flipped is superseded by
  the pass that sees the switch off, so the executor cannot pick up a decision
  its owner has already revoked.
- **Not gated:** harvesting accrued fees, and closing a position that has been
  emptied. Neither adds exposure or moves a range, and switching the feature off
  must not strand funds in a pool or leave collectable fees uncollected.

The gate is applied in three places, deliberately: the LP loop refuses to
propose (the normal path), `lpexec` refuses to sign a rebalance for a disabled
agent (defence in depth against a queue older than the switch), and the
`--open` command refuses outright — opening is the one act that creates a
position. Every one of them treats an **unreadable** setting as OFF: a feature
that gates somebody else's funds may only fail in the direction of not acting.

Enabling is refused when the agent is retired, or when it has no trading wallet
(a position belongs to that wallet) — the refusal names the missing step rather
than appearing to succeed.

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
| GET | `/v1/arbitrage/lp/pnl?status=&limit=` | realised PnL per position: fees the collect transactions paid out, minus gas they and the open burned |
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

## PnL, defined

`/v1/arbitrage/lp/pnl` answers one question: what has this position actually
earned after what it cost. It is **realised only**, and the response says so in
its own `note`.

| Counted | Where it comes from |
|---|---|
| Collected fees | The position manager's `Collect` event on each **mined** receipt, for actions whose intents are a harvest (`lp_collect` and nothing else). A collect that follows a decrease, burn or mint also pays out principal, so those are excluded: booking them would count the owner's own capital as profit. |
| Gas | Every transaction the platform sent for the position: the open (`lp_opens.tx_hash`), each executor step, and attempts that reverted. Each receipt's `gasUsed × effectiveGasPrice`. A reverted transaction still burns gas. |

| Not counted | Why |
|---|---|
| Fees still accruing in the position | They are not realised. `/v1/arbitrage/lp/position?token_id=` reports the exact accrual (`fees_owed`) via `feeGrowthInside`. |
| The position's own value change | Impermanent loss and price moves are not income. The position endpoint reports what it holds now. |
| Gas for transactions the platform never sent | There are none to read, and assuming one would invent a cost. |

**Valuation is as-of-now.** Fees arrive in the position's pair and are priced at
that pair's own pool spot price at request time; the quote side is $1. Gas is
priced at the deepest live `WETH/USDG` pool among the 0.01%, 0.05%, 0.3% and 1%
tiers, from the reviewed WETH address in `config/robinhood-arbitrage.json`. If
that pool cannot be read the endpoint still reports gas in ETH and leaves the
USD value `null` with the reason, rather than converting at a guessed rate. A
null on any side makes `totals.complete` false.

Because the numbers come from receipts, they can be checked against the chain:
`arbitrage-lp-verify` re-reads every harvest transaction, decodes the `Collect`
event itself, and asserts the endpoint's amounts and `net = fees − gas` match.

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
