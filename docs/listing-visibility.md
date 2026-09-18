# When a listing is on the market, and when it is not

A listing belongs to an agent. The agent decides; the listing is how somebody
buys the right to mirror those decisions. So the question "is this on sale?"
cannot be answered by the listing alone, and for a long time this platform
answered it that way.

Implemented in `services/marketplace/src/listings/browse.service.ts`
(`SELLABLE_AGENT_STATUS`), `services/marketplace/src/listings/listings.service.ts`
(`discover`, `assertNotRetired`) and
`services/arca-service/src/payments/claims.service.ts` (the quote gate).
Verified by `infra/verify/marketplace-flow-verify.mjs`.

---

## What happened

`arcana_labs` had an agent, `momentum_bot`, and a listing for it. The agent was
retired. The listing stayed on the marketplace — the grid drew a card, the
landing page offered it, and the card even said `RETIRED` on it, because the
read path knew. Nothing else did. The repair was manual: a wallet address was
granted to the creator and the listing was moved to an agent that still ran.

Migration `0046` closed it for the rows that existed on the day it ran:

```sql
UPDATE marketplace_listings l SET active = false
  FROM agents a WHERE a.id = l.agent_id AND a.status = 'retired' AND l.active;
```

That is a repair, not a rule. It fixed every listing that was wrong at that
moment and said nothing about the next agent to retire.

## The rule

**A listing is offered only while its agent is `active`.** Not "not retired" —
`active`. Retired, paused and draft agents all drop out, and a status invented
later drops out too, until somebody decides it is sellable. The check is
eligibility, not a list of exclusions, because a list of exclusions is a list
somebody has to remember to extend.

### It is derived, never stored

Nothing is written to `marketplace_listings` when an agent stops. The rule is a
condition on every read.

The alternative — switching `l.active` off when an agent is paused — fails in
both directions. It destroys the creator's own switch: a listing the creator
had deliberately turned off would come back on when the agent resumed, because
nothing recorded which of the two had turned it off. And it makes correctness
depend on a write firing at exactly the right moment, from every path that
changes a status, forever. The day one of them forgets, a dead agent is back on
sale and nothing says anything is wrong.

Derived visibility cannot drift. The listing disappears the instant the agent
stops being active and returns the instant it is active again.

### Hidden is not deleted

`counts.hidden_unavailable` and `counts.hidden_by_agent_status` come back with
every grid response, and `include_unavailable=true` returns the rows
themselves. An empty grid and a grid that withheld everything look identical
from the outside, and a shopper is owed the difference.

## The three decisions

### 1. Discovery hides them

| Surface | Before | Now |
|---|---|---|
| `GET /v1/marketplace/browse` — the grid | returned them, flagged `buyable: false` | withheld, counted, explained |
| `GET /v1/marketplace/agents` — the landing page | `l.active = true` and nothing else | `a.status = 'active'` and `a.provenance = 'live'` too |
| `GET /v1/marketplace/listings/:id/detail` | readable | still readable, still says why it cannot be bought |

The detail page stays reachable on purpose. Somebody holding a link to a thing
they already paid for must be able to read the record. What changes is that it
cannot be bought.

### 2. A term already paid for runs to its end

A subscription bought before the agent stopped keeps its thirty days. It is not
cancelled, not shortened, not refunded.

The buyer paid for a fixed term and a paused agent may resume within it. Ending
the term early would take something that was paid for in order to avoid giving
something that was paid for. The platform has no refund mechanism — every
payment is a transfer between two wallets it does not hold — so "stop it now"
would mean the buyer loses both the access and the money.

What changes for that buyer:

- **They are told.** `agent_standing` on their subscription says which status,
  until when their access runs, and that nothing is being mirrored.
- **`trading` tells the truth.** It used to be derived from the subscription row
  alone — paid, not paused, not expired, wallet bound — every one of which
  stays true when the agent retires. A buyer whose wallet had stopped moving was
  told "the agent is trading for this wallet" indefinitely. It now also requires
  the agent to be deciding, which is what the decision engine has always
  required.
- **Their money and their positions stay theirs.** The wallet is theirs, the
  key is exportable, the book is readable. None of that depends on the agent.
- **No renewal.** A renewal is a new payment, and new payments are refused.

### 3. Resuming restores the listing automatically

No creator action, because there is nothing to restore. The listing row was
never changed, so there is no flag to switch back and none to forget. A creator
who pauses for a week comes back to the marketplace they left.

Retirement does not resume. `resume()` refuses it by name — a retired agent's
record has closed, and restarting it would attach new decisions to a finished
one — so `POST /v1/marketplace/listings` refuses to publish a listing for a
retired agent at all. A listing that could never become buyable should not be
created.

## Refusing to take the money is the point

The grid saying `RETIRED` on a card was honest and did nothing. It governed
what a shopper saw and not what the platform would accept: a bookmark, a
renewal or a tab left open still reached `quote()` and got an address and an
amount.

So the refusal sits on the quote, which is the last surface before the money
moves:

| Code | When |
|---|---|
| `agent_retired` | the agent's record has closed; it will not decide again |
| `agent_paused` | its creator stopped it; it may or may not come back |
| `agent_draft` | it has never started, so there is nothing to mirror |

**And deliberately not on the claim.** `claim()` and the unclaimed-payment
search are reached by a buyer whose transaction is already on the chain —
someone who paid while the agent was still running and submitted the hash a
minute later. Refusing them would answer a paid buyer with "this agent was
retired" and leave them with neither access nor money, which is the exact
failure the payee lookup exists to prevent. What has been paid is honoured, and
the response says plainly what was bought. What has not been paid for is
refused before it is sent.

## What the verifier was proving, and was not

`marketplace-flow-verify` built a listing that **could** be bought and confirmed
it was offered. That is an existence test. It fails only when something correct
stops working, and it can never see the opposite defect — a listing that should
not be offered and is — which is the defect production actually had.

It now asks the question the other way round, against live rows rather than a
fixture, because a fixture is excluded by provenance before the status rule is
ever consulted:

- of everything the marketplace is offering right now, is any of it stopped?
- does the withheld count match what the database holds?
- does `include_unavailable=true` bring back exactly those rows?
- does the landing page's feed offer any agent that has stopped?
- does the quote refuse a paused and a retired agent, by name, telling the
  buyer not to send anything?
- does resuming make it quotable again **without the listing row being written
  to**?
- does retiring an agent leave a running subscription active, with its date?

Related: [marketplace-payments.md](./marketplace-payments.md),
[agents.md](./agents.md), [subscription-trading.md](./subscription-trading.md).
