# Go/No-Go — can an ARCANA agent borrow USDG against a Stock Token?

ARCANA CAPITAL (architecture.md §17) rests on one premise: that a lending
market on Robinhood Chain accepts an allowlisted Stock Token as collateral,
prices it with an oracle somebody can check, and lets a wallet the platform
created borrow against it. This asked the chain.

**Verdict: GO, for one market, with six conditions.** Run 2026-09-24 against
Robinhood Chain mainnet, block 71 404 524. Zero transactions broadcast, zero
money spent, nothing changed.

Related: [go-no-go-stock-tokens.md](./go-no-go-stock-tokens.md) (the swap-path
test this one copies its method from), architecture.md §17.7 day 4.

---

## Method

Everything was read from chain state over RPC, from the VPS: this machine's ISP
intercepts `*.chain.robinhood.com` and `docs.robinhood.com`, as it did on
2026-09-10.

1. **Candidates.** Web and protocol registries name Morpho as the lending layer
   (Robinhood Earn routes USDG into Morpho vaults). Morpho publishes three
   addresses for chain 4663; each was checked to carry code. Fenn, Ethosis and
   Syndromics also advertise stock-backed USDG loans; they are peer-to-peer or
   fixed-rate front ends, not a pool an agent can draw on and repay at will, and
   were not pursued.
2. **Markets.** Every `CreateMarket` event Morpho has emitted was read — 278 of
   them — and each market's parameters and current balances decoded.
3. **Oracle.** The candidate markets' oracles were read function by function.
   Where the standard getters reverted, the bytecode's selectors were decoded
   and the price reproduced by hand from its inputs.
4. **Calldata.** `supplyCollateral`, `borrow`, `repay` and `withdrawCollateral`
   were executed in sequence with `eth_simulateV1` from a freshly generated
   address, funded with 1 NVDA inside the simulation only. **Four controls, each
   of which must revert**, ran beside the real path. A simulation with no
   failing control proves the call was accepted, not that it would do anything.

---

## Results

| # | Question | Result |
|---|---|---|
| L1 | Is there a lending protocol on 4663? | **Yes** — Morpho Blue `0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010`, 15 582 bytes of code |
| L2 | Does any market take an allowlisted Stock Token as collateral against USDG? | **Yes** — 80 USDG markets across all nine allowlisted tokens, plus two against WETH |
| L3 | Does one take **NVDA** with real liquidity? | **Yes** — two worth considering, both LLTV 62.5% (below) |
| L4 | Is the oracle a known feed? | **Yes, both** read Chainlink `Robinhood NVDA / USD` and `USDG / USD`, listed in Chainlink's own directory for `robinhood-mainnet` |
| L5 | Can a fresh, un-KYC'd wallet supply, borrow, repay and withdraw? | **Yes**, on both markets, every step |
| L6 | Do the controls revert? | **Yes**, all four on both markets, each with the protocol's own reason |

### The two NVDA/USDG markets

| | Market `0x8b16…3e` | Market `0x6630…dc` |
|---|---|---|
| Market id | `0x8b16891f032a93b771347c9cb470a780e6699dd701553d3402aa3cdba6189c3e` | `0x66306c087add8907752320b309934abcc354d21626de8115c79df49d9c214edc` |
| Oracle | `0xED29D310cfa91778A5850538DA28ed42234Cb78c` | `0xC5b8A6C5fDF14f9744dB1C8595f49E42Ce23031a` |
| Oracle source | **custom, not from Morpho's factory** | Morpho `ChainlinkOracleV2` factory `0xB7c16F6F…cdF2` — `isMorphoChainlinkOracleV2` returns `true` |
| Price of 1 NVDA | 223.351 USDG | 223.178 USDG |
| Supplied / borrowed | 173 792.72 / 902.04 USDG | 6 578.67 / 417.10 USDG |
| Available to borrow | 172 890.68 USDG | 6 161.57 USDG |
| IRM | AdaptiveCurveIrm `0x2BD3d596…0fa1` | same |
| LLTV | 62.5% | 62.5% |
| Protocol fee | 0 | 0 |

