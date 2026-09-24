# ARCANA CAPITAL — what exists after day 6

**Status:** a mandate can be written, activated and stopped in a browser; an
active mandate's decider runs on the agent's cadence and records every action
and refusal. Lending was **enabled** in the allowlist on 2026-09-25, with the
owner's approval, for the first live borrow; the caps (100 USDG per borrow, 250
per agent) are unchanged. Only an agent whose owner activates a mandate borrows.

Plan: architecture.md §17. Evidence for the market chosen:
[go-no-go-lending.md](./go-no-go-lending.md).

| Part | Where |
|---|---|
| Lending allowlist, caps, `enabled: false` | `services/signer/allowlist/robinhood-mainnet.json` → `lending` |
| Signer intents | `lending_approve`, `lending_supply`, `lending_borrow`, `lending_repay` in `services/signer/cmd/server/main.go` |
| Policy | `services/signer/internal/policy/lending.go` |
| Reader | `services/decision-engine/internal/execution/capital.go`, run by the position guard |
| Decider and its rule | `services/decision-engine/internal/capital` (`Decide`, `Validate`, `NeverSellRefusal`) |
| Capital cycle | `services/decision-engine/internal/engine/capital_cycle.go`, after each trading decision |
| Execution | `services/decision-engine/internal/execution/lending_exec.go` |
| Tables | `capital_positions` (0058); `capital_mandates` and `capital_actions` (0059) |
| API | `GET /v1/agents/:id/capital` 🌐; `GET`/`PUT /v1/agents/:id/capital/mandate`, `POST …/activate`, `POST …/stop` 🔒 |
| Pages | agent Positions tab → *Capital*; `/me/agents/:id` → *Capital mandate* |
| Proof | `infra/verify/lending-verify.mjs`, `infra/verify/capital-verify.mjs`, Go tests in both services |

---

## The signer

Four intents, each taking an allowlisted `market_id` and an `amount` in base
units. The agent's wallet is `onBehalf` and `receiver` in every one; there is no
field to name anyone else, and a request that tries is refused as `bad_request`
because unknown fields are.

| Intent | Builds | Refused when |
|---|---|---|
| `lending_approve` | `token.approve(Morpho, amount)` | token is not the market's collateral or loan token; unbounded amount |
| `lending_supply` | `supplyCollateral(market, amount, self, "")` | — beyond the shared checks |
| `lending_borrow` | `borrow(market, amount, 0, self, self)` | over the per-transaction cap; over the per-agent debt cap; debt unreadable |
| `lending_repay` | `repay(market, amount, 0, self, "")` | — repay is not capped |

Every one of them is refused with `lending_not_enabled` while the allowlist says
`enabled: false`, which is how it ships. The other refusal codes are
`market_not_allowlisted`, `borrow_over_tx_cap`, `debt_over_agent_cap` and
`lending_token_not_in_market`, alongside the existing `unbounded_approval`,
`amount_not_positive` and `chain_state_unverifiable`.

**The caps are written in whole USDG and compared in base units.** The file says
`100` and `250`; the loader multiplies by 10^6 once, using the quote token's own
decimals, and nothing after it sees a whole-USDG number. A cap with a fractional
part does not load. Tests pin both directions of the mistake: a borrow one base
unit over 100 USDG is refused, and 100 USDG written at 18 decimals is refused
too rather than passing as a small number.

**The current debt is read from Morpho on every borrow and never cached**, rounded
up the way Morpho values it. A debt the chain will not return refuses the
borrow.

**A market's id is recomputed from its parameters at load.** A file whose id and
parameters disagree does not load: it would describe one market for review and
sign for another.

## The reader

Once a minute by default (`CAPITAL_SCAN_EVERY`, counted in guard scans), for
every agent wallet **whatever the agent's status** — pausing must not stop
watching a debt (§17.4):

- `position(id, wallet)` for each wallet;
- for a market where someone holds a position: `market(id)`, the oracle's
  `price()`, the Uniswap pool price, both Chainlink feeds' `updatedAt`, and the
  collateral token's `oraclePaused()`.

A row is written for each non-empty position, and one row of zeros when a
position that existed has closed. An agent that never borrowed costs one
`position()` read per scan and writes nothing.

| Column | Meaning |
|---|---|
| `health_factor` | Morpho's own: collateral × oracle price × LLTV ÷ debt. Liquidation is decided on this. `NULL` means no debt, not unknown. |
| `health_factor_worst` | The same on the **lower** of the oracle and the pool price. Over a weekend the oracle holds Friday's close while the token trades. |
| `liquidation_price_usdg` | Collateral price at which `health_factor` reaches 1: debt ÷ (quantity × LLTV). |
| `base_feed_age_s`, `quote_feed_age_s`, `oracle_paused` | What the oracle does not check for itself. `NULL` means it could not be read. |

Units: collateral is read in 18-decimal base units, debt in 6, the oracle price
at Morpho's 1e36 scale, LLTV as a WAD. They stay integers until the last step,
where each is converted once with the allowlist's decimals.

## The mandate

`capital_mandates`, one per agent. Every bound is enforced three times: the API
refuses with a code and a sentence, the database refuses the same row with a
CHECK constraint, and the engine's `capital.Validate` refuses the action.

| Field | Bound | Refusal |
|---|---|---|
| `min_health_factor` | 1.5 – 10 | `health_floor_too_low` |
| `max_borrow_usdg` | above 0, at most the signer's per-agent cap | `borrow_cap_not_positive`, `borrow_cap_over_platform` |
| `liquidity_trigger_usdg` | 0 – the borrow cap | `trigger_out_of_range` |
| `max_borrow_rate_bps` | 1 – 10000 | shape check |
| `never_sell` | allowlisted symbols only | `never_sell_not_holdable` |

Activation needs an active agent (`agent_not_active`) with a chain wallet
(`no_wallet`). Stopping leaves the position watched.

## The decider

Deterministic, one action per cycle, on the **worst** of the oracle and pool
price: repay under the floor; repay, and borrow nothing, above the rate; borrow
up to the trigger when cash is below it, posting wallet collateral first when
the floor leaves no room; repay cash above twice the trigger; otherwise hold.

Every proposal then goes through `Validate`, which refuses a borrow over the
mandate's cap, over the platform's caps, under the floor, above the rate, on an
untrusted oracle (a feed past its heartbeat, or `oraclePaused()`), or beyond the
market's liquidity. A trading SELL of a never-sell symbol becomes a hold with
reason `never_sell`, and a mandate that cannot be read holds the sell too.

**Why not the `decisions` table.** The scoring engine divides by every row of
`decisions_counted`, and DNA, autopsy and the overview read the same view, so a
borrow written there would move a trading score — which §17.3 forbids. A
capital decision is a `capital_actions` row with its own evidence: the mandate
and position it was taken on, the rule's reason, and what `Validate` and the
signer said. It is not part of the decision commitment chain or the on-chain
anchors. A hold is written only when its reason changes.

## Not yet

- **Enabling the signer.** A reviewed commit flipping `enabled`, and a funded
  wallet with gas, are what turn a recorded refusal into a real borrow.
- **Deleverage.** Selling collateral to restore the floor, in the guard loop
  between ticks, is day 7.
- **A real transaction.** Everything above was proved by simulation against
  live state; nothing has been broadcast.
