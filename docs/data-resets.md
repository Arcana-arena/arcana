# Data Resets

Deliberate deletions of competition data, and why. A reset erases evidence, so
the reason has to survive somewhere — that record is itself part of the
auditability the platform claims (§12).

Nothing here is routine. Each entry should read as a decision someone made,
with enough detail that a later reader can judge whether it was the right one.

---

## 2026-09-10 — §10 payment subsystem retired (no data deleted)

### Why

The marketplace became **P2P with no fee**: the buyer transfers straight to the
creator's wallet and submits the transaction hash, which ARCANA verifies against
the chain. That removes the reason the §10 machinery existed — deposit
addresses to match payments, a listener to detect them, a sweep to a treasury,
an off-chain 80/20 split, and a batch to pay creators.

The design was also shaped by a belief that was **never true**: that Robinhood
Chain was permissioned and ARCANA could not deploy a contract. It has been
permissionless since 1 July 2026.

### What was mapped before anything was touched

Filenames were not trusted. Each service was traced to its callers, and the
result changed the plan:

| Component | Verdict | Evidence |
|---|---|---|
| `PayoutBatchService`, `creator_payouts` | **dead by decision** | only caller is its own route and timer; P2P with no fee means ARCANA never holds or splits a payment |
| `DepositAddressesService`, `HdWalletService` | **LIVE** — held | `POST /v1/marketplace/listings/:id/subscribe` calls `POST /v1/arca/deposit-address`. This is the current subscribe path |
| `PaymentListenerService` | **LIVE** — held | the only thing that creates a subscription after payment; removing it would mean a user pays and access is never granted |
| `SubscriptionsService` | **LIVE** — held | `hasAccess()` and the grace rule; `GET /v1/arca/access` is the single source of truth marketplace consults |
| `ReminderService` | **LIVE** — held | writes the `active → grace → expired` transitions the access rule reads |
| `ArcaTokenService` | **LIVE** — held | `EntitlementService` depends on it; $ARCA gating is unaffected |

**So §10 is not dead. It is dormant** — inert only because `ARCA_TOKEN_ADDRESS`
and `ARCA_MASTER_PRIVATE_KEY` are empty. Six of the twelve files still hold up
the live subscribe → grant → access flow, and their replacement is phase 11.

### What was deleted

Code only. **No table was dropped and no row was deleted.**

- `payout-batch.service.ts`, `creator-payout.entity.ts`
- `POST /internal/v1/payments/payout/run`
- `arcana-arca-payout.service` and `arcana-arca-payout.timer`
- `infra/k8s/` — an empty directory describing a topology that does not exist

### What was kept, and why

All four payment tables. They were **empty at retirement** — verified on
production: `deposit_addresses` 0, `payment_events` 0, `creator_payouts` 0,
`user_push_tokens` 0 — so there was no history to preserve. What is preserved
is the record that they existed, as `COMMENT ON TABLE` in migration **0024**.
A comment travels with the schema and shows up in `d+`, so the next person to
open the database gets the story without needing to find this file.

`subscriptions` is explicitly **not** part of this retirement. It is the access
record, not a payment record, and it was only ever a neighbour of the others.

### The hazard that was closed

`DepositAddressesService.generate()` refused only because the environment was
empty. `docs/arca-go-live.md` is a written procedure instructing an operator to
**fill exactly those variables in**. Following it would have silently activated
a payment model this project has abandoned and started routing real user money
through an ARCANA-controlled address — reporting success the whole way.

The path now refuses **by decision**. Configuration cannot lift it. A retirement
that one environment variable can undo is not a retirement, and that is the part
of this entry worth remembering.

### Backup

None taken, and none needed: nothing was deleted from the database. The daily
backup covers the schema change like any other.

---

## 2026-09-09 — Season 1 (`45765ffc-51ef-4b31-aeb0-fae67633e448`)

### Why

Two defects in the market simulator meant every price Season 1 ever traded on
was wrong, and therefore every NAV, score and ranking derived from them.

**1. Unsigned underflow (fixed in `d1a655a`).** `float64(h%201-100)` subtracted
on a `uint32`, so whenever `h%201 < 100` the expression wrapped to ~4.29e9.
AAPL, based at 110, was quoted at **4,724,464,088**. `momentum_bot` reached a
NAV of **2.36 trillion**, and its risk and consistency scores were 0 — not
because it traded badly, but because the series it was measured on was
nonsense.

