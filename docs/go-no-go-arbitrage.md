# Go/No-Go — is same-chain DEX arbitrage on Stock Tokens viable?

The ARCANA Arbitrage product (§20 of `architecture.md`) starts with **Phase 1,
same-chain DEX arbitrage**: buy an asset on DEX A and sell it on DEX B, both on
Robinhood Chain. That premise needs **two venues** for the same asset whose
spread clears both venues' fees plus gas and price impact. This test asked the
chain whether such venues exist.

**Verdict: NO — not today.** The Stock Token universe trades on exactly one
liquid venue (Uniswap v3), and the only second venue that exists at all
(Uniswap v2) holds dust. Measured 2026-10-18 against Robinhood Chain mainnet.
Zero transactions broadcast, zero money spent, nothing changed.

Related: `architecture.md` §20, `docs/go-no-go-stock-tokens.md` (the test that
established Stock Tokens trade at all), `docs/secondary-market.md`.

---

## Why the test existed

The brief's Phase 1 assumes "same asset, different markets, different prices".
On a chain where Uniswap carries 82% of DEX volume and the tokenized-equity
book is a small niche, that assumption had never been checked. Three facts from
the codebase already leaned against it:

- The signer allowlist (`services/signer/allowlist/robinhood-mainnet.json`) knows
  **one** router and **one** factory: SwapRouter02 on Uniswap v3 factory
  `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`.
- The market-data config (`services/market-data/config/robinhood-chain.json`)
  records, per secondary token, a traded pool plus a **1% referee pool** — a
  second price, but at a 1% fee that no spread clears.
- Nothing in the repo reads Uniswap v2 or any other AMM.

The question was whether those facts are the whole picture or just the parts
ARCANA happened to wire up.

---

## Method

Read-only `eth_call` against live state, over four public RPCs (publicnode,
pocket, blockmachine, and the official Robinhood endpoint — all four returned
chain id `0x1237` = 4663). Probe scripts were throwaway and are not in this
repository, same precedent as `go-no-go-stock-tokens.md`.

Venues were enumerated from a community registry of Robinhood Chain
infrastructure (`rhchain-registry`, `dist/registry.json`) plus DefiLlama's DEX
volume ranking. The registry lists **Uniswap v2, v3 and v4** as the only DEXes
with public deployment addresses; the rest of the registry is launchpads. So
the second-venue question reduces to "does any non-v3 Uniswap deployment hold
Stock Token liquidity".

For every allowlisted Stock Token the test read, on chain:

1. Uniswap v2 factory `0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f`:
   `getPair(token, USDG)` and `getPair(token, WETH)`.
2. Uniswap v3 factory `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`:
   `getPool(token, USDG, fee)` for fee tiers 0.01% / 0.05% / 0.3% / 1%, to
   enumerate every pool, not just the one the allowlist trades.
3. For any found v2 pair, reserves were read via `balanceOf(pair)` on both
   tokens — `getReserves()` **reverts** on this v2 fork, so balances are the
   reserve proxy (they differ only by the not-yet-swapped fee accrual).
4. For any found v3 pool, `slot0()` price and in-range `liquidity()` were read.

Token ordering was read (`token0()` / `token1()`), never assumed, because
several secondary tokens sort below USDG and invert the raw price.

---

## Results

### Uniswap v2 — the only second venue, and it is dust

Of 20 Stock Tokens, **five** have a `token/USDG` v2 pair. Their USDG side is
empty, so every one is a one-sided book that cannot fill a real swap:

| Symbol | v2/USDG pair | USDG reserve (≈ USD) | Stock reserve |
|---|---|---|---|
| AAPL | `0xd0bbf7df…3647` | $0.00 | 0.000026 AAPL |
| NVDA | (present) | $0.00 | 0.00086 NVDA |
| SPY | (present) | $0.005 | 6.55 SPY |
| TSLA | (present) | $0.000003 | 0.0099 TSLA |
| AMZN | (present) | $0.00 | 6.3e-11 AMZN |

