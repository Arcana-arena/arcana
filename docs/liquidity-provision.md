# Liquidity Provision — fee APR vs IL, measured

The pivot from arbitrage (all phases NO) to the other side of the trade:
**providing liquidity** and earning the pool fee, rather than trying to take a
spread. This is where the arbitrageurs' fees actually accrue.

**Verdict: GO — on the stable WETH/USDG pairs.** Measured 2026-10-18 from
GeckoTerminal's live pool data. The sane, liquid pools pay a real fee APR
(24–98%) with near-zero impermanent loss, because they are USDG (stablecoin) vs
WETH pairs whose daily price move is small.

---

## Measured fee APR (24h volume × fee ÷ TVL, annualised)

The memecoin long tail is excluded from the recommendation — it shows absurd
APR (770%–14,000%) but with 24h price moves of 30%–12,000%, which is a rug
lottery, not a market-making business.

The pools worth LPing, sorted by daily fee income:

| Pool (DEX) | 24h vol | TVL | Fee | Fee income/day | Fee APR | 24h price Δ |
|---|---|---|---|---|---|---|
| USDG/WETH 0.01% (Uniswap v3) | $142.1M | $19.0M | 0.01% | $14,213 | 27.2% | +0.1% |
| WETH/USDG 0.05% (Uniswap v4) | $25.5M | $4.7M | 0.05% | $12,736 | 98.2% | −0.1% |
| USDG/WETH 0.05% (Uniswap v3) | $11.4M | $5.1M | 0.05% | $5,696 | 41.1% | −0.1% |
| WETH/USDG 0.05% (Sushiswap v3) | $4.2M | $3.2M | 0.05% | $2,103 | 24.3% | −0.0% |
| SPY/WETH 0.05% (Uniswap v3) | $3.5M | $2.0M | 0.05% | $1,753 | 32.6% | +0.8% |
| NVDA/WETH 0.05% (Uniswap v3) | $1.4M | $0.9M | 0.05% | $718 | 29.5% | +1.0% |

The fee-APR column is the **pool-wide average** (total fees ÷ total TVL). A
concentrated position placed in the active range earns a *larger* share per
dollar, at the cost of more IL when price leaves the range — so these numbers
are a full-range floor, not a ceiling.

## Impermanent loss

For a 50/50 position, IL from a fractional price move `d` is
`2·√(1+d)/(2+d) − 1`:

| Price move | IL |
|---|---|
| ±1.3% (WETH's 24h move) | −0.002% |
| ±5% | −0.03% |
| ±10% | −0.14% |

WETH/USDG and USDG/WETH have daily moves well under 5%, so IL is a rounding
error against a 24–98% fee APR. This is why the pair is the target: it is the
deepest, highest-volume book on the chain and it is *not* a lottery ticket.

## Why the arbitrage verdicts did not apply here

Arbitrage failed because the residual *taker* spread is below gas. Liquidity
provision does not need a spread to exist — it *earns the fee the takers pay*
and is compensated for inventory risk. On WETH/USDG the inventory risk (IL) is
near zero, so the fee is close to free money.

## Next: phased build (real money → checkpoints)

1. **Paper LP simulator** — a read-only engine that places a simulated
   concentrated position on WETH/USDG from live data and reports realized fee
   accrual vs IL over a real window. Proves the economics without capital.
2. **Signer `mint` shape** — add Uniswap v3 `NonfungiblePositionManager.mint`
   to the signer's fixed shape set (the sharp edge), allowlisted and proved by
   `eth_call` before any broadcast.
3. **LP engine + position manager** — set the range around the Chainlink/WETH
   oracle, size the two legs, harvest fees, and rebalance; with a heartbeat and
   emergency withdrawal.
4. **Small real position** — a capped, owner-approved deposit (e.g. a few
   hundred USD) on WETH/USDG 0.05%, watched end-to-end before any scale-up.
