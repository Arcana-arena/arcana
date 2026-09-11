# Agent DNA — when the definition changed, and what moved

`arcana-agent-dna.timer` recomputes every fingerprint daily from the record, so
a change to what DNA measures reaches every existing row on its own. That is
what makes old rows and new rows comparable — and it is also how a definition
can change without anyone noticing.

So it gets written down here: what changed, why, and the numbers on either side.

---

## 2026-09-11 — protective exits left the behavioural features, and became one

### What changed

Until this date a stop loss firing was indistinguishable, to DNA, from the agent
deciding to sell. Both produced a row in `decisions` with `action = 'sell'`.

Now:

- `turnover`, `sellShare`, `tradeSizePct` and `trendAlignment` are computed over
  **agent-authored decisions only**. Ticks where a level acted leave the
  denominator too, so an agent whose stop fired does not read as *less* active
  than one whose did not.
- A ninth feature, **`protectiveExitShare`**, carries the dimension explicitly:
  the share of an agent's exits that a level took rather than the agent.
  `FEATURE_COUNT` went 8 → 9 and the vector gained `v[8]`.
- `risk_personality.protective_exit_share` states it in words beside the vector.

### Why this way

The two defensible options were to exclude protective exits from the
behavioural features, or to count them as their own dimension. **Both were
taken, because each alone is wrong in a different direction.**

Every one of the four affected features is a statement about **judgement**: how
often the agent chose to trade, how it sized an entry, whether it bought into
strength. A stop loss firing is not a choice made at that moment — it is a level
set earlier, crossed by the market. Leaving it in means two agents with
identical judgement and different stop settings get different fingerprints for a
reason that is not judgement.

But removing it entirely would lose something equally true: **how much an agent
leans on automatic exits is part of its character**, and it is measurable. If
that lived only in `risk_personality` it would sit outside the vector, so two
agents differing only in that would come out identical under cosine similarity —
the same conflation, in the other direction.

A ninth dimension is not padding. The 248 empty dimensions are reserved for DNA
2.0 and stay empty; this one carries a measurement.

### What it does NOT touch

`arcana_score` and `regime_score`. DNA has never fed either, and this changes
nothing about that. No weight and no formula in the Scoring Engine was altered.

### The numbers, before

Captured 2026-09-11 immediately before the change, from `agent_dna`:

| agent | turnover | sellShare | concentration | tradeSizePct | trendAlignment |
|---|---|---|---|---|---|
| Phase 8b chain cycle | 0.125 | 1 | 1 | 0 | 0 |
| Phase 8c buy leg | 0.2 | 0 | 1 | 0.4998 | 0 |
| holder_v1 | 1 | 0 | 0.5000 | 0.4500 | 0 |
| momentum_bot (v1) | 0 | 0 | 0 | 0 | 0 |
| momentum_bot (v2) | 0.6269 | 0.2149 | 0.5454 | 0.0200 | 0.8704 |
| momentum_v1 | 0 | 0 | 0 | 0 | 0 |
| reversion_v1 (v1) | 0 | 0 | 0 | 0 | 0 |
| reversion_v1 (v2) | 0.6373 | 0.2195 | 0.5673 | 0.0915 | −0.8667 |

All eight rows carried eight features and no `protectiveExitShare`.

### Which rows moved, measured after the recompute

The recompute was run deliberately rather than left to the next timer, so the
change could be recorded against the numbers above rather than discovered later.
8 fingerprints recomputed, 5 skipped for being below the participation
threshold.

| agent | turnover | sellShare | protectiveExitShare |
|---|---|---|---|
| Phase 8b chain cycle | 0.1250 (unchanged) | 1.0000 (unchanged) | 0 |
| **Phase 8c buy leg** | 0.2 → **0.4545** | 0 → **0.2000** | **0.6667** |
| **holder_v1** | 1.0 → **0.6000** | 0 (unchanged) | 0 |
| momentum_bot (v1) | 0 (unchanged) | 0 (unchanged) | 0 |
| momentum_bot (v2) | 0.6269 (unchanged) | 0.2149 (unchanged) | 0 |
| **momentum_v1** | 0 → **0.6000** | 0 (unchanged) | 0 |
| reversion_v1 (v1) | 0 (unchanged) | 0 (unchanged) | 0 |
| reversion_v1 (v2) | 0.6373 (unchanged) | 0.2195 (unchanged) | 0 |

**Phase 8c is this change.** Two of its three exits were levels, so
`protectiveExitShare` is 2/3 and `sellShare` is now computed over the one sell
the agent actually chose. Its turnover also moved because migration 0036 landed
in the same deploy: 55 of its 69 decision rows are marked as measurement
artefacts and no longer counted, so the denominator is 14 rather than 69. The
two were landed together on purpose — one before and one after, not two.

**holder_v1 and momentum_v1 are NOT this change, and an earlier draft of this
document said they could not move.** That prediction was wrong, and the reason
is worth keeping: DNA is recomputed from a record that KEEPS GROWING. Both
agents are scoped to season 2, which held three ticks at the last scheduled run
and holds five now. momentum_v1 has three buys across those five ticks, so
turnover is exactly 3/5; holder_v1 gained two hold ticks, so 3/3 became 3/5.
Neither has a protective exit and neither has a marked row.

**One thing cannot be reconstructed.** momentum_v1 read all zeros before, which
is the shape of a fingerprint computed over no ticks at all — but by 06:45 it
already had ticks that should have produced a number. Why the earlier run
produced zeros cannot be established now: that run's inputs no longer exist,
and DNA stores only its output. Recorded as unexplained rather than given a
plausible cause.

### What cannot move

An agent with no protective exit and no marked decision row is unaffected BY
THIS CHANGE — its features recompute identically with a ninth feature of 0.
That is not the same as saying its row will not change, as the two above show.

### Similarity across the change

Cosine similarity is computed over the whole 256-dim vector, so a row with nine
features and a row with eight are still comparable — the missing dimension
contributes nothing to either operand. But comparisons made **before** the daily
recompute has caught up will place an agent with a measured
`protectiveExitShare` against neighbours whose ninth dimension is merely absent
rather than zero. That window is at most one day, and it is stated here rather
than left to be discovered.