The other **15 tokens have no v2/USDG pair at all**. `AAPL/WETH` and the other
`WETH` pairs exist on v2 but are equally irrelevant to a USDG-denominated trade
and were not pursued.

The v2 `getReserves()` revert is itself notable: this is not the canonical
Uniswap v2 pair — it is a modified fork — which is exactly the kind of
"addresses from a registry are data, not proof" trap the registry's own README
warns about.

### Uniswap v3 — one liquid pool per token

Every token's real liquidity sits in a single v3 pool (the one the allowlist
already trades). The other fee tiers are either empty (`liquidity() = 0` for
most 0.01% and several 0.05%/0.3% pools) or the 1% referee pool that exists to
referee, not to trade. So within v3 there is no competing pool either: the
"second price" for secondary tokens is a 1% pool, and a 1% fee on one leg plus
a 0.3% fee on the other is a 1.3% round-trip floor no measured spread
approaches.

### The spread that exists is noise, not a market

Where a v2 price could be computed at all (AAPL, NVDA, SPY, TSLA), it sits
within **0.38%** of the v3 price — and that "price" comes from a dust pool, so
it is an unexecutable quote, not a real cross-venue spread. The cheapest
round-trip (v2 0.3% + v3 0.05%) costs 0.35% before gas (~$0.11) and impact,
so even the largest dust-pool spread (TSLA ≈ 0.38%) does not clear costs.

| Symbol | v2 price | v3 traded price | Gross spread | Round-trip fee floor |
|---|---|---|---|---|
| AAPL | 343.22 | 343.22 | ≈ 0.00% | 0.35% |
| NVDA | 213.64 | 213.74 | 0.05% | 0.35% |
| SPY | 762.35 | 763.35 | 0.13% | 0.35% |
| TSLA | 350.02 | 351.34 | 0.38% | 0.35% |

(AMZN's v2 price reads ~15,847 — a dust-pool artifact, not a market.)

---

## What this means for Phase 1

**Same-chain DEX arbitrage on Stock Tokens is not viable today.** The premise
fails at the first condition: there is no second venue with real liquidity, so
there is no spread to capture. Building the scanner on this premise would be
"another dashboard that shows price differences" — the exact thing the brief
says not to build.

The two later phases are not affected by this finding and are each their own
go/no-go:

- **Phase 2, cross-chain arbitrage** — whether the same (or wrapped) Stock
  Token trades on another chain with meaningful depth, and whether bridging
  costs/timing leave a margin. Not tested here.
- **Phase 3, DEX↔CEX arbitrage** — the on-chain pool price against Robinhood's
  (or another CEX's) off-chain order book is **not** bounded by a second
  on-chain venue's fee, so it is the more plausible source of a real spread. It
  needs CEX API access and pre-funded balances, and carries inventory and
  withdrawal-timing risk. Not tested here.

---

## What could not be established

- **Uniswap v4** was not exhaustively probed (pool ids are keccak hashes over a
  five-field tuple, so enumeration is not a single `getPool` call). The finding
  that v2 — the older, more-adopted AMM — holds dust for Stock Tokens makes a
  v4 Stock Token market implausible, but it was not disproven directly.
- The **non-Uniswap long tail** (Fables, Metric, Tessera V, RamsesX, Sushi,
  Alandale, Ekubo, Arcus, GIGA, …) was not individually probed. Their combined
  24h volume is ~$127m versus Uniswap's $568m, they are overwhelmingly
  memecoin/launchpad ecosystems, and the registry lists none of them with
  Stock Token pools — so the prior is strongly against them, but no `getPool`
  was run against their factories.
- Whether the **spread picture changes with size** (a large order moving the
  single v3 pool against a CEX) — that is the Phase 3 question, not a
  same-chain DEX question.

## Reproducing

Every address and selector is above. Re-check in minutes with `eth_call`:
`getPair` on the v2 factory returns the five dust pairs; `balanceOf(pair)` on
USDG returns ~zero for each; `getPool(token, USDG, fee)` on the v3 factory
returns one liquid pool per token plus empty/referee pools.
