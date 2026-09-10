# On-Chain Direction — the decisions, and why

ARCANA changes from a virtual-capital competition into a platform where **LLM
agents trade real money on-chain, continuously**. This document records the ten
design decisions that change forced, so they can be revisited deliberately later
instead of being discovered as hidden assumptions.

Every number here is measured, not estimated. The measurements come from the
[go/no-go test](./go-no-go-stock-tokens.md) run against Robinhood Chain mainnet
on 2026-09-10.

Related: [architecture.md](../architecture.md) (§2.2, §2.4, §2.7, §10, §12),
[market-data.md](./market-data.md), [scoring-formula.md](./scoring-formula.md).

---

## The shape of the change

| | Before | After |
|---|---|---|
| Capital | Virtual, 100,000 per season, identical for everyone | Real, in a wallet the platform holds for the agent |
| Decider | Three deterministic Go functions (`momentum`, `mean_reversion`, `buy_and_hold`) | An LLM, behind a provider abstraction |
| Execution | Settled in memory against a snapshot price | A signed transaction against a Uniswap v3 pool |
| Market | US equities, one tick per trading day, closed on weekends | Stock Tokens on Robinhood Chain, which never close |
| Custody | None | **Custodial** — the platform holds the keys |
| Marketplace | Deposit addresses, 80/20 split, treasury transit | P2P, no fee, buyer pays creator directly |

Three things did **not** change, and they are why most of the codebase survives:
the append-only `decisions` log, the NAV series in `portfolio_snapshots`, and
the rule that a component which is unsure does not act.

---

## a. Fairness — decision quality and execution quality are scored separately

**Decision: two numbers, not one.** The ARCANA Score keeps its existing formula
and is computed on **decision quality**, marked against a reference price at the
moment the decision was recorded. Execution — what the trade actually filled at,
what gas cost, whether it failed — is measured separately as `execution_score`
and reported alongside, never folded into the reputation number.

**Why.** "All agents receive an identical snapshot" cannot survive real
execution: agents trading the same pool move each other's prices, and two agents
deciding four hours apart see different markets by construction. The premise is
gone whichever way we go.

What is *not* gone is the thing the premise was protecting: that the score
measures judgement rather than luck of timing or size. Marking decisions at a
reference price preserves exactly that, and it has the practical benefit that
**`services/scoring-engine` needs no change at all** — it already reads a NAV
series and a decision log, and neither cares where the prices came from.

**The cost, stated plainly.** A user reading two numbers has to be told which
one is "the score". It is the decision score; execution is a separate column.
That is a product-copy problem, and it is a smaller one than a reputation number
that silently rewards whoever happened to trade in a thinner minute.

**Revisit when** agents are large enough to move the pools they trade — at the
caps below, $10,000 of total platform capital against a pool doing $28.7M a day
is not that, and this decision defers the problem rather than solving it.

## b. Evidence — attested, not reproducible

**Decision: "Verified Decision History" changes meaning, and the change is
stated rather than glossed.** From *"the decision can be replayed from the same
snapshot"* to *"we can show exactly what was asked, what was answered, by which
model, when, and what was executed on-chain"*.

Recorded per decision, all of it:

| Field | Why |
|---|---|
| `prompt_hash` + prompt body in object storage | the exact text, addressable, same pattern as `market_snapshots` |
| `response_hash` + raw response body | before parsing, so a malformed answer is still evidence |
| `model_id`, `model_version`, `provider` | required; see below |
| `temperature`, `top_p`, `seed` | recorded even though they do not guarantee reproducibility |
| `input_snapshot_ref` | unchanged from today |
| `tx_hash`, `receipt_status`, `gas_used`, `effective_price` | new, and third-party verifiable |

**Two tiers, because they have different guarantees.** The **guardrail layer**
— schema validation, the policy engine, the risk limits — is deterministic and
**fully replayable**, exactly as today. Only the LLM's output is attested. This
matters more than it sounds: the layer that decides *what is permitted* is the
replayable one. The layer that decides *what is desired* is not.

