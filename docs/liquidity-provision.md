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

## Phased build (real money → checkpoints)

Status 2026-10-18:

1. **Paper LP simulator — DONE.** Measured realized fee APR 30.7% on the
   USDG/WETH 0.01% pool from on-chain `feeGrowthGlobal` deltas, over a live
   10-minute window.
2. **Signer `mint` shape — DONE (built, tested, dry-run, deployed 2026-10-19).**
   `lp_mint` builds
   `NonfungiblePositionManager.mint`; the NPM is allowlisted after its bytecode
   was checked for selector `0x88316456`; the calldata was `eth_call`ed against
   the live NPM and reached `transferFrom` ("STF"), proving the ABI and the
   int24 tick encoding. Deployed: the running signer's `/healthz` reports the
   commit, `signer-verify` passes 62/62, and live probes refuse as designed.
3. **LP planner — DONE.** `services/arbitrage/internal/lp` implements the
   Uniswap v3 tick/liquidity/amount math (unit-tested) and turns a live pool
   into a concrete `lp_mint` plan (range snapped to tick spacing, both legs
   sized for a target USD value). Live endpoint:
   `GET /v1/arbitrage/lp/plan?symbol=NVDA&size_usd=500&range_pct=0.05`.
4. **Position reader — DONE (read-only).** `GET /v1/arbitrage/lp/position?token_id=`
   reads `positions(tokenId)` from the NPM, resolves the pool through the
   factory, reads the current tick, and reports owner, ticks, liquidity, stored
   `tokensOwed`, current token amounts, `in_range`, and a recommendation
   (`hold` / `rebalance` / `empty`). Verified against a live position.
   **Exact fee accrual — DONE (2026-10-19).** The reader also recomputes
   `feeGrowthInside` the same way the contract does at `collect()` time (the
   pool's `feeGrowthGlobal` counters, both boundary ticks' `feeGrowthOutside`,
   and the position's stored `feeGrowthInsideLastX128`, with the modulo-2^256
   subtraction the contract performs unchecked) and reports `fees_owed0/1`
   next to the stored `tokens_owed0/1`, which are only a stale lower bound.
   Verified against the chain's OWN answer: for a live position found by the
   verify suite, `fees_owed` equals a simulated `collect(max,max)` from the
   owner, exactly, token by token.
5. **Signer management shapes — DONE (built, tested, dry-run, deployed
   2026-10-19).** `lp_collect`,
   `lp_decrease` and `lp_burn` join `lp_mint`. Every one first reads `ownerOf`
   from the chain and refuses a position the agent does not own; `lp_collect`
   forces the recipient to the agent's wallet; `lp_decrease` refuses liquidity
   above the position's; `lp_burn` refuses while liquidity remains. Selectors
   `fc6f7865` / `0c49ccbe` / `42966c68` were confirmed in the NPM bytecode, and
   all three were `eth_call`ed live — `collect` and `burn` succeeded on an empty
   position, and `decreaseLiquidity(1)` succeeded on a live position with
   liquidity. Deployed: live probes on the running signer return
   `position_manager_not_allowlisted` (unallowlisted PM) and
   `chain_state_unverifiable` with the exact ERC721 revert (nonexistent
   tokenId) — refusals driven by the new shapes, never `unknown_intent`.
   **Registry and loop — DONE (read-only), 2026-10-19.** Migration 0065 adds
   `lp_positions`, `lp_position_actions` and `lp_sync_heartbeat`. The loop
   discovers position NFTs from recipient-filtered Transfer logs (90k-block
   windows, cursor in the heartbeat so a failed window is re-read), re-reads
   `ownerOf`/`positions` every pass rather than remembering them, and writes a
   `proposed` action for an out-of-range or empty position with the exact
   numbers: a fresh ±5% range (`lp_rebalance_range_pct`) sized for the
   position's current value with a 0.5% slippage floor, or collect+burn.
   **Nothing executes a proposal** — this service cannot sign, and the verify
   suite checks the signer's journal for zero `lp_*` signings.
   **Harvest — DONE (2026-10-20).** The loop computes the exact accrual on
   every sync (the same `feeGrowthInside` `collect()` uses) and, when it
   crosses `lp_harvest_min_usd` (reviewed default $0.50 — about dust, not gas),
   proposes `harvest`; the executor turns it into one `lp_collect`. A fill in
   the proposal is not trusted blindly: an unreadable accrual is recorded as an
   error and the proposal bookkeeping is skipped for that pass. Migration 0067
   widens the recommendation constraint.
   **Executor — DONE, ARMED, PROVEN (2026-10-20).** `arcana-lpexec`
   (`services/decision-engine/cmd/lpexec`) reads the proposal queue, re-checks
   each proposal against the chain, and — with `LP_EXECUTE=1`, which the unit
   sets — claims it, derives the approvals, signs each intent through the
   signer, broadcasts, waits for each receipt and records every step
   (`lp_execution_steps`, migration 0066). The sequence is the contract's:
   `approve` (only when short) → `lp_decrease` → `lp_collect` → `lp_burn` →
   `lp_mint` for a rebalance (the collect MUST follow the decrease: burn
   refuses while `tokensOwed` is non-zero, and the decrease is what credits
   it), `lp_collect` → `lp_burn` for a close. Note the signer parses `amount`
   before the intent switch (bodies send `amount: "0"`), and its default
   `deadline` of 0 would be rejected by the position manager, so the executor
   stamps one. **Proven end to end on an anvil fork of the real chain** — real
   NPM, real USDG, a real position, six mined transactions, chain state
   verified afterwards (31/31, `infra/verify/lpexec-anvil-e2e.sh`). It is
   inert until an agent owns a position; the funding runbook and the remaining
   owner acts (custody, amount) are in
   [lp-execution.md](./lp-execution.md). Exact live fee accrual is READABLE
   (`fees_owed0/1` on `/lp/position`, verified against `collect()`); the
   registry still records stored `tokensOwed`, so persisting exact fees per
   sync would be a deliberate schema addition, not a drive-by.
6. **Small real position — NOT STARTED (owner-funded).** A capped,
   owner-approved deposit, watched end-to-end before any scale-up. The open
   path is built and proven: `lpexec --open --agent … --symbol … --size-usd …
   --range-pct …` with `LP_MAX_OPEN_USD` as the typed ceiling, recording the
   act in `lp_opens` (migration 0068); the registry discovers the position
   within one sync and the executor manages it from then on.