For reference at the same minute: Chainlink `NVDA / USD` answered 223.198, and
the Uniswap pool ARCANA trades against priced NVDA at 223.073 USDG.

### Why the larger market is not the one

**Its oracle counts the dividend multiplier twice.** Robinhood Stock Tokens carry
a `uiMultiplier` (1.000775 on NVDA today) that folds corporate actions into the
token. Chainlink's documentation for these feeds states the feed already
reports that total-return value: "Token Price = Underlying Equity Market Price ×
Multiplier". The custom oracle then multiplies by the token's `uiMultiplier`
again: 223.198 × 1.000775 ÷ 1.00009 = 223.351, exactly its `price()`. The error
is 0.08% today and grows with every dividend.

**And it cannot be checked except by doing that arithmetic.** Its source is not
published, its standard getters revert, and it was understood only by decoding
selectors out of bytecode (`baseFeed`, `quoteFeed`, `MAX_QUOTE_AGE` = 90 000 s,
`StaleQuote`, `OraclePaused`, `uiMultiplier`). It does carry a staleness check
the factory oracle lacks, which is a real point in its favour. But a collateral
price that is known to be wrong in one direction, from code nobody can read, is
the "oracle nobody can verify" that §17.7 names as a no on its own.

**The smaller market's oracle can be checked by anyone**: a factory-made
`ChainlinkOracleV2` whose configuration is readable on-chain — `BASE_FEED_1` is
`Robinhood NVDA / USD` `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` and
`QUOTE_FEED_1` is `USDG / USD` `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2`,
both with the proxy addresses, heartbeat and deviation Chainlink lists.

### The feeds

| Feed | Proxy | Heartbeat | Deviation | Category | Hours |
|---|---|---|---|---|---|
| Robinhood NVDA / USD | `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` | 86 400 s | 0.5% | custom | us_equities 24/5 |
| USDG / USD | `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2` | 86 400 s | 0.5% | medium | crypto |

At the time of the test, NVDA's last update was 18 112 s old and USDG's
78 352 s — both inside their heartbeat. `oraclePaused()` on the NVDA token
answered `false`.

### The calldata

| Step | Selector | Call |
|---|---|---|
| approve NVDA | `0x095ea7b3` | `NVDA.approve(Morpho, amount)` |
| supply | `0x238d6579` | `Morpho.supplyCollateral(marketParams, assets, onBehalf=self, data=0x)` |
| borrow | `0x50d8cd4b` | `Morpho.borrow(marketParams, assets, shares=0, onBehalf=self, receiver=self)` |
| approve USDG | `0x095ea7b3` | `USDG.approve(Morpho, amount)` |
| repay | `0x20b76e81` | `Morpho.repay(marketParams, assets, shares=0, onBehalf=self, data=0x)` |
| withdraw | `0x8720316d` | `Morpho.withdrawCollateral(marketParams, assets, onBehalf=self, receiver=self)` |

`marketParams` for the chosen market is
`(USDG 0x5fc5360D…d168, NVDA 0xd0601CE1…9EEC, oracle 0xC5b8A6C5…031a, irm 0x2BD3d596…0fa1, lltv 625000000000000000)`.

Simulated path, 1 NVDA supplied, both markets: every step succeeded. Gas on
`0x6630`: supply 91 587, borrow 152 859, repay 74 061, withdraw 134 741.

| Control | Must | Did |
|---|---|---|
| A. borrow 200 USDG on ~223 USDG of collateral, above LLTV | revert | `insufficient collateral` |
| B. borrow with no collateral | revert | `insufficient collateral` |
| C. a stranger liquidates the healthy position | revert | `position is healthy` |
| D. supply collateral without approval | revert | `transferFrom reverted` |

