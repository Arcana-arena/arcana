# Agent Credit — capital reputation, and a limit that follows it

**Status: switched on 2026-10-03**, with the owner's approval, after a day of
the reputation being computed and shown while it moved nothing. The tier an
agent holds now sets the most it may owe, from 250 USDG at tier 0 to 5,000 at
tier 3, and the signer's per-agent cap was raised to 5,000 in the same commit.
No agent can hold more than tier 0 before 2026-10-24: thirty days after the
first borrow, which is the least history a rating needs.

Plan: architecture.md §18. It rests on [capital.md](./capital.md), which
describes the borrowing itself.

ARCANA's reputation has two dimensions, and they are kept apart:

| | Question | Where |
|---|---|---|
| **Performance** | How well does the agent manage money? | The ARCANA Score ([agent-passport.md](./agent-passport.md)) |
| **Capital** | How far can it be trusted when it is given capital? | This document |

No capital figure enters the ARCANA Score. The ARCANA Score is not a term in
the credit score either: a scored track record is a gate on the higher tiers,
and nothing else.

**This is not unsecured lending.** Every loan is still made by Morpho against
posted collateral. A higher tier raises the most an agent may owe; the
collateral, Morpho's LLTV and the mandate's health-factor floor still bound
every borrow. With enough collateral and a tier that allows it, the borrow can
be large. With a high tier and little collateral, it cannot.

| Part | Where |
|---|---|
| Cycles, score, tiers (pure) | `services/decision-engine/internal/credit` |
| Liquidation reader | `services/decision-engine/internal/execution/liquidations.go` |
| Scans | `services/decision-engine/internal/engine/credit.go`, run by the position guard |
| The limit, applied | `capital.Validate` → `debt_over_credit_limit` |
| Tier table | `services/signer/allowlist/robinhood-mainnet.json` → `lending.credit` |
| Tables | `capital_liquidations`, `capital_scan_cursors`, `capital_cycles`, `capital_reputation` (0061) |
| API | `GET /v1/agents/:id/capital` → `credit`; `GET /v1/agents/:id/passport` → `capital` |
| Pages | agent page → *Passport* (two blocks) and *Positions → Capital* (the working) |
| Proof | Go tests in `internal/credit`, `internal/capital`, `internal/execution` and the signer's `policy`; `infra/verify/credit-verify.mjs` |

---

## Liquidations

A liquidation is carried out by a third party and leaves no ARCANA row. The
guard reads Morpho's `Liquidate` event for every allowlisted market on each
capital pass, and writes a `capital_liquidations` row for each one whose
borrower is an agent wallet: the block's own time, the transaction, the
collateral seized, the debt repaid and any bad debt.

- **Where it starts.** `liquidations_from_block` in the allowlist: block
  71404524, the block the lending go/no-go was simulated at, before any ARCANA
  wallet had borrowed.
- **Where it has read to** is kept per market in `capital_scan_cursors`, and
  moves only after the range's events are written. A scan that fails reads the
  range again; an event is keyed by transaction and log index, so reading it
  twice writes it once.
- **Checked against the chain.** On 2026-10-02 the event's topic returned 163
  liquidations on this Morpho since that block, none in the allowlisted
  market. The decoder's test uses one of them.
- **Until a scan has finished**, the API reports the count as `null` and the
  page says "not read yet". Zero means the events were read and there were
  none.

Collateral that leaves a position some other way — an owner withdrawing with an
exported key — is not a liquidation and is not reported as one.

## A loan as a unit: the cycle

A cycle opens at the first reading of a position that finds debt where there
was none, and closes at the first reading that finds none again. It is derived
from `capital_positions`, so it sees a repayment the owner made with their own
key, which no `capital_actions` row records.

Each `capital_cycles` row carries its peak debt, `usdg_days` (the area under
the debt curve), the seconds it spent with a worst-case health factor under
1.5, its lowest worst-case health factor, what was borrowed and repaid through
ARCANA, the deleverage steps and liquidations inside it, and how it closed:

| `closed_how` | Meaning |
|---|---|
| `repaid` | the agent or its owner closed it |
| `deleveraged` | the guard had to act inside it |
| `liquidated` | a third party did |

Cycles are rebuilt from the readings each time, not appended, so a cycle row
cannot disagree with the readings it came from.

**USDG-days is the evidence, not the count.** A cycle counts toward the
reputation only with a peak of at least 10 USDG and a life of at least 24
hours. Fourteen loans of one USDG held for a minute are fourteen rows and no
evidence; a test asserts it.

