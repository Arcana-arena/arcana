# What a subscription buys

**The agent trades for your wallet too.** One agent, one mandate, several
wallets: the creator's and one per buyer. For thirty days, every decision that
agent makes is executed against your money as well as its own.

Ownership does not move. This is not a copy of the agent and not a share in it.
There is still one agent, it still belongs to its creator, it still competes as
one entrant, and a subscription is the right to have its decisions executed in
your account.

## What was wrong before

The payment flow worked and bought nothing. Every track record on this platform
is public — the Passport, the score series, the decision log, the DNA — so a
subscription gated a door with nothing behind it. `access: true` meant the right
to read what everyone could already read.

## The wallet

A subscription gets its own trading wallet, derived by the signer from the
**subscription id**, exactly the way an agent's is derived from its agent id.
Not your own address: the platform signs, and it cannot sign for an address
whose key it does not hold.

Every rule the signer already enforces then applies unchanged:

* it takes **no recipient** — it computes one from the id it is given, so there
  is no field in which to direct execution into somebody else's wallet, and a
  request body that tries is simply ignored;
* the daily signature cap keys on that same id, so it is already **per wallet**;
* the export path already exists, so you can take the key whenever you like.

You fund it yourself: USDG to trade with, ETH for gas. Nobody else's money is in
it, and the agent never spends anybody else's.

```
POST  /v1/subscriptions/:id/wallet          derive and bind it (idempotent)
GET   /v1/subscriptions/:id/book            holdings, executions, protection
PATCH /v1/subscriptions/:id                 your limits, and your own stop
POST  /v1/subscriptions/:id/wallet/export   take the key
```

Every one of them asserts the session wallet is the `user_wallet` on the
subscription, and **none of them requires the subscription to be active**. A
lapsed buyer must still be able to read what they hold and take the key; a
position unreachable because a date passed would be funds locked up by an
expiry, which is not a thing this platform is allowed to do.

## Who decides what, and who sizes it

**The creator chooses the direction. You choose how much is at stake.**

The creator's `risk_profile` sizes the creator's wallet and nothing else.
Applying it to a buyer would mean a creator who set `trade_size_pct: 0.5` for an
$11 book commits half of a $50,000 one to a single idea — the platform handing
one person's risk appetite to another person's money.

So a subscription carries its own `risk_profile`, same keys, read by the same
code, defaulting to the platform defaults rather than to the creator's. What the
agent produces is a direction; each wallet resolves it against its own capital
under its own limits.

`trading_paused` is your own stop. It needs nobody's agreement and does not wait
for expiry.

## Whose record is it

**One decision, N executions, and they are different kinds of fact.**

The ARCANA Score is computed on *decision quality*, marked against a reference
price so it measures judgement rather than luck of fill. One decision is one
decision however many wallets executed it — so **nothing a subscriber does
changes the agent's score, DNA or Autopsy.** An agent whose number moved because
it gained customers would be measuring its sales, not its trading.

Execution quality is the other half and it is a fact about a **wallet**: this
fill, this slippage, this gas, in this account. Your fills are your record.

| | the agent's | yours |
|---|---|---|
| `decisions` | one row per tick | never written |
| `portfolio_snapshots` | the creator's book | never written |
| `subscription_snapshots` | never written | your book, per tick |
| `executions` | `on_behalf_of = 'creator'` | `on_behalf_of = 'subscriber'`, with your `subscription_id` and `wallet` |

The cost meter follows the same line: an agent's window excludes rows carrying a
`subscription_id`, so a creator is never billed for gas paid out of a customer's
wallet, and your window reads exactly those rows.

## Every wallet is on its own

Out of gas, short of cash, refused by the signer, blocked on chain — each is
that wallet's outcome, recorded against that wallet, and no other wallet hears
about it. The creator's leg is never held up by a buyer's, and a buyer's failure
never reaches the creator.

That includes the reading of the list itself: one subscription with an
unreadable `risk_profile` is skipped, loudly, and every other buyer is traded
for as usual. The first version returned an error for the whole list, which
would have meant one malformed row stopping the agent trading for everybody.

Each wallet also takes its **own execution lease**, keyed on the subscription
id. A lease per agent would make one buyer's trade block every other buyer's,
and would make a buyer's stop loss unable to fire for as long as the agent was
trading for anybody at all. See migration `0040_lease_by_wallet`.

## Protective levels

When the agent names a stop or a target, each wallet gets its own — computed
from the price **that wallet** paid, in the pool it traded. Copying the
creator's absolute levels across would anchor your stop to a price your wallet
never paid, and the fills really do differ: different sizes, different blocks,
different slippage.

A level the pool refuses is refused for you too, and it is a row you can read:
`GET /v1/subscriptions/:id/book` returns `protection.armed`, and
`protection.unprotected` naming the smallest level that pool would accept. The
choice has to be taken, not discovered.

**A subscriber's protective exit writes no row in `decisions`.** `decisions` is
the agent's competition record and answers "what did this agent decide". A stop
firing in one buyer's wallet, at a price only that wallet crossed, is not
something the agent decided — it is one instruction meeting one account. What
decided is the level, and the level already has a row: `position_guards` carries
`triggered_at`, `triggered_side` and `triggered_price`, and the execution
carries `subscription_id`, `on_behalf_of` and `guard_id`.

## When it ends

Thirty days, and then:

* **the agent stops trading for that wallet.** `status = 'active'`,
  `expires_at > now()`, `NOT trading_paused` and a bound wallet are all
  required, and grace is deliberately not included — grace keeps you *reading*
  the record, which costs nothing; it does not keep spending your money on a
  subscription that has not been paid for;
* **open positions are left exactly where they are.** They are not liquidated on
  your behalf, because choosing the moment to sell somebody's position is a
  trading decision nobody asked this platform to make;
* **armed levels come down**, permanently, and the position is recorded as
  unprotected so you can see it. An agent nobody is paying must not keep
  signing, and a level that will never fire must not keep looking like
  protection until the day it is needed. A *pause* is different: the level stays
  armed and waits;
* **the wallet, the book and the key stay yours.** All three are properties of
  the wallet, not of the subscription, so an expiry cannot take them away.

## Verifying it

`infra/verify/subscription-verify.mjs` — 36 checks, spends nothing. It covers
who is traded for and who is not, what a buyer can reach and what a stranger
cannot, whose wallet a level watches, and what happens to that level when the
mandate ends. Every question is put to the code that decides it, through
`cmd/subcheck`, rather than to a re-implementation of the rule in SQL.

It cannot spend money, and **not because its wallets are empty**: every request
carries `X-Arcana-Verification`, and the engine then refuses to act on an agent
that holds a wallet *or that has a subscriber wallet*. The suite's first section
proves the fan-out is inside that rule by pointing a fixture subscription at a
wallet that really does hold funds — reading a balance costs nothing, and the
refusal lands before anything is signed.

`infra/verify/subscription-chain-verify.mjs` reads a fan-out that really
happened: one decision, two wallets, two transaction hashes, per-wallet fill and
slippage, zero custody drift on both, and the agent's own numbers unmoved. It
does not cause one.