**2. The market never went anywhere (fixed in `c351ebf`, calibrated in
`35ef3cb` and `6644183`).** Each tick restarted the walk from the caller's base
prices instead of the previous tick's close, so prices oscillated around a
constant. The market was mean-reverting *by construction*, which silently
invalidated every strategy comparison: a mean-reversion agent scored well for
matching a defect in the simulator rather than for judging the market, and a
momentum agent never had a trend to follow.

Keeping the data was the riskier option. A NAV of 2.36 trillion is not "bad
data to interpret carefully" — it is a number that means nothing, and it kept
surfacing on the leaderboard and in marketplace discovery, where sooner or
later someone would read it as signal. "Measure, don't believe" cannot rest on
measurements we already know are broken.

### What was deleted

| Table | Rows | Scope |
|---|---|---|
| `score_snapshots` | 866 | all — the table has no season column, and every scored agent was a Season 1 participant |
| `decisions` | 186 | Season 1 only |
| `portfolio_snapshots` | 184 | portfolios belonging to Season 1 |
| `portfolios` | 5 | Season 1 only |
| `competition_ticks` | 79 | all — each references a `market_snapshot_ref` that no longer exists |
| `market_snapshots` | 144 | all — see below |

`market_snapshots` was **not** in the original reset plan and was added
deliberately. Two reasons: the rows carry the billion-dollar prices themselves,
and one leftover row (`snapshot-20260909-000000`, dated in the future by a
manual test) permanently won `ORDER BY tick_time DESC` and so became the
starting price for *every* subsequent tick — which froze the newly fixed walk
in place. It made the fix impossible to verify and would have quietly defeated
it in normal operation.

### What was kept

`agents`, `creators`, `seasons`, `competitions` — identity and configuration,
untouched. Only performance and decision history was removed. The five Season 1
participants keep their ids, so their new history accumulates under the same
identity rather than as new agents.

### Backup

Full CSV dump taken before deleting, on the VPS at:

```
~/arcana-backups/season1-reset-<UTC timestamp>/
  portfolios.csv  portfolio_snapshots.csv  decisions.csv
  score_snapshots.csv  market_snapshots.csv  competition_ticks.csv
```

Outside the repo, deliberately: it is contaminated data kept for reference, not
something to restore from.

### After

The scheduler refilled Season 1 from the corrected market. Any score dated
after this reset is the first that can be taken at face value.

---

## 2026-09-09 — 26 orphaned decisions (fallout of the Season 1 reset)

### Why

The reset above deleted `market_snapshots` but kept some decisions. That left
**26 decisions citing 7 refs that no longer existed** — 9.9% of the table.

A decision without its snapshot cannot be audited. What survives is a note that
an agent did something, with nothing to say against what market. §12 calls the
snapshot the immutable evidence behind the decision, and "Verified Decision
History" is exactly that pairing.

The damage was not theoretical. Two of the orphans were `holder_v1`'s **only**
trades, and Agent DNA reads trade prices from the snapshot: `tradeSizePct` and
`trendAlignment` came out 0, indistinguishable from an agent that genuinely
never traded. A blind feature that looks like a measurement is worse than a
missing one.

### What was deleted

| Agent | Season | Orphans | of which trades |
|---|---|---|---|
| `holder_v1` | Season 1 | 6 | 2 |
| `momentum_bot` | Season 1 | 6 | 1 |
| `momentum_v1` | Season 1 | 6 | 1 |
| `reversion_v1` | Season 1 | 6 | 6 |
| `dummy_agent_v2` | Dummy Season 1 | 2 | 0 |

262 decisions → 236. Nothing else was touched: `portfolio_snapshots` (65 per
agent), `market_snapshots` (59) and every other table were left alone, and
`competition_ticks` was checked and had **zero** orphans.

### Consequence worth stating plainly

Deleting unauditable decisions changes what the record says. `holder_v1`'s two
trades were among them, so its surviving history is 59 holds and no trades at
all. Its DNA now reports `turnover 0.000` — which is true of the evidence that
remains, where the previous 0.033 was true of evidence half of which could no
longer be checked.

### Backup

