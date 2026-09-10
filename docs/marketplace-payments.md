# Marketplace Payments

The buyer pays the creator directly and submits a transaction hash. ARCANA
verifies it against the chain and grants access. No deposit address, no
treasury, no split, no contract.

Implemented in `services/arca-service/src/payments/claims.service.ts`.
Verified by `infra/verify/claims-verify.mjs` (22 checks, against real
transactions).

Related: [on-chain-direction.md §g](./on-chain-direction.md#g-marketplace--tx-hash-confirmation),
migration 0027, architecture.md §10 (superseded).

---

## What inverted

Under §10 the deposit address was **ours**. A payment could only arrive
somewhere ARCANA controlled, and a stranger could not submit one — the address
was the proof.

Here there is no address we control, and **a transaction hash is public the
moment it is mined**. Two attacks follow, both free to mount, neither needing
any access to ARCANA:

- **claiming somebody else's payment** — watch the chain, see a transfer to a
  creator, submit it as your own
- **spending one payment on many listings** — pay once, claim everything that
  creator sells

Every check below exists because of one of those, or because of something the
chain can say that looks like a payment and is not.

## The checks, in order

Ordered so the cheapest and most decisive run first: a replay attempt costs an
index lookup, not three RPC round trips.

| # | Check | Refusal | Why it exists |
|---|---|---|---|
| 1 | Hash is `0x` + 64 hex | `malformed_tx_hash` | never reaches chain or database |
| 2 | **Not already claimed** | `tx_already_claimed` | the main attack; see below |
| 3 | Listing exists and is active | `listing_not_found` | |
| 4 | Listing has a price | `listing_has_no_price` | nothing to check an amount against |
| 5 | **Creator has a wallet on file** | `creator_has_no_wallet` | with no address, accepting would mean believing the claim instead of the chain |
| 6 | **Verification is possible at all** | `payment_verification_unavailable` | see "cannot check" below |
| 7 | Transaction exists | `tx_not_found` / `tx_pending` | a pending transaction is not a fraudulent one |
| 8 | **It succeeded** | `tx_reverted` | |
| 9 | Enough confirmations | `insufficient_confirmations` | |
| 10 | **Correct token, by address** | `no_matching_transfer` | |
| 11 | Recipient is the listing's creator | `no_matching_transfer` | |
| 12 | **Sender is the signed-in wallet** | `sender_is_not_claimant` | stops claiming someone else's payment |
| 13 | Amount is sufficient | `insufficient_amount` | |
| 14 | Payment is recent | `tx_too_old` | see "freshness" below |

Five of these were not on the original list and are called out because their
absence would each have been a hole:

**8 — did it succeed.** A reverted transaction has a hash, a receipt, a block
and a gas bill, and moved nothing. Without this check every later check passes
vacuously on the logs it does not have.

**7 — pending versus non-existent.** Both mean "no receipt". Collapsing them
tells a buyer whose transaction is thirty seconds old that their payment never
happened.

**5 and 4** — refusing when there is nothing to verify against, rather than
proceeding on a null.

**And the transfer is read from the LOGS**, not from the transaction's `to` and
`value`. An ERC-20 transfer moves no native value and its recipient is a
function argument, so reading the envelope would see a call to a contract with
a value of zero and learn nothing about who was paid.

### The token check never reads `symbol()`

The concern was a lookalike token — and the defence is not to inspect the name
carefully, it is to **never ask**. Matching is on the configured contract
address, which cannot be forged. `symbol()` is attacker-written text on a
permissionless chain; one token on this chain reports a symbol several thousand
characters long.

All matching transfers in a transaction are **summed**, not just the first: a
payer who splits the amount across two transfers in one transaction has paid.

## `UNIQUE (tx_hash)`, not `(tx_hash, listing_id)`

This is the whole anti-replay design in one constraint.

Keyed by the pair, one payment would buy **every listing a creator has ever
published**: same hash, different `listing_id`, a new row each time, every
insert succeeding. Keyed by the hash alone, the second claim collides whatever
it is claiming, and the database refuses it without the application having to
remember to ask.

§10's `payment_events.tx_hash UNIQUE` was tidiness — payments were matched to an
address ARCANA generated, so a stranger could not submit one. Here it is
load-bearing.

**The index check at step 2 is an optimisation, not the guard.** Two
simultaneous claims both pass it; the constraint settles it at insert. The
record is written *before* access is granted, so the loser of that race cannot
grant first and lose second. Proved by racing three concurrent claims of one
hash: exactly one succeeds, one row exists.

## Confirmations: 12 was wrong by two orders of magnitude

`ARCA_CONFIRMATIONS` defaulted to **12** — Ethereum's convention, where 12
blocks at ~12 seconds is about two and a half minutes.

**Robinhood Chain produces a block every 0.100 seconds.** Measured across 100,
1,000, 10,000 and 100,000 blocks, all four agreeing. So the same 12 means
**1.2 seconds** here: an identical number carrying roughly a hundred and
twenty-fifth of the protection, while looking like a considered choice.

`ARCA_CLAIM_MIN_CONFIRMATIONS` defaults to **600 — about 60 seconds**. Chosen in
wall-clock terms, because that is what a reorganisation happens in; the block
count is derived from it rather than the other way round. The service logs both
at boot so nobody has to redo the arithmetic to know what the setting means.

## Freshness, and why an unbounded window is a hole

Without an age limit, **any** historical transfer from a buyer to a creator
becomes a claim: a tip, an unrelated trade, last year's subscription. The buyer
genuinely sent that money to that creator, so every other check passes. Only
recency separates *"this payment was for this"* from *"these two people have
transacted before"*.

`ARCA_CLAIM_MAX_AGE_HOURS` defaults to **24**.

## When it cannot check

An unreadable chain is **not a rejection and not an acceptance**. The claim
comes back `503 payment_verification_unavailable`, saying plainly that nothing
about the transaction was judged.

Same shape as auth's `503 auth_unavailable` and the entitlement layer's
`enforced: null`. Rejecting would tell a buyer their good payment was bad;
accepting would grant access on no evidence. "Could not find out" is its own
answer and gets its own status code.

## The access flow did not change

`subscribe → grant → grace → expired → revoke` is untouched. What changed is
only **how the platform learns a payment happened**: the claim service calls the
same `SubscriptionsService.grant()` the payment listener called, and
`GET /v1/arca/access` remains the single source of truth for the access rule.

The access-flow suite is still 11/11, unchanged.

## Proof

```bash
node infra/verify/claims-verify.mjs
```

**22 checks. No money was spent.**

$ARCA has not launched, so the verifier is pointed at **USDG** — a real ERC-20
on the same chain — and driven with a **real transaction that somebody else
made, for their own reasons**. The suite finds one in the live block window and
uses it: the sender, the recipient, the amount and the block are all things
ARCANA had no hand in.

Only the conditions the chain will not supply on demand come from a controlled
RPC speaking the same protocol: a reverted receipt (the same transaction with
`status: 0x0`), an unmined one, and a node that is down.

## Before this can take real money

1. **`ARCA_TOKEN_ADDRESS`** — the token does not exist yet. Until it is set the
   claim path refuses with `payment_verification_unavailable`, which is correct.
2. **`ARCA_TOKEN_DECIMALS`** — currently a documented assumption of 18. USDG,
   the only comparable token on this chain, uses 6. Getting it wrong scales
   every price check by a trillion in one direction or the other. Verify against
   the real token before anyone can pay.
3. **The §10 subsystem is still standing**, deliberately. Six files were held in
   phase 4a because their replacement was not proven. It is now — retiring them
   is its own phase, which is the right order and the reason they were held.
