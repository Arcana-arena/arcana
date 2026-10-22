# LP Execution — from a proposal to money

The LP registry loop (`services/arbitrage`, migration 0065) ends at a
**proposal**: `lp_position_actions.status='proposed'` carries the exact numbers a
position needs — a fresh range for a rebalance, or collect+burn for an empty
position. `arcana-lpexec` is the executor that acts on it.

**Status 2026-10-22: LIVE — ONE REAL POSITION OPEN AND MANAGED.** The first
position on the real chain was opened through the capped path:
**tokenId 1482899**, QQQ/USDG 0.05%, ticks [210090, 211100], **$18.00**,
agent `JohndoeAgent` (its creator switched arbitrage on for it, and the switch
records which wallet did so). Transaction
`0xeb96eef1670f8635dbaa74185b0bb5774d7f85a4798e7c5cb42c7119eef1612b`; the
next registry pass discovered it, read it back equal to the chain's own
`positions()` (liquidity `13503122875284`), found it **in range**, and holds it
at `hold` with a `$0.50` harvest threshold. The whole open — two approvals and
the mint — cost **0.0000131 ETH** of the agent's own gas (the chain's base fee
is ~0.02 gwei; `eth_gasPrice` suggests 20). It is recorded in `lp_opens`, and
the position is visible at `/arbitrage` and on the agent's Arbitrage tab.

**Before that, the same path was proven on an anvil fork** — the real
NonfungiblePositionManager, the real USDG and Stock Token — with the real signer
binary: open through the signer, discovery by the loop, rebalance (two
approvals, `decrease`, `collect`, `burn`, `mint`), harvest (a real swap's fees
proposed at the exact accrual and paid to the wallet to the base unit), and
close (`collect`, `burn`). Every transaction mined, every step recorded, the
chain checked afterwards, and the opt-in gate exercised in both directions.
**72/72 checks** (`infra/verify/lpexec-anvil-e2e.sh`). The production unit
carries `LP_EXECUTE=1`; it acts only on what the loop proposes, and the loop
proposes only for agents their creator has switched arbitrage on.

## Opening a position — the one action the loop cannot propose

The loop only observes positions that exist. The first position (and any new
allocation) is created through `lpexec --open`:

```bash
# LP_EXECUTE=1 arms it; LP_MAX_OPEN_USD is the owner's ceiling for this act and
# is REQUIRED — an unset cap is a refusal, not an unlimited one.
LP_EXECUTE=1 LP_MAX_OPEN_USD=100 lpexec --open \
  --agent <agent-uuid> --symbol NVDA --size-usd 50 --range-pct 0.05
```

It fetches the reviewed plan from `GET /v1/arbitrage/lp/plan`, checks the
wallet holds both legs, derives approvals to the position manager (only when
the allowance is short), signs `lp_mint` through the signer, broadcasts, reads
the receipt, extracts the new tokenId from the ERC-721 Transfer log, and
records the act in `lp_opens` (migration 0068) — agent, plan, size, tokenId,
transaction. The registry then discovers the position through the loop's own
Transfer-log discovery within one `LP_SYNC_INTERVAL`; nothing else writes
`lp_positions`.

## The intent sequence, and why this order

For `rebalance` (out of range, liquidity > 0):

1. `approve` — only when the wallet's allowance to the position manager is
   short, and only for the plan's desired amounts. Derived at EXECUTION time
   (the planner cannot see allowances) and placed FIRST, because a refusal on
   an approval must not leave a position already decreased and burned with no
   re-mint.
2. `lp_decrease` — the WHOLE liquidity, floors computed from the position's
   current amounts discounted by the proposal's own slippage.
3. `lp_collect` — **after** the decrease, and this is the correction that the
   contract forced: `decreaseLiquidity` credits the removed principal and the
   fees accrued up to that block to `tokensOwed`, and the position manager's
   `burn` refuses while `tokensOwed` is non-zero (`'Not cleared'`). The
   natural-looking order (collect → decrease → burn) reverts every time.
4. `lp_burn` — legal only with liquidity 0 and `tokensOwed` 0, i.e. only after
   both.
5. `lp_mint` — the fresh range from the proposal's plan.

For `empty` (liquidity == 0): `lp_collect` → `lp_burn`.

For `harvest` (in range, exact accrual ≥ `lp_harvest_min_usd`): one
`lp_collect` — no approvals, no deadline, no mint. This is the recurring action
that realizes the fee income; without it, fees would only be collected when the
price happened to leave the range, which is a schedule set by the market rather
than by the business. The proposal carries the exact accrual it was built on,
and the planner refuses one whose numbers are zero or missing (someone already
collected).

**The deadline is not optional.** The signer defaults `deadline` to 0, and the
position manager reverts a mint or a decrease whose deadline has passed — 0 has
always passed. The executor stamps now + 15 minutes into the bodies it signs.

