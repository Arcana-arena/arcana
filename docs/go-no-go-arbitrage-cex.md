# Go/No-Go — is DEX↔CEX arbitrage on Stock Tokens viable?

Phase 3 of `architecture.md` §20: buy/sell a Stock Token on-chain (Robinhood
Chain) against the same asset off-chain (a centralized venue). The premise needs
a spread between the on-chain pool and the off-chain book that clears the
on-chain fee, gas, the CEX fee/spread, and settlement risk.

**Verdict: NO — not today, for three independent reasons.** Measured
2026-10-18 against Robinhood Chain mainnet. Zero transactions broadcast, zero
money spent.

1. **The apparent spread is a closed-market artifact, not a tradeable price.**
2. **There is no accessible CEX counterparty to trade against.**
3. **The US exclusion is a legal blocker, not an engineering one.**

Related: `docs/go-no-go-arbitrage.md` (same-chain, also NO),
`docs/go-no-go-stock-tokens.md`, `architecture.md` §20.

---

## Why the test existed

Same-chain DEX arbitrage is dead (one venue). The natural next question is
whether the on-chain pool ever diverges from the *underlying* asset's price —
the asset that trades continuously on US equity exchanges. The on-chain pool
trades 24/7; US equities do not. That mismatch is exactly where a spread would
appear, and this test measured whether it is real.

The codebase already gives an on-chain oracle for the off-chain price: a
Chainlink feed per primary Stock Token, which aggregates the underlying's USD
price. `docs/go-no-go-stock-tokens.md` recorded pool-vs-feed deviation of
0.040% (TSLA) to 0.244% (QQQ) on 2026-09-11, a weekday, when the feeds were
fresh.

---

## Method

Read-only `eth_call` against live state over four public RPCs. For each of the
nine primary tokens (the ones with a Chainlink feed), read:

1. the pool's `slot0()` spot price (token ordering read, never assumed);
2. the Chainlink feed's `latestRoundData()` and `decimals()` — and, crucially,
   its `updatedAt`, because a feed that has stopped updating still answers with
   its last value.

A real-time off-chain quote was also attempted (Yahoo Finance, Stooq); both
were rate-limited or empty from the VPS, which itself is a finding about the
availability of a clean off-chain price feed. The Chainlink feed is the
authoritative off-chain reference for this test.

---

## Results

| Symbol | Pool (USDG) | Chainlink (USD) | Deviation | Feed age |
|---|---|---|---|---|
| AAPL | 343.08 | 343.01 | +0.020% | 43.4h |
| NVDA | 212.21 | 214.59 | **−1.108%** | 44.4h |
| GOOGL | 338.23 | 339.85 | −0.477% | 44.4h |
| SPY | 761.91 | 762.83 | −0.121% | 43.8h |
| QQQ | 706.57 | 708.94 | −0.334% | 43.8h |
| TSLA | 349.81 | 352.55 | −0.777% | 42.0h |
| AMZN | 248.54 | 249.16 | −0.249% | 44.7h |
| MSFT | 526.90 | 528.87 | −0.372% | 42.8h |
| META | 705.10 | 706.52 | −0.201% | 39.6h |

Every feed last updated Friday 2026-10-16 (18:00–23:00 UTC); the reading was
taken Sunday 2026-10-18 ~14:43 UTC. The feeds are 40–45 hours stale — the US
market is closed and the oracle froze at Friday's close.

**The deviation is a weekend, not a spread.** The pools kept trading while the
oracle was frozen, so "NVDA −1.1%" is the pool moving over a closed market, not
a price two simultaneous venues disagree on. There is no off-chain venue to
sell into on a Sunday: the "CEX" leg does not exist while the US market is
closed. When the feeds are fresh — as measured 2026-09-11 — the deviation is
0.04–0.24%, which is below the on-chain round-trip cost alone (5–30 bp pool fee
plus ~12 bp gas at $100), before any CEX fee or spread.

---

## The two non-data blockers

1. **No CEX counterparty exists for these tokens.** The tokens are Robinhood's
   own; they are not listed on Coinbase, Kraken or Binance. The only
   off-chain venue for the underlying is Robinhood's own brokerage, which
   offers **no public programmatic trading API** (its API is unofficial and
   restricted). So Phase 3 as specified — "integrate supported centralized
   exchanges through their APIs" — has no exchange to integrate.

2. **US exclusion.** `go-no-go-stock-tokens.md` condition 3 already records
   this as a legal blocker on the phase that admits public users. It is not an
   engineering question and it does not disappear for DEX↔CEX.

---

## What could not be established

- A **fresh-market** (Monday-open) pool-vs-CEX spread with a real-time off-chain
  quote, because the test ran on a weekend and the public quote sources were
  rate-limited. The 2026-09-11 measurement (0.04–0.24% when fresh) is the
  closest prior, and it is below cost.
- Whether a transient Monday dislocation large enough to clear costs occurs, and
  how long it lives. That would need a weekday observation window against a live
  CEX feed — and it is moot while blockers 1 and 2 stand.

## Reproducing

All addresses and selectors are in
`services/market-data/config/robinhood-chain.json` (feeds) and the pool reader
above. Re-check with `eth_call`: `slot0()` for the pool price and
`latestRoundData()` (word 3 = `updatedAt`) for the feed age. The weekend
deviation collapses when the feed's `updatedAt` is recent.
