# LP Execution — from a proposal to money

The LP registry loop (`services/arbitrage`, migration 0065) ends at a
**proposal**: `lp_position_actions.status='proposed'` carries the exact numbers a
position needs — a fresh range for a rebalance, or collect+burn for an empty
position. `arcana-lpexec` is the executor that acts on it.

**Status 2026-10-20: BUILT, PROVEN, AND ARMED.** The armed path ran end to end
on an **anvil fork of Robinhood Chain** — the real NonfungiblePositionManager,
the real USDG and Stock Token, a real position minted on the fork — with the
real signer binary: two approvals, `decrease`, `collect`, `burn`, `mint`, six
transactions all mined, the action recorded as executed, the old NFT gone and
the new one owned by the agent and in range. 31/31 checks
(`infra/verify/lpexec-anvil-e2e.sh`). The production unit carries
`LP_EXECUTE=1`; it is **inert until a proposal exists**, and none can exist
until an agent owns a position (i.e. until funding).

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

- PLAN mode prints four intents in the contract's order;
- EXECUTE mode sends six transactions — two approvals, decrease, collect, burn,
  mint — all `0x1`;
- the database says `executed`, six mined steps, timestamps set;
- the chain says the old NFT is gone, the new one is owned by the agent, has
  liquidity, and the current tick is inside the new range;
- a second armed run finds nothing to execute and sends nothing.

Nothing there touched the production database or the live chain's state.

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
   with the approved USDG plus gas, then mint with a reviewed plan from
   `GET /v1/arbitrage/lp/plan` — the same intent the executor sends. From the
   moment the registry discovers the position (≤ 5 minutes), the executor owns
   its management for as long as it is funded.
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
