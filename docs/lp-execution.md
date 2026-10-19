# LP Execution — from a proposal to money, in checkpoints

The LP registry loop (`services/arbitrage`, migration 0065) ends at a
**proposal**: `lp_position_actions.status='proposed'` carries the exact numbers a
position needs — a fresh range for a rebalance, or collect+burn for an empty
position. Everything after that is the execution path, and it moves real funds,
so it is built and armed in order.

**Status 2026-10-19: phase A built and live.** `arcana-lpexec` (source
`services/decision-engine/cmd/lpexec`) reads the queue over HTTP, re-checks each
proposal against the chain, and prints the complete signer request bodies it
would send — then stops. It calls no signer, broadcasts nothing, writes nothing,
and holds no credential (all three reads are public read-only routes). Verified
by `infra/verify/lpexec-verify.mjs` and by Go unit tests
(`internal/execution/lp_plan_test.go`) that pin the assembly and the refusals
field by field.

## The intent sequence, and why this order

For `rebalance` (out of range, liquidity > 0):

1. `lp_collect` — fees out first, before anything touches the liquidity.
2. `lp_decrease` — the WHOLE liquidity, with floors computed from the position's
   current amounts discounted by the proposal's own slippage.
3. `lp_burn` — the signer refuses while liquidity remains, so it can only follow
   a mined decrease.
4. `lp_mint` — the fresh range from the proposal's plan.

For `empty` (liquidity == 0): `lp_collect` → `lp_burn`.

As separate signed transactions, each step depends on its predecessor being
mined. The signer's own checks (`ownerOf`, liquidity-over-position,
position-not-empty, min ≤ desired) make a wrong or replayed order fail safe
rather than half-execute.

**The deadline is not optional.** The signer defaults `deadline` to 0, and the
position manager reverts a mint or a decrease whose deadline has passed — 0 has
always passed. The planner stamps now + 15 minutes into the bodies it prints,
and the armed executor recomputes it immediately before signing; a queue entry
must never carry a deadline that expired while it waited.

## What the planner refuses, and why that matters

- position owner (chain) ≠ the wallet the registry attributes to the action's
  agent — with both addresses printed;
- `rebalance` while the price is back inside the position's own range (the
  verdict no longer holds);
- `empty` with liquidity, or `rebalance` with none (the verdict contradicts the
  chain);
- a proposal with no mint plan, no usable slippage, an inverted range, or
  unparseable amounts;
- a position the chain cannot be read for (`no_pool`, `position_unreadable`) —
  a plan assembled from guessed state is worse than no plan.

All of these are also re-checked by the signer from the chain at signature
time. The planner's refusals exist so drift becomes a log line with a reason,
not a refused signature nobody can explain.

## The funding checkpoint (not yet done)

Nothing below is armed. Each step has an evidence gate; do not start the next
until the previous is green, and do not compress them — this is the part that
spends.

0. **Custody (owner, blocking).** Option B live: KMS key created, seed sealed,
   `SIGNER_SEED_SOURCE=kms`, signer ACTIVE on the sealed seed, and the sealed
   blob in two physically separate places. Evidence:
   `signer-kms-verify` 21/0, `signer-isolation-verify` 15/15,
   `arcana-seed-restore-test.sh` PASS against the KMS-loaded signer, journal
   shows option B, and the old plaintext seed shredded. See
   [signer.md](./signer.md#option-b-prepared-and-dormant-2026-10-19).
1. **The first real position (owner-approved amount).** Fund one agent wallet
   with the approved USDG plus gas, then mint through the signer's `lp_mint`
   using a reviewed plan from `GET /v1/arbitrage/lp/plan` — the same intent the
   executor will send; it is signed and broadcast by hand at this stage.
   Evidence: receipt status `0x1`; `GET /v1/arbitrage/lp/position?token_id=`
   shows the position owned by the agent's wallet; the registry discovers it
   within one `LP_SYNC_INTERVAL` (≤ 5 minutes).
2. **Watch the loop against it.** Recommendations stay `hold` while in range;
   when the price leaves the range a `proposed` action appears carrying the
   exact numbers. Evidence: `GET /v1/arbitrage/lp/actions` shows the proposal
   and `arcana-lpexec` logs `would send 4 intent(s) in order: …` with the
   bodies reviewed by the owner.
3. **Arm (checkpoint — requires explicit approval).** Wire the executor to the
   signer and the existing broker, keeping every guard the rest of the money
   path has: an `ARCANA_VERIFICATION` refusal in the binary (the guard `pace`
   and `guard` already carry), the per-wallet lease, the signer's daily cap and
   chain checks, receipts read from the chain, `unresolved` as a first-class
   state, and no retries of a broadcast transaction. Schema: proposals gain
   `executing`/`executed`/`failed` and an LP execution record — a migration,
   deliberately, at this checkpoint.
4. **Scale-up (owner).** Only after the first position has been rebalanced (or
   closed) end to end and its records reconcile against the chain.

## Stop conditions

Any of these ends the run; none is a reason to retry with a bigger number:

- the signer refuses an intent (`ownerOf`, liquidity, allowlist, paused token,
  daily cap) — the reason is recorded and the run stops;
- a broadcast transaction is `unresolved` — do not replace it;
- the position's current amounts cannot be read, so the decrease floors cannot
  be computed (the planner already refuses this);
- the position owner on chain is not the agent's wallet.

## What this phase deliberately does not do

- It does not call the signer, and no flag exists that makes it. Arming is a
  code change with its own review, not an environment variable.
- It writes nothing: no execution rows, no status transitions. Phase A is a
  reader; the queue keeps its single writer (the arbitrage loop).
- It does not retry, re-plan or "fix" a proposal. A refusal is the answer.