## The armed run

`LP_EXECUTE=1` (the unit sets it). Everything else is the same binary:

1. reads the queue from the arbitrage service (the service that owns the
   tables stays the only writer of observations);
2. re-checks each proposal against the chain (owner, in-range, liquidity,
   plan, slippage, amounts) and refuses anything it cannot ground;
3. **claims** the action atomically (`UPDATE … WHERE status='proposed'` — the
   overlap protection: two runners cannot both act);
4. derives the approvals the mint needs right now;
5. for each intent, in order: reads the nonce, checks the gas reserve
   (`maxFee × gasLimit × 2`), signs through the signer, broadcasts, records the
   hash, waits for the receipt, records the verdict;
6. finishes the action `executed` or `failed` with the first reason.

**The rules are the money path's rules.** The receipt is the answer, not the
broadcast. A transaction that cannot be confirmed is `unresolved` — recorded
with its hash, never retried or replaced. The sequence stops at the first
failure. `ARCANA_VERIFICATION` is refused inside the binary (the same guard the
pacer and the guard carry), so a suite cannot drive it into spending.

## What is recorded

Migration 0066: `lp_position_actions` gains `executing`/`executed`/`failed`,
`started_at`, `finished_at`, `error`; `lp_execution_steps` holds one upserted
row per intent — written at broadcast with the hash, updated when the receipt
answers. "What did this proposal cause" is a query, and a crash between
broadcast and receipt leaves the hash, not a lost transaction.

## Proved before armed — the anvil fork run

`infra/verify/lpexec-anvil-e2e.sh` forks the live chain, funds a throwaway
agent wallet from the real pool (impersonated on the fork), mints an
out-of-range position with **exactly** the allowance that mint consumes (so the
executor's own approval path has to run), writes the registry row and the
proposed action in the loop's shapes, and then:

- the OPT-IN GATE, from both sides, while the creator has not switched arbitrage
  on: the armed run refuses that action (and says why), signs nothing and leaves
  the agent wallet's nonce unmoved; the next pass reads the chain, computes
  `rebalance`, and supersedes the standing proposal instead of leaving it;
- the creator switches it on through the machine-tier endpoint (the same call
  without the key is refused), and the very next pass proposes a fresh
  rebalance — so the enabled path is proven on the same fork, not assumed;
- PLAN mode prints four intents in the contract's order;
- EXECUTE mode sends six transactions — two approvals, decrease, collect, burn,
  mint — all `0x1`;
- the database says `executed`, six mined steps, timestamps set;
- the chain says the old NFT is gone, the new one is owned by the agent, has
  liquidity, and the current tick is inside the new range;
- a second armed run finds nothing to execute and sends nothing.

**72/72 checks.** Nothing there touched the production database or the live
chain's state.

## Funding — what remains is the owner's, and the order matters

The executor is armed, so **the first funded position will be managed
automatically**. Sequence the funding accordingly:

0. **Custody (owner, blocking for real money).** Option B live: KMS key
   created, seed sealed, `SIGNER_SEED_SOURCE=kms`, signer ACTIVE on the sealed
   seed, sealed blob in two physically separate places, plaintext seed
   shredded. Evidence: `signer-kms-verify` 21/0,
   `signer-isolation-verify` 15/15, `arcana-seed-restore-test.sh` PASS against
   the KMS-loaded signer. See [signer.md](./signer.md).
1. **The first real position (owner-approved amount).** Fund one agent wallet
   with the approved USDG plus gas, then open through the tool above with that
   amount as the size and as `LP_MAX_OPEN_USD` — the same signer intent the
   executor uses, with a cap that had to be typed. From the moment the registry
   discovers the position (≤ 5 minutes), the executor owns its management for
   as long as it is funded.
2. **Watch it.** The registry syncs every 5 minutes; an out-of-range position
   produces a proposal within one sync and the executor acts on it within the
   next timer tick. `lp_execution_steps` is the audit trail; the signer's daily
   cap and its own chain checks remain the last door.
3. **Scale-up (owner).** Only after a full cycle (rebalance or close) on the
   real chain reconciles against the chain.

## Stop conditions

Any of these ends the run; none is a reason to retry with a bigger number:

- the signer refuses an intent (`ownerOf`, liquidity, allowlist, paused token,
  daily cap) — the run records the reason and stops;
- a broadcast transaction is `unresolved` — do not replace it; read the hash;
- the native balance is below the gas reserve — nothing is signed;
- the position owner on chain is not the agent's wallet.

## Boundaries that did not move

- The registry loop remains the only writer of observations; the executor
  writes only the execution lifecycle.
- The signer remains the only key holder; the executor never sees key material
  or builds calldata — it sends named intents.
- No §7 core table is involved; the new tables are the feature's own.