Control D also closes the question [go-no-go-stock-tokens.md](./go-no-go-stock-tokens.md)
raised for swaps: the Stock Token's transfer into Morpho is gated by the
ordinary allowance and by nothing else. No compliance hook refused a fresh
wallet as the sender, nor Morpho as the receiver.

### Liquidation

- **Who:** anyone. Morpho Blue liquidation is permissionless once a position's
  LTV exceeds the market's LLTV; control C shows it refuses before that.
- **Bonus:** Morpho's liquidation incentive factor is
  `min(1.15, 1 / (0.3 × LLTV + 0.7))`. At 62.5% that is 1.1268: **a liquidator
  receives 12.68% more collateral than the debt it repays**, taken from the
  borrower.
- **Which price:** the market's oracle, `0xC5b8…031a`, which reads the Chainlink
  feed with **no staleness check of its own**. Morpho accepts whatever it returns.
- **Immutability:** a Morpho market's parameters, oracle included, cannot be
  changed after creation. Morpho's owner (`0x060595638692de6CCd47ca04094F1772D3D39728`)
  can only enable new IRMs and LLTVs and set a fee on interest, which is 0 today.

---

## Verdict: GO, for market `0x6630…dc` only, with six conditions

1. **One market.** Morpho Blue plus market `0x66306c08…edc` is the entire
   lending allowlist. Market `0x8b16…3e` is excluded for the reason given above,
   whatever its liquidity. A different market is a new reviewed commit.
2. **ARCANA checks the price before Morpho does.** The oracle accepts a stale
   feed, so before any borrow the agent-side guard must refuse when NVDA's
   `updatedAt` is older than its 86 400 s heartbeat, when USDG's is, or when
   `NVDA.oraclePaused()` is `true`. Robinhood's documentation says of that flag
   that it is "advisory and not enforced on-chain"; so it has to be enforced here.
3. **The weekend is the risk, not the weekday.** The NVDA feed runs 24/5. From
   Friday's close to Monday's open, Morpho prices the collateral at the last
   print while the token keeps trading on Uniswap. A position cannot be
   liquidated on a move the oracle has not seen, and then is liquidated all at
   once at Monday's open, with a 12.68% bonus on top of the gap. The health
   factor ARCANA acts on must use the **worse** of the oracle price and the pool
   price, and the beta's LTV ceiling must leave room for a weekend gap — far
   below 62.5%.
4. **No sequencer uptime feed exists** on this chain in Chainlink's directory,
   although Robinhood's documentation tells integrators to check one. Until one
   is listed, a pool/oracle divergence beyond a set band is the only available
   signal that the chain's view of the price has stopped, and it must stop new
   borrowing.
5. **Liquidity can leave.** 6 161.57 USDG is available today, and suppliers can
   withdraw it at any time. A borrow can therefore be refused by the market for
   reasons unrelated to the agent, and must be handled as a refusal. Repayment
   and collateral withdrawal do not depend on it.
6. **A per-agent borrow cap the mandate cannot raise**, as §17.6 already
   requires, sized against this market's available liquidity and not the larger
   one's.

## What was not tested

- A real transaction. Everything above is `eth_call`/`eth_simulateV1`; a
  broadcast with real funds is a day-6 exit criterion, not a day-4 one.
- Liquidation from the liquidator's side, since forcing an unhealthy position
  needs a price override. Control C proves the refusal; the incentive figure is
  Morpho's published formula, not a measurement.
- Interest accrual over time. The simulations run inside one block.
- The ARCANA signer. It has not learned any of these shapes. That is day 5.

The probe scripts are not in this repository — they are throwaway read-only
code whose results are recorded here, with the addresses and the block, so the
reads can be repeated by anyone with an RPC endpoint.

Sources: [Morpho addresses](https://docs.morpho.org/get-started/resources/addresses/),
[Chainlink — Robinhood tokenized equity feeds](https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood),
Chainlink feed directory `feeds-robinhood-mainnet.json`,
[Robinhood Chain — oracles and price feeds](https://docs.robinhood.com/chain/oracles-and-price-feeds/).
