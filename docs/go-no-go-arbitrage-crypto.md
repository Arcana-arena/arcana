# Go/No-Go — is same-chain DEX arbitrage viable on Robinhood Chain's liquid crypto?

A pivot from Stock Tokens (all three phases NO) to the chain's liquid crypto /
memecoin book. The premise is the same as `architecture.md` §20 Phase 1: the
same asset priced differently on two DEXes, with a spread that clears both
venues' fees plus gas.

**Verdict: NO.** The only liquid pair that trades on multiple DEXes — WETH/USDG
— is already arbitraged to a **2.33 bp** maximum spread, below the round-trip
fee floor. Memecoins trade on a single DEX, so there is no second venue to
arbitrage against. Measured 2026-10-18 against Robinhood Chain mainnet. Zero
transactions broadcast, zero money spent.

Related: `docs/go-no-go-arbitrage.md` (Stock Token same-chain, NO),
`architecture.md` §20.

---

## Why the test existed

Stock Token arbitrage is dead in all three phases (one venue, no CEX, no
bridge). Robinhood Chain nonetheless clears ~$700m/day of DEX volume across
~47 DEXes — so a different asset class might carry the spread the Stock Tokens
lack. This test asked whether the liquid crypto book actually does.

The decisive question is narrow: **is there a liquid asset with a cross-DEX
price difference above cost?** If even the most liquid pair is arbitraged
tight, then professional arbitrageurs are already active and the residual
spread is not capturable.

---

## Method

1. Enumerate the chain's DEXes and top pools from GeckoTerminal's public API
   (`/networks/robinhood/dexes`, `/networks/robinhood/pools`).
2. Identify which tokens trade on **more than one** DEX.
3. Read the on-chain `slot0()` price directly for the WETH/USDG pools across
   DEXes — not GeckoTerminal's oracle price, which would hide the actual
   per-pool spread. Token ordering is read (`token0()`), never assumed.

---

## Results

### The chain has many DEXes, but one liquid multi-DEX pair

GeckoTerminal lists ~47 DEXes (Uniswap v2/v3/v4, Pancakeswap, Sushiswap,
Ramses v3, Giga v2/v3, Alandale, Ekubo, Up v3, Curve, and a long launchpad
tail). The top-20 pools by reserve show that **only WETH/USDG is meaningfully
multi-DEX**: it has liquid pools on Uniswap v3 (two), Uniswap v4, Ramses v3,
Giga v3, Up v3 and Alandale CL. Every memecoin in the top list (TSI, COVENANT,
BOOMER, EMPIREX, hi, …) has a single pool on a single DEX.

### WETH/USDG — the spread is 2.33 bp, below cost

On-chain `slot0()` across five v3-style DEXes:

| Venue | WETH (USDG) | In-range liquidity |
|---|---|---|
| Uniswap v3 0.01% | 2371.6508 | ~$1.06e18 |
| Uniswap v3 0.05% | 2371.0983 | ~$9.0e17 |
| Ramses v3 0.01% | 2371.4805 | ~$1.28e17 |
| Giga v3 0.005% | 2371.4802 | ~$1.7e16 |
| Up v3 0.05% | 2371.6327 | ~$6.0e16 |
| Alandale CL 0.006% | unreadable (non-standard ABI) | — |

Maximum mid-price spread: **2.33 bp** (2371.0983 → 2371.6508).

The round-trip fee for the two extreme pools is 0.05% + 0.01% = **6 bp**; even
the two cheapest pools (0.005% + 0.01%) cost ~1.5 bp in fees alone before gas.
The 2.33 bp spread does not clear either. Net of fees and gas, every
cross-DEX WETH/USDG arbitrage is negative.

---

## Interpretation

- **The liquid book is already arbitraged.** A 2.33 bp max spread on the
  chain's deepest pair means market makers and arbitrage bots are compressing
  it continuously. The residual is below the fee floor, so there is no spread
  left for a new entrant to capture at this depth.
- **Memecoins have no second venue.** A memecoin that trades on one pool on one
  DEX cannot be arbitraged same-chain; there is nowhere to sell the other leg.
  (Triangular arb inside one DEX is a different, later idea — §20 Phase 4 —
  and does not change this finding.)

---

## What could not be established

- A memecoin listed on two DEXes with a transient spread wider than fees during
  a volatility spike. The top-pool sample found none with two liquid venues;
  the prior is strongly against it, but not every pool was enumerated.
- Whether a high-frequency, low-latency, high-capital operation could capture a
  sub-fee spread that a snapshot cannot see. That is a latency/capital contest
  against existing bots, not a market inefficiency a scanner can act on.

## Reproducing

Pool addresses and the `slot0()` reader are above. Re-run `eth_call` on the
five pools and compute the max-min mid spread; it sits near 2–3 bp, below the
round-trip fee of the two extreme pools.
