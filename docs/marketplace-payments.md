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

## Decimals are read from the token, not configured

There was an `ARCA_TOKEN_DECIMALS`, defaulting to **18** with a comment calling
it a documented assumption. USDG, the token this chain settles in, uses **6**.
An assumption wrong by twelve orders of magnitude does not error — it compares
two numbers and returns a confident answer about money.

It is not an assumption at all. `decimals()` is a view function on the token,
so whatever token is configured, **the chain will say**. It is read at the
moment it is needed, cached for the process (decimals is immutable for any
ERC-20 worth accepting — set at construction, no setter in the standard), and
there is deliberately **no fallback**: a token that cannot be asked is a token
that cannot be verified against, which is check 6's
`payment_verification_unavailable`, not a guess.

This narrows the blocker to the one thing genuinely unknown. The scale of $ARCA
was never unknowable — only unasked, because the token does not exist yet to
ask. The instant it does, nobody has to remember to go and check.

## The marketplace settles in USDG

**Changed 2026-09-11, and it is what made the marketplace usable.** It had been
waiting on a $ARCA launch it did not need.

USDG exists on chain today. More to the point, **the verification described in
this document was already driven against real USDG transfers** — the suite
finds a transfer somebody else made, for their own reasons, and checks against
it. So switching to USDG required re-proving nothing: the payment path was
already proven against exactly this token rather than against a stand-in for
one that did not exist.

| | Variable | Token | State |
|---|---|---|---|
| **Payment** | `MARKETPLACE_PAYMENT_TOKEN` | USDG `0x5fc5360D…d168` | live |
| **Gating** | `ARCA_TOKEN_ADDRESS` | $ARCA | unlaunched, and no longer blocking |

### Why two variables and not one

They were one variable while both were $ARCA. One variable is how they get
swapped by accident — a day comes when somebody sets it for one purpose and
silently changes the other. Holding USDG would then satisfy a $ARCA gate, or a
listing would be priced in a token nobody can pay in. **Neither would throw.**

So the reader takes its address as a constructor argument and is registered
twice, under two names, from two variables. Nothing reads a token address from
the environment except those two providers, and `claims-verify` asserts that —
a third source appearing later is caught by a suite rather than by an incident.

DI tokens rather than subclasses, deliberately: a subclass would let a consumer
asking for the base type receive either one, which is the exact confusion this
split exists to prevent.

Decimals are still read from `decimals()` per token, with **no fallback**. That
is what makes the switch safe at all: USDG uses 6, $ARCA will use whatever it
uses, and neither number is written down anywhere to be got wrong. `symbol()`
is still never consulted.

## Before this can take real money

**Nothing, on the token side.** This list used to be `ARCA_TOKEN_ADDRESS`, and
that entry is gone: the marketplace settles in a token that exists.

What remains is operational rather than a blocker — see "What is left before
real users" below.

The §10 subsystem that used to appear here as item 3 was **retired on
2026-09-11**: `HdWalletService`, `DepositAddressesService`,
`PaymentListenerService`, their three entities, the deposit-address route, both
listener routes, and the marketplace `subscribe` route that called them. They
were held through phase 4a because their replacement was not proven. This
document is that proof, and the order was the point.

## What is left before real users

The marketplace is the first feature that can go live **without waiting on
anything from the owner**. That is a real claim, so here is everything that is
actually still between it and a stranger using it — stated as findings, not as
a plan.

### Blocking, and inside our control

1. **Two creators have no `wallet_address`** (2 of 51). A listing whose creator
   has no wallet refuses every claim with `creator_has_no_wallet`, which is the
   correct refusal — there is no address to verify a payment against — but it
   is a listing that can never be bought. The creators need a wallet, or their
   listings need deactivating. **Refusing correctly is not the same as working.**

2. **A buyer has no way to learn the creator's address.** The claim path
   verifies a payment to the creator's wallet, and nothing in the API tells a
   buyer what that address is. Today the answer would have to come from outside
   the platform, which is exactly the sort of gap that gets filled by somebody
   pasting an address into a chat window — and that is how payment redirection
   attacks work. A listing needs to state its own payee, from the same row the
   verification reads, so the two cannot disagree.

3. **A buyer has no way to learn the price in the token they will pay in.**
   `arca_gate_amount` is a NUMERIC and the claim converts it with the token's
   decimals. A listing should say "12.500000 USDG", from the same conversion
   the check uses, rather than leaving a client to do that arithmetic — two
   implementations of a price conversion is how somebody underpays by a factor
   of a million and is told `insufficient_amount`.

### Not blocking, but they will be asked about

4. **A confirmed payment is invisible until claimed.** The buyer pays, then
   submits the hash. If they close the tab in between, nothing anywhere knows
   the payment happened, and the 24-hour freshness window is running. That is
   survivable — the money is theirs, on chain, and the claim still works within
   the window — but the failure is silent and the remedy is a support message.

5. **A refunded or mistaken payment has no path.** ARCANA never held the money,
   so there is nothing to refund; the buyer and creator must settle it between
   themselves. That is a consequence of the fee-free P2P design and it is the
   right trade, but it should be stated to a buyer before they pay rather than
   discovered after.

### Deliberately not blocking

- **A frontend.** Not started, and not started here on purpose.
- **$ARCA.** It gates entitlements — CREATE, COMPETE, EVOLVE, PREMIUM ARENA —
  and no longer touches payment. Every gate currently admits everyone and says
  so in its response rather than passing silently.
- **KMS, the seed, and the $10 swap.** All three are about the *trading*
  wallets ([signer.md](./signer.md)). The marketplace holds no key and moves no
  money: the buyer pays the creator directly and ARCANA reads the chain.

The first three are ordinary product work with no external dependency. Nothing
on this list needs a credential, an approval, or a launch.
