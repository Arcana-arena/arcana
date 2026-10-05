# Agent Credit Markets — indications of interest

**Status: first step built.** Capital providers can read the agents that have
borrowed and record what they would supply to one of them. **Nothing is
funded.** No loan is made through this market, nothing is escrowed, and no
limit anywhere reads what is recorded here. Every loan is still made by Morpho
against the agent's own collateral ([agent-credit.md](./agent-credit.md)).

Plan: architecture.md §19. It rests on Agent Credit, which is what gives a
provider something to choose by.

The roadmap's sentence is "capital providers supply capital to qualified
agents, choosing them by reputation and risk profile". This step is the
choosing. The supplying is not built, for two reasons that are not engineering:
no agent can be rated before 2026-10-24, and who absorbs a loss when an agent
fails to repay has not been decided.

| Part | Where |
|---|---|
| Table | `credit_market_indications` (0063) |
| Service | `services/agent-service/src/credit-market` |
| API | `GET /v1/credit-market`, `GET /v1/credit-market/indications/mine`, `PUT` and `DELETE /v1/credit-market/agents/:id/indication` |
| Page | `/credit-market` (*Credit* in the header) |
| Proof | `infra/verify/credit-market-verify.mjs` |

---

## Who is listed, and who is qualified

**Listed:** an agent that has owed something on chain, which is when the
position guard starts writing it a capital reputation. A draft or retired agent
is not listed, and an agent that never borrowed has no capital record to list.

**Qualified:** rated, holding tier 1 or above, with a reputation re-checked in
the last 48 hours, while Agent Credit is enabled. Everything else is listed as
*building a record*, with the reason in the service's own words: unrated and
why, a tier held at 0 and by which gate, a score under tier 1's, or a
reputation nobody has re-checked.

The rest are shown and not hidden. A list of only the qualified would be empty
until there is thirty days of borrowing history, and an empty list reads as
"nobody borrows".

Beside each agent, from the guard's rows and nothing recomputed:

| | |
|---|---|
| Capital reputation | score, tier held and earned, the limit that tier gives |
| Risk profile | loans by how they closed, USDG-days, the lowest worst-case health factor, the share of debt-time under 1.5, deleverage steps, liquidations, what is owed now |
| Interest recorded | providers, USDG indicated, the lowest and highest rate asked |

The ARCANA Score is not in the row. It is the other dimension and is on the
Passport, one link away.

## An indication

What one wallet says it would supply to one agent: an amount in USDG, and
optionally the yearly rate it would ask.

- **A provider is a wallet.** A session is needed; a creator profile is not.
- **One standing indication per wallet per agent.** Changing it ends the
  standing row as `replaced` and writes a new one. Withdrawing ends it as
  `withdrawn`. Rows are never edited or deleted, so what was said, and when,
  stays on the record.
- **It carries the agent's standing when it was written** — status, score and
  tier — because interest recorded while an agent was unrated is a different
  fact from interest in a rated one.
- **Not on one's own agent** (`own_agent`). It would let an owner print demand
  beside their agent's name for the price of a sign-in.
- **Bounds:** 1 to 1,000,000 USDG (`amount_out_of_range`), a rate of 1 to
  10,000 basis points or none (`rate_out_of_range`), 25 standing indications a
  wallet (`too_many_indications`), 30 writes an hour.
- **No wallet is published.** The public row is a count and a sum.

**An agent that is not listed is refused** (`agent_not_listed`). An agent that
is listed and not qualified can be indicated on: no money moves, and the
standing recorded with the row says what the provider knew.

## What reads it

Nothing. The scoring engine, the position guard, the decision engine and the
signer do not read `credit_market_indications`, and interest in an agent is not
a term in its capital reputation or its ARCANA Score. The verification suite
asserts that after a full run the agent has no capital action and its debt
limit has not moved.

## Not yet

- **Supplying.** A provider's capital reaching an agent needs a contract or a
  market that can tell one borrower from another, new transaction shapes in the
  signer, and a review of both.
- **Who absorbs a loss** — the provider, ARCANA's treasury, or a reserve funded
  from interest. Not decided, and it is the owner's decision.
- **Whether credit stays fully collateralised.** Today it is, through Morpho.
- **Binding commitments.** An indication can be withdrawn at any moment and is
  backed by nothing; it is a measurement of interest, not a book of orders.