## The score

0 to 100, deterministic, from every cycle the agent has. No model is asked
anything.

| Component | Points | Measures |
|---|---|---|
| Seasoned exposure | 35 | USDG-days across qualifying cycles, log-scaled; full at 25,000 |
| Margin kept | 30 | share of debt-time above a health factor of 1.5, and how far below it the lowest reading went |
| Self-sufficiency | 20 | deleverage steps per 30 days of debt; four or more is zero |
| Loans closed | 15 | qualifying cycles closed as `repaid`; full at twelve |

**A clean record on a small loan is weak evidence.** Margin and
self-sufficiency are multiplied by the same evidence fraction as exposure, so
"nothing went wrong" is worth as much as there was that could have gone wrong.

**Margin is measured against 1.5**, the lowest floor a mandate may set, and not
against the agent's own mandate. An owner cannot improve the measurement by
lowering the bar it is taken against.

**Unrated is a state, not a zero.** An agent that has never borrowed, has less
than 30 days since its first borrow, or has no qualifying cycle has no score.
It holds tier 0, and the page says why.

**The weights are proposed, not calibrated.** When they were written one agent
had borrowed. They are constants in one file so that changing them is one
reviewed diff.

Every `capital_reputation` row carries the four components and the figures
they were computed from. A row is written when the standing changes; a
recomputation that changes nothing refreshes that working and moves
`confirmed_at`.

## Tiers and the limit

The tier table is in the signer's allowlist:

| Tier | Capital reputation | Debt limit | Also requires |
|---|---|---|---|
| 0 | unrated, or under 40 | 250 USDG | — |
| 1 | 40 | 1,000 | — |
| 2 | 60 | 2,500 | 90 scored days |
| 3 | 80 | 5,000 | 90 scored days |

Three gates sit above the score, and a score cannot outvote them:

| `held_because` | Rule |
|---|---|
| `liquidation` | a liquidation in the last 90 days holds the tier at 0 |
| `deleverage_stuck` | a deleverage the guard could not carry out, in the last 30 days, holds the tier at 0 |
| `performance_gate` | the tier requires a longer scored trading record than the agent has |

The liquidation itself stays on the record permanently; 90 days is only how
long it decides the tier.

**The limit is permission, not instruction.** A mandate's borrow cap is the
owner's number, held to what the agent may owe (`agent_max_debt_usdg`). When a
tier rises nothing borrows more: the owner raises their mandate, or does not.
A cap above the limit is refused with `borrow_cap_over_credit_limit`.

**When a tier falls**, new borrowing above the lower limit is refused with
`debt_over_credit_limit`, and nothing already owed is called in. A forced
repayment into a falling market is how a downgrade becomes a liquidation. The
mandate's own floor keeps protecting the position.

**A reputation nobody has re-checked grants nothing.** One whose
`confirmed_at` is more than 48 hours old is treated as tier 0, by the engine
and by the API alike.

## Who enforces what

| Layer | Enforces |
|---|---|
| Signer | `max_debt_per_agent_usdg`, the ceiling. It refuses to load a file whose enabled tier table has a tier above it. |
| Engine | the agent's tier limit, in `capital.Validate`, on every borrow whoever proposed it |
| API | the same limit, on the mandate's borrow cap |

**The signer does not apply the tiers.** It has no database and cannot know
which tier an agent holds. So the per-agent cap — 5,000 USDG, the top tier —
is what a compromised engine could borrow per agent; before credit was enabled
it was 250. The borrow would still be against that agent's own collateral,
into its own wallet. Moving tier grants into a file the signer
reads is the next step before the ceiling is raised further.

## Switching it on, and off

It was switched on by one reviewed, dated commit to the allowlist:

1. `lending.credit.enabled` → `true`
2. `lending.limits.max_debt_per_agent_usdg` → the top tier's limit

The signer refuses to load the first without the second. Switching it off is
the reverse, and both numbers go back together: with credit disabled every
agent has `max_debt_per_agent_usdg`, so leaving it at 5,000 would hand every
agent the top tier. The per-transaction
cap (`max_borrow_per_tx_usdg`, 100 USDG) is separate and unchanged: a large
debt is reached in steps of at most that size.

## Not yet

- **Calibration.** The weights and thresholds have no history to be tested on.
- **Tier grants the signer can check** (above).
- **Lineage.** A new version of an agent has a new wallet and starts unrated.
- **Credit with less collateral, or none.** That needs a lender who absorbs a
  loss, and is a different product.
