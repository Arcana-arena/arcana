# What counts as holding something

One definition, used everywhere, with its number taken from the record rather
than from anyone's judgement.

## The number

**A position is a holding of at least `1e-8` shares. Anything smaller is a
residue.**

The number is the precision of `decisions.quantity`, which is `numeric(20,8)`.
Eight decimals is the finest quantity ARCANA is able to write down, so a holding
below `1e-8` cannot be recorded as a trade, cannot therefore be sold, and cannot
become anything. It is not a small position — it is a quantity the record has no
way to express.

This is the same derivation as `OnChainQtyStep`, and the same shape of
derivation as the sixty-second cadence floor, which comes from the minute
resolution of a market snapshot ref rather than from a preference. When the
column changes, this number changes with it; nothing else moves it.

It lives in two places because two languages cannot share an import:

| where | name | file |
|---|---|---|
| decision engine | `DustFloor` | `services/decision-engine/internal/engine/position.go` |
| agent service | `DUST_FLOOR` | `services/agent-service/src/common/positions.ts` |

`docs-verify` fails if those two stop agreeing with each other, with this
document, or with the column they are derived from.

## Where the residue came from

An exit that emptied a position on chain left one wei of GOOGL behind:
`0.000000000000000001` shares.

It was not a safety margin. The buy filled `17704874344043495` base units —
seventeen significant digits — and a `float64` carries about fifteen to
seventeen. The snapshot stored `...494`, the sell was built from that stored
figure and sent `...494`, and the chain still held `...495`. One wei of a
`float64` round trip.

Nothing was wrong with any single step. The chain answers in integers, the
portfolio is denominated in shares, and the conversion between them is lossy at
the eighteenth decimal. That is unavoidable. What was avoidable is *building a
sell out of the lossy side*.

## The two rules that follow

**1. An exit sends the balance, as an integer.**

When selling the requested quantity would leave less than `DustFloor` behind,
the broker sends the wallet's exact base-unit balance instead — the integer the
chain holds it as, never converted to a float. `Engine.exitUnits` makes that
decision; `execution.Request.ExactUnitsIn` carries it.

A partial sell is not covered by this and does not need to be: a partial sell is
not trying to reach zero.

**2. Every reader asks the same question the same way.**

`HasPosition` / `HeldQty` in Go, `isPosition` / `positionsOf` in TypeScript.
The alternative — each caller writing `> 0` — is what let a single wei look like
a position to four independent readers at once, each of which was individually
reasonable.

New snapshots are also pruned before they are written (`toAnyMap`), so rows
created from now on carry no residue at all. The readers still filter anyway,
because rows written before the prune existed are still in the table and have to
stay comparable with the rows written after it. A definition that changed
silently in the middle of an agent's history would be worse than the bug.

## What the old definition already affected

Measured, not assumed. One snapshot in the whole database carried a residue:
agent `a24df218` ("Phase 8c buy leg"), `2026-09-11 06:01:31Z`, GOOGL `1e-18`.

| reader | what it did | changed by the fix? |
|---|---|---|
| `series` `holdings_count` | read **1** for a tick where the agent held nothing | **yes** — that point now reads 0 |
| DNA `concentration` | counted that tick as a position and scored it **maximally concentrated**, which is precisely what the code's own comment says it skips | denominator was wrong; the **value did not change** (1.0 either way), because every other counted tick was also single-symbol. Luck, not design |
| Autopsy `by_symbol` | included the residue in GOOGL's P&L at `1e-18 × Δprice` | no — it rounds to `0.00`, and GOOGL was in the list on its own merits |
| LLM prompt | told the model `GOOGL 0.0000 units (worth 0.00)` instead of `holdings none` | **yes** — and this was the live one. A model that answered "sell GOOGL" would have produced a one-wei swap: a real approval and a real gas bill to move nothing. It did not happen. It was one decision away |
| `arcana_score`, `regime_score` | never read holdings at all | no |

The affected snapshot was **not** rewritten. It stays as it is: the read-time
floor is what makes old rows and new rows comparable, and silently editing a
recorded number is a worse failure than the one being fixed.

DNA is a different case and needs saying plainly. `arcana-agent-dna.timer` runs
daily at 06:45 and recomputes every agent's fingerprint **from the record**, so
after this is deployed every DNA row is recomputed under the new definition on
its own, without anyone asking. That is not a decision being made quietly — it
is why the read-time floor is there. A fingerprint computed tomorrow over rows
written yesterday has to mean the same thing as one computed today, and the only
way to get that is for both to read holdings the same way. For the one affected
agent the concentration value is 1.0 under both definitions anyway.

The residue itself is still in the wallet: it merged into the position bought at
11:00 (filled `15850403013324052`, held `…053`). The next exit sweeps it,
because an exit now sends the balance.

## What a position cost, and what it made (0051)

Until 0051 an entry price existed only where a protective guard recorded one,
so a position opened without a stop had no cost basis, and a position that
closed left no result anywhere. Both were data that was never stored.

Every fill that changes a book is now written to `position_fills` when it
happens — the virtual settlement, a human's manual trade, the creator's
on-chain fill, a protective exit, and each subscriber's leg and exit — by
`Engine.writeFill`, with the accounting done at write time by
`store.ApplyFill`:

- **Average cost.** The basis is the volume-weighted price of the buys since the
  position was last flat. A sell realizes `(price − average cost) × quantity`
  and leaves the average unchanged.
- **Prices are as filled.** On chain that is quote units spent over share units
  received, so the pool fee is already inside the price; `pool_fee_usd` is kept
  as information only. Gas is not in the price and is kept per fill.
- **Unknown stays unknown.** Shares that arrived without a recorded fill (moved
  in from outside, or bought before 0051 and not reconstructable) make the
  average cost `NULL` until the position is next flat. Shares that left outside
  ARCANA keep the basis of what remains and realize nothing.
- **Episodes.** A position's life from flat to flat. `position_episodes` sums an
  episode's realized P&L and gas; its `net_pnl` is `NULL` whenever either half
  is unknown.
- **Two books.** `book = 'agent'` is the agent's portfolio in a season;
  `book = 'subscription'` is one buyer's wallet and is never added into an
  agent's or a creator's totals.

The ledger is append-only (a trigger refuses edits, and refuses deletes while
the book still exists). History from before 0051 was rebuilt once by
`decision-engine/cmd/fills`: on-chain fills from `executions`, virtual fills
from decisions at the price in the snapshot each one names. Those rows carry
`source = 'reconstructed'`.

`infra/verify/fills-verify.mjs` checks that every mined buy/sell and every
virtual buy/sell has a fill, that every row's accounting adds up, and that the
round trips computed by hand on 2026-09-14 (AAPL +0.0053, AAPL +0.0066,
MSFT −0.0312) are the ledger's own results.

## Verification

`infra/verify/dust-verify.mjs` drives it rather than reading it: a sell built
from a float that cannot represent the balance, run against a fake chain that
answers in exact integers, and the assertion is that the wallet reaches zero —
plus the reader cases, each given a residue on purpose.
