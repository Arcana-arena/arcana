# Data Resets

Deliberate deletions of competition data, and why. A reset erases evidence, so
the reason has to survive somewhere — that record is itself part of the
auditability the platform claims (§12).

Nothing here is routine. Each entry should read as a decision someone made,
with enough detail that a later reader can judge whether it was the right one.

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
