# ARCANA Arbitrage — market-intelligence scanner

The first slice of `architecture.md` §20: a **read-only** service that scans the
venues a Stock Token trades on, compares executable buy/sell quotes, and records
one net-profit estimate per token per scan.

**It signs and sends nothing.** Execution (manual or autonomous) is out of scope
for this slice.

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

For each venue the scanner reads the Uniswap v3 spot price (`slot0`) and the
in-range liquidity (`liquidity()`). The executable quotes are the mid price
fee-adjusted:

- `buy_price = mid × (1 + fee_bps/10000)`
- `sell_price = mid × (1 − fee_bps/10000)`

For each token it picks the cheapest buy venue and the dearest sell venue, then:

- `gross_spread_bps = (sell_price − buy_price) / buy_price × 10000` — already
  net of both venues' fees, because the fees are inside the quotes.
- `est_net_profit_bps = gross_spread_bps − gas_bps − impact_buffer_bps`, where
  `gas_bps = gas_cost_usd / reference_size_usd × 10000`.

A row is `executable` when `est_net_profit_bps ≥ min_net_profit_bps`, else
`indicative`.

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
| POST | `/internal/v1/arbitrage/scan` | run a scan and record it (machine tier, `X-Internal-Key`) |

The background scanner runs every `SCAN_INTERVAL` (default 60s) and once at
startup; the `/internal` trigger lets a timer or an operator force one.

## Schema

Migration `0064_arbitrage_opportunities`: two standalone, namespaced tables —
`arbitrage_opportunities` (append-only, one row per token per scan) and
`arbitrage_scan_heartbeat` (single-row liveness). No §7 core table is altered,
and nothing in the core schema reads these rows.

## Running and verifying

Build and deploy through the normal path (`infra/systemd/install.sh`, which
builds `cmd/server` into `scheduler-bin/arbitrage` and runs
`arcana-arbitrage.service`). Verify with:

```bash
node infra/verify/run-all.mjs arbitrage-verify
```

The suite proves the invariants, not the prices: identity, sane venues, the
spread/net/status arithmetic, a fresh heartbeat, and that the core `agents`
table is untouched.
