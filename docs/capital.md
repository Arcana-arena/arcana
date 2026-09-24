# ARCANA CAPITAL — what exists after day 5

**Status:** watched, not acted on. The signer can build the lending shapes and
refuses all of them; the position guard reads every agent's Morpho position and
records it; the agent page shows it. Nothing borrows, repays or deleverages.

Plan: architecture.md §17. Evidence for the market chosen:
[go-no-go-lending.md](./go-no-go-lending.md).

| Part | Where |
|---|---|
| Lending allowlist, caps, `enabled: false` | `services/signer/allowlist/robinhood-mainnet.json` → `lending` |
| Signer intents | `lending_approve`, `lending_supply`, `lending_borrow`, `lending_repay` in `services/signer/cmd/server/main.go` |
| Policy | `services/signer/internal/policy/lending.go` |
| Reader | `services/decision-engine/internal/execution/capital.go`, run by the position guard |
| Table | `capital_positions` (migration 0058) |
| API | `GET /v1/agents/:id/capital` 🌐 |
| Page | Positions tab → *Capital · borrowing against the book* |
| Proof | `infra/verify/lending-verify.mjs`, plus Go tests in both services |

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

## Not yet

- **Enabling the signer.** A reviewed commit flipping `enabled`, after day 6.
- **Acting on a health factor.** The capital decider and the deleverage path
  are days 6 and 7.
- **A real transaction.** Everything above was proved by simulation against
  live state; nothing has been broadcast.