**Why not claim reproducibility at temperature 0.** Because it would be false.
Providers do not guarantee bitwise determinism, and models are withdrawn —
`deepseek-chat`, named in the original plan for this work, was retired on
2026-07-24 while the plan was being written. Recording `model_id` and
`model_version` on every decision is not bookkeeping; it is the only thing that
will let a decision from 2026 be understood in 2028.

**This is a weakening of the platform's core claim, and it is written down as
one.** This codebase has corrected "the chain is permissioned", "IEX Cloud",
"the gateway handles auth" and "$ARCA gating exists" after each was left
standing too long. This one is corrected before it ships.

## c. Slippage, gas and failed transactions

**Decision: `decision_score` feeds the ARCANA Score; `execution_score` is
reported separately** (the other half of decision **a**).

`execution_score` carries, per trade: reference price at decision time, realised
fill, slippage in basis points, gas paid, and whether the transaction succeeded.

**A failed transaction is never recorded as a hold.** It gets
`execution_status = 'failed'` and keeps its gas cost. Today's
`applyIntent()` degrades an unsettleable trade to a hold, which was right for a
simulator and is a silent failure with real money: the decision was made, the
transaction was sent, and money was spent. Three distinct facts, all of which
must survive in the record.

**Why not score realised returns only.** Because gas is a *fixed* cost per
transaction. At $0.0573 a swap, a $100 wallet pays 5.7 basis points in gas on
every trade regardless of trade size, so a realised-only score would rank agents
mostly by how rarely they trade — reviving the "abstention wins" defect that
exposure normalisation was built to kill (see
[scoring-formula.md](./scoring-formula.md#2026-09-09--risk--consistency-normalised-by-exposure-participation-rule-added)).

## d. Price source — the pool executes, Chainlink referees

**Decision: execution price is the pool's. Chainlink is the independent sanity
check. The equities vendor is retired from the live path.**

Every Stock Token ships with a Chainlink price feed. It is on-chain, free to
read, independent of the pool, and — critically — **available on Sunday**, which
the equities vendor is not. A pool price that deviates from the feed by more
than `PRICE_DEVIATION_MAX_PCT` produces `price_implausible` and no trade.

**Why an independent source is not optional.** The unsigned underflow that
quoted AAPL at 4,724,464,088 was caught by a human days later. With one price
source there is nothing to compare against, and the same class of bug now moves
real money. The referee is the cheapest safety this design gets.

**`MARKET_VENDOR_API_KEY` is no longer a go-live blocker.** Polygon keeps one
narrow use — backfilling pre-launch price history so Agent DNA and Autopsy have
depth on day one — and loses the other: the leaderboard no longer publishes
vendor closes, so the redistribution-licence blocker in
[market-data.md](./market-data.md) stops applying. Get the key if it is free;
nothing waits on it.

## e. User-created agents — a template, not a blank prompt

**Decision: a fixed ARCANA system prompt, plus a bounded free-text thesis from
the user, plus structured risk parameters in `agents.risk_profile` — the column
that already exists and is already enforced in code.**

**The principle that makes this safe: the prompt decides intent, the code
decides what is permitted.** The LLM's output is a *request*. It is validated
against the policy engine before it can become a transaction. A bad prompt then
costs its owner money through bad trades — which is their risk to take — rather
than through the agent doing something structurally forbidden.

**Prompt injection is a live vector here, not a theoretical one.** While
enumerating tokens for the go/no-go test, one token on this chain reported a
symbol several thousand characters long. Token names and symbols are attacker-
controlled text on a permissionless chain, and they flow into the prompt. So:
symbols reaching the prompt are drawn from the allowlist only, rendered from
ARCANA's own universe file, never from `symbol()` on an arbitrary contract.

**Revisit when** there is evidence that the template is the binding constraint
on what users want to express. Free-form prompts are the obvious next step and
the obvious next hazard.

## f. Agent authority — six layers, and only one of them binds

Custodial means no contract constrains the agent. The constraint has to be in
code, and it matters enormously *which* code.

| # | Layer | Enforces | Binding? |
|---|---|---|---|
| 1 | System prompt | intent, style, context | **No.** Never a control. |
| 2 | JSON schema validation | `action ∈ {buy,sell,hold}`, `symbol ∈ allowlist`, `size ≤ 1` | rejects malformed output → `llm_invalid_output` |
| 3 | Policy engine (Go, deterministic) | token allowlist, max notional, max position %, cash floor, max trades/day, no unknown tokens | **replayable**; this is where `risk_profile` already lives |
| 4 | **Signer** | only `approve(router, amount)` and a swap on an allowlisted router, tokens from the allowlist, to and from the agent's own wallet. **Refuses any raw `transfer` to an arbitrary address.** | **Yes. This is the last line.** |
| 5 | Wallet cap | deposits above the cap stop the agent and flag; excess is withdrawable, never auto-returned | an outbound transfer triggered by an inbound one is itself a vector |
| 6 | On-chain | nothing | there is no contract. Say so out loud. |

Withdrawal is the single path that produces a transfer to an outside address,
and it has its own gate — see **j**.

## g. Marketplace — tx hash confirmation

**Decision (taken by the project owner, recorded here): the buyer transfers
directly to the creator's wallet and submits the transaction hash. ARCANA
verifies against the chain — the transaction exists, is confirmed, the amount
matches the listing, and the recipient is that listing's creator wallet.**

No contract, no fee, no treasury transit, no deposit addresses.

**What this inherits from §10 and must not lose.** The old design learned two
things the hard way, and both apply to any verifier:

- A payment that arrives and is never credited is the one failure this system
  does not tolerate quietly. If verification fails for a hash a user submitted,
  it is logged at **ERROR** with the hash, not swallowed as a bad request.
- The verifier must check the **recipient**, not just that a transfer happened.
  A hash for a real transfer to somebody else is the obvious attack, and it is
  free to mount.

Added by this design, because the old one did not need it: **a tx hash is
replayable by anyone who can see it.** `payment_events.tx_hash` is already
`UNIQUE`; that constraint is now load-bearing rather than tidy, and the test
suite must prove a second submission of the same hash is refused.

## h. LLM cost — the platform pays, and it is the smallest number here

**Decision: the platform absorbs inference cost. Gas comes out of the agent's
own balance** (owner's decision, recorded).

| Cadence | 10 agents | 100 agents | 1000 agents |
|---|---|---|---|
| every 4h | $0.5 | $5 | $54 |
| every 2h | $1.1 | $11 | $108 |

Per month, `deepseek-flash`, ~2,200 input tokens (1,200 of them cache-hits) and
150 output tokens per decision.

**This is not the cost that matters.** At 100 agents on a four-hour cadence the
inference bill is $5 a month and the gas bill is roughly $300. The lever on cost
is not a cheaper model; it is trading less often — which is what **i** is about.

**What covers it.** With the marketplace fee-free, `$ARCA` gating (CREATE,
COMPETE, EVOLVE, PREMIUM ARENA) is the platform's only revenue surface. It is
already built and waits on the token. **That is a single point of failure for
the business model and is recorded here as one**: from the first funded wallet
until the token launches, the platform carries cost with no live revenue path.

## i. Cadence — the user chooses, within a floor the arithmetic sets

**Decision: the user picks the cadence. The platform shows the projected cost
before they pick, and refuses combinations the arithmetic rules out.**

Measured inputs: gas **$0.0573** per swap (0.127748 gwei, ~180,000 gas, ETH
$2,490); pool fee **5 bp** on AAPL/NVDA/GOOGL/SPY/QQQ, **30 bp** on
TSLA/MSFT/AMZN/META; price impact **under 0.01%** at $1,000 — negligible, and
not the problem.

Assuming a trade on half the decisions at 20% of NAV, on a 5 bp pool:

| Cadence | Trades/mo | Pool fee | Gas | Minimum capital for ≤2%/mo |
|---|---|---|---|---|
| **1 hour** | 360 | **3.60%** | $20.63 | **impossible at any capital** |
| 2 hours | 180 | 1.80% | $10.31 | $5,160 |
| 4 hours | 90 | 0.90% | $5.16 | **$470** |
| 6 hours | 60 | 0.60% | $3.44 | $250 |
| 12 hours | 30 | 0.30% | $1.72 | $110 |
| 24 hours | 15 | 0.15% | $0.86 | $50 |

**Hourly is not a preference we declined; it is arithmetically unavailable.**
The pool fee alone is 3.60% of capital per month and does not shrink with more
capital, because it scales with capital. This is the single most useful number
the go/no-go test produced.

So: **minimum cadence is 4 hours**, `AGENT_MIN_CADENCE_HOURS=4`.

**"24/7" survives this intact, and it is worth being precise about what it
means.** It means the market never closes — an agent can act at 03:00 on a
Sunday, which the old daily-tick design could never do. It does not mean every
agent decides every hour.

**Decisions are staggered**, at `hash(agent_id) % cadence_minutes`. It spreads
LLM calls, RPC reads and gas across the interval instead of stacking them at the
top of the hour. Simultaneity was worth protecting when it underpinned fairness;
decision **a** already retired that premise, so staggering now costs nothing.

**Before the LLM is called at all**, the existing rebalance band is checked: if
no allowlisted symbol has moved beyond the band since the last decision, the
tick is recorded as a hold with reason `no_material_move` and no inference is
purchased. This is inherited from `RiskLimits.RebalanceBandPct` in the
`strategy.go` that this work otherwise retires — the one idea in it worth
keeping.

## j. Deposit and withdraw

**Deposit.** The user sends USDG to the agent's wallet address. The platform
watches for it. A balance above the cap stops the agent trading and flags it;
the excess is withdrawable. Gas (a small ETH float) is funded by the platform on
wallet creation so a user cannot brick their own agent by forgetting it — the
float is charged against the first deposit.

**Withdraw: free stablecoin balance only.** Open positions must be closed first,
through an explicit **"close all and withdraw"** flow that shows the sells as
they happen. The platform never picks an execution price on the user's behalf
inside a withdrawal — that turns every unhappy fill into a platform dispute.

**In-kind withdrawal of Stock Tokens is not offered**, because whether an
arbitrary user address may receive them was not tested in the go/no-go run and
the issuer's blocklist could refuse it. Revisit only with a test that proves it.

**Manual approval is required for every withdrawal** until cumulative withdrawn
value passes a threshold the owner sets. The cap makes the first *mistake*
survivable; manual approval makes the first *attack* survivable. It costs
nothing while there are tens of users, and it is the cheapest control available.

Full check list, and how each is proven to refuse, in
[custody-and-withdrawal.md](./custody-and-withdrawal.md) *(written in phase 8)*.

---

## Capital: the caps, and the rule that sets them

**A single budget rule replaces guessing at a number:**

```
projected monthly cost (gas + pool fee) ≤ 2% of the agent's funded capital
```

`AGENT_COST_BUDGET_MONTHLY_PCT=2.0`. The platform shows the projection when the
user picks a cadence, and refuses the combination if it breaks the rule, naming
the capital that would satisfy it.

**2% a month is high, and saying so is part of the design.** It is roughly 24% a
year in costs. That is the honest floor for retail-size on-chain trading, and a
user must see it before they fund anything. Hiding it would make ARCANA a worse
version of the thing it claims to be.

**The projection is an estimate; the enforcement is a meter.** Actual cumulative
gas and fees are accumulated per agent against the budget. Crossing it pauses
the agent and alerts. A projection cannot refuse anybody — a meter can, and this
project's rule is that a gate which has never refused anyone has not been
tested.

| | Value | Why |
|---|---|---|
| Minimum funding | **$250** | below this, fixed gas is an absurd share at any usable cadence |
| Maximum per agent | **$1,000** | at 4h cadence: 1.42%/month, ~17%/year — visible, not absurd |
| Platform total, phases 7–9 | **$5,000** | the number the owner can lose entirely without the project ending |
| Platform total, public | to be raised deliberately | see the gates below |

**Raising the caps requires all four**, then 10× and no more:

1. 30 consecutive days with no unexplained difference between recorded NAV and
   on-chain balance.
2. The withdrawal attack suite passing, with every attack refused.
3. A key-recovery drill passed — not documented, performed.
4. At least one real incident where the system refused to trade rather than
   traded wrongly.

---

## Human vs AI is retired

**Decision: retired, not paused.** `strategy_type = 'human'`,
`ExecuteManual()`, the `HUMAN_WINDOW` tick window, and the `human_vs_ai`
competition type stop being live paths.

**Why.** Three independent reasons, any one of which would be enough:

- A person submitting trades that the platform executes from a wallet the
  platform controls is a materially different activity from an autonomous agent
  trading its owner's funds. It is the shape of a brokerage, and this project
  has already decided not to answer that question (see the US exclusion, below).
- The mechanic does not survive the cadence change. `HUMAN_WINDOW` is "the tick
  is open for an hour"; continuous trading has no ticks to open.
- Its fairness premise — identical capital, identical snapshot, identical
  window — was retired by decision **a**.

**Nothing is deleted.** Season 1's human participants keep their decisions,
portfolio snapshots, score history and Passport, exactly as a retired agent
does. What stops is accrual. The record closes; it is not erased.

---

## The five conditions from the go/no-go test

Carried here so they are part of the plan rather than an appendix to it.

| # | Condition | Where it lands |
|---|---|---|
| 1 | `token_paused` and `wallet_blocked` are first-class refusal states | phase 5, with the other refusal reasons |
| 2 | **Beacon monitor** — alarm when the Stock Token implementation changes | **phase 2, before anything else touches money** |
| 3 | US exclusion is a legal question, not an engineering one | **blocker on the phase that admits public users**; not for me to answer |
| 4 | One real ~$20 mainnet swap before trusting the simulation | phase 7, and the owner is asked before it is spent |
| 5 | Never use the canonical UniversalRouter address | router allowlist, phase 6 |

**On condition 2, the reasoning in one sentence:** the Stock Token is a beacon
proxy, so one upgrade transaction can convert today's permissive blocklist into
an allowlist for every Stock Token at once, and the permission this whole
direction rests on would be gone with no notice. Watching
`implementation()` costs one RPC call per interval and is the highest-value
monitor in the system.

---

## Refusal states — the full set

An agent that is unsure does not trade. Every refusal is recorded as a decision
with a reason code; none is dropped, and none is silently a hold.

| Code | Trigger |
|---|---|
| `no_material_move` | nothing moved beyond the rebalance band — no inference purchased |
| `llm_unavailable` | timeout, 5xx, rate limit |
| `llm_invalid_output` | schema violation, unknown symbol, unparseable |
| `price_implausible` | pool vs Chainlink deviation over threshold, or a single-tick jump over threshold |
| `balance_unreadable` | RPC failed to read the wallet |
| `policy_refused` | the policy engine rejected the requested trade |
| `insufficient_gas` | ETH float below threshold |
| `token_paused` | the issuer paused the Stock Token |
| `wallet_blocked` | the issuer blocked this wallet |
| `cost_budget_exceeded` | the cost meter crossed the budget; agent paused |
| `tx_failed` / `tx_timeout` | **not a hold.** The decision was made and executed; execution failed, and gas was spent |

**N consecutive refusals with the same reason pause the agent and alert.** A
component that runs, exits cleanly and produces nothing is the failure
`OnFailure=` cannot see — the reason `arcana-tick-watchdog.sh` had to exist
(it was replaced on 2026-09-11 by the decision watchdog, which asks the same
question without a market calendar; see [cadence.md](./cadence.md)).

---

## Revision log

### 2026-09-10 — this document

Written after the [go/no-go test](./go-no-go-stock-tokens.md) returned GO with
conditions. Decisions **a**–**f** and **h**–**j** are the recommendations from
the mapping report, taken as final by the owner without individual review;
**g** was decided by the owner directly. The capital and cadence numbers are
derived from measurements taken during the test rather than chosen.
