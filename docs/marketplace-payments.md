# Marketplace Payments

The buyer pays the creator directly and submits a transaction hash. ARCANA
verifies it against the chain and grants access. No deposit address, no
treasury, no split, no contract.

Implemented in `services/arca-service/src/payments/claims.service.ts`.
Verified by `infra/verify/claims-verify.mjs` (45 checks, against real
transactions, in the token production actually settles in).

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

**45 checks. No money was spent.**

The verifier is pointed at **USDG — the token the marketplace actually settles
in** — and driven with a **real transaction that somebody else made, for their
own reasons**. Until 2026-09-11 this was an analogy: USDG stood in for a $ARCA
that did not exist. It is not an analogy any more; the suite and production
point at the same contract. The suite finds one in the live block window and
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
## The listing states its own payee and price

`GET /v1/marketplace/listings/:id/quote` — **public**, because a buyer needs
both before signing in and neither is secret: the address is public on chain,
the price is public on the listing.

```json
{
  "pay_to": "0x…",
  "token": "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  "amount": "12.50000000",
  "amount_base_units": "12500000",
  "decimals": 6,
  "claim_within_hours": 24,
  "min_confirmations": 600,
  "warning": "You are paying the creator DIRECTLY. ARCANA never receives this money…"
}
```

### The hole this closes

Until this existed, **nothing in the API told a buyer which address to send
to**, so the answer came from outside the platform — a chat message, a
screenshot, a website. Anyone who could substitute an address in that path took
the money, and ARCANA's verification then refused their claim **correctly, and
too late**.

A refusal that arrives after the loss is not a defence.

### One source, and it is checked as one

`pay_to` and `amount_base_units` come from `resolvePayable()` and
`requiredBaseUnits()` — **the same calls `claim()` makes**, not a parallel
query that agrees today. Marketplace proxies and computes nothing: not the
address, not the amount, not the decimals. A "helpful" format in the proxy
would be a second implementation wearing a different hat.

`claims-verify` proves this **in the source**, not by comparing two outputs:
exactly one `creatorWalletFor`, exactly one `baseUnits`, and both paths
demonstrably routed through them. Comparing outputs would pass on every day
they still agreed — which is every day until the one that matters.

It also proves it end to end: the quote is taken **before** the claim, and the
very same real transfer is then accepted. So the address a buyer would have
been told is provably the address the accepted payment went to.

## A listing with no payee cannot be published

One creator had no `wallet_address` and an active listing. Every claim against
it refused with `creator_has_no_wallet` — **the correct refusal, and a listing
nobody could ever buy**. Refusing correctly is not the same as working.

`create()` now asserts the creator is payable, and so does reactivating through
`PATCH`: a guard one `PATCH` can walk around is a formality.

The check asks arca-service's `isPayable()`, which answers from
`creatorWalletFor()` — the same lookup the verification uses. A local query
against `creators` would have been a second definition of "can this be paid
for".

**It refuses only on `creator_has_no_wallet`.** An unreachable arca-service or
a missing internal key logs and publishes anyway. Making publication depend on
another service being up is a worse property than a listing that has to be
fixed later, and the claim path still refuses correctly regardless.

## The payment you made but never claimed

`GET /v1/marketplace/listings/:id/unclaimed-payments` — session required.

Somebody pays, closes the tab before submitting the hash, and the money looks
lost while the 24-hour window runs. This finds it.

**It grants nothing**, which is why it opens no new surface. It returns
candidate hashes for transfers whose **sender is the caller's own proven
wallet** and whose recipient is this listing's creator; claiming one still goes
through every check unchanged. It reveals transactions involving the caller's
own wallet — which they can already see — and the creator's address, which the
quote now states anyway. Already-claimed hashes are excluded rather than
offered and then refused: offering a hash that cannot work is worse than not
finding it, because the buyer acts on it.

### The scan is bounded, and says so

The freshness window is 24 hours — **864,000 blocks** at 0.100 s/block.
Scanning that per request is not something to do to a node somebody else pays
for. So it looks back about **thirty minutes**, reports how far it looked, and
tells the buyer that an older payment is still claimable from their own wallet
history — rather than returning an empty list that reads as *"no payment
found"*.

Filtered by the node through indexed topics, not pulled and filtered here.

## Refunds: there are none, and the buyer is told first

ARCANA never receives the payment, so there is nothing to refund. That is a
direct consequence of a fee-free P2P marketplace and it is the right trade.

What changed is **when** a buyer learns it. The warning is in the quote — the
one moment they can still decide — rather than in a document they read after
sending money to the wrong address.

## What is left before real users

**Nothing but a frontend.**

Every blocker that was in this section is closed:

| Was blocking | Now |
|---|---|
| creators without a wallet | listing refuses to publish; the one bad row is deactivated |
| buyer could not learn the payee | `GET …/quote`, from the row the check reads |
| buyer could not learn the price in the paid token | same quote, one conversion |
| a paid-but-unclaimed payment was invisible | `GET …/unclaimed-payments` |
| refunds not disclosed before payment | stated in the quote |

Not blocking, and deliberately not done here:

- **A frontend.** Not started, on instruction.
- **$ARCA.** Gates entitlements — CREATE, COMPETE, EVOLVE, PREMIUM ARENA — and
  no longer touches payment. Every gate admits everyone today and says so in
  its response rather than passing silently.
- **KMS, the seed, the $10 swap.** All about the *trading* wallets
  ([signer.md](./signer.md)). The marketplace holds no key and moves no money.