```
~/arcana-backups/orphaned-decisions-<UTC timestamp>/
  orphaned_decisions.csv   (26 rows, full columns)
  missing_refs.csv         (7 refs)
```

### Prevention

Migration **0019** adds a foreign key from `decisions.market_snapshot_ref` to
`market_snapshots.ref` with `ON DELETE RESTRICT`. The same mistake is now
rejected by the database rather than left to whoever writes the next reset
plan — including the author of this file, who missed it once already.

> **For any future reset: `decisions` and `market_snapshots` are a pair.**
> Retire the decisions first, then the snapshots they cited. The constraint will
> refuse the other order, which is the point.

---

## 2026-09-09 — Season 1 ARCHIVED (not deleted) for the vendor switchover

This entry is in a file about deletions because it is the decision **not** to
delete, and that deserves the same record.

### Why the question arose

Market-data switched from a price simulator to real vendor prices
([market-data.md](./market-data.md)). Every row Season 1 ever produced was
measured against generated prices. Letting those scores, fingerprints and
Autopsy findings sit in one series with real-market ones would compare two
different worlds as though they were one.

### Why archive rather than reset

The 2026-09-09 reset above deleted data because the numbers were **meaningless**
— a NAV of 2.36 trillion is not a measurement to interpret carefully, it is
nonsense that kept surfacing on the leaderboard. Season 1's data is different:
it is **true about a simulated market**. That is a real distinction, and it calls
for labelling rather than deletion.

Two further reasons:

- Deleting would mean removing 1,016 decisions and 260 snapshots in the correct
  order under the 0019 foreign key. That sequence has already been got wrong
  once, in the reset above, and it orphaned 26 decisions.
- The simulator caveat on Autopsy and DNA needs its subject matter to still
  exist. A caveat about data nobody can look at is unfalsifiable.

### What changed

| Table | Action |
|---|---|
| `seasons` | Season 1 `end_at` set to now. `start_at` corrected from `2026-10-01` (a **future** date it had been running a month ahead of — see the season-window bug below) to its first recorded tick, `2026-09-08`. |
| `competitions` | Season 1's two competitions marked `completed`. The scheduler no-ops on a completed competition. |
| `market_snapshots` | All 260 rows labelled `source='simulator'` by migration 0021. Nothing deleted. |
| `score_snapshots` | All 1,132 rows attributed to their season by migration 0022. Nothing deleted. |
| everything else | Untouched. Decisions, portfolios, portfolio snapshots, ticks and DNA all remain. |

Also removed, and this **was** a deletion: two competitions
(`e9347826…`, `fab766cc…`) created purely to verify the Premium Arena gate a few
hours earlier. Both were `pending` with no ticks, decisions or portfolios.
Removed while their origin was still known — this project has twice been bitten
by test artefacts outliving the memory of why they existed.

### Season 2

`Season 2 - US Equities (real market)`, the same agent identities as Season 1
(the precedent set by the reset above: history accumulates under one identity
rather than as new agents), on the 50-symbol real universe.

### Backup

Taken before the migrations, on the VPS at:

```
~/arcana-backups/pre-vendor-switchover-20260909T115358Z/
  score_snapshots.csv (1132)  market_snapshots.csv (260)  decisions.csv (1040)
  portfolio_snapshots.csv (1066)  portfolios.csv (7)  competition_ticks.csv (260)
  competitions.csv (4)  seasons.csv (3)
```

Unlike the reset backups, this one is a precaution rather than a quarantine: the
data it copies is still live in the database.

### The season-window bug this exposed

Season 1 declared `2026-10-01 .. 2026-12-31` and had been running since
2026-09-08 — **a month before its own declared start**. Nothing anywhere enforces
a season's date window: the scheduler advances whatever competition it is pointed
at, and the Passport already worked around it explicitly ("the declared window is
a plan", "the agent's own first and last recorded tick is the evidence").

Left unenforced for now, deliberately. Enforcing it would have to answer what
happens to a tick that arrives outside the window — refuse it, and an operator
error silently halts a season; accept and flag it, and every consumer needs the
flag. That is a competition-rules decision, not a bug fix, and with one tick per
trading day the window is now a meaningful constraint worth designing properly
rather than bolting on during a data migration. Season 1's dates were corrected
so the archived record is at least truthful about itself.
