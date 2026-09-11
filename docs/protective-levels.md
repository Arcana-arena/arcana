# Take-profit and stop-loss

A level set when a position opens, watched between decision ticks by a process
that holds no model and spends no gas until one is actually crossed.

## Why it is not another decider

Everything else that trades here runs on the decision cadence: a tick opens, the
agent is asked, an answer is recorded. A stop loss cannot work that way. Its
whole value is that it fires **between** ticks, and an agent on an hourly
cadence with a 5% stop has in practice a 5%-plus-one-hour stop — which is not
the thing its owner asked for.

So there is a second process, `arcana-guard`, and a second author in the record.

## Who decided

**A protective exit is a decision with a different author, not an execution with
no decision.**

`decisions.decider` already carried this axis — `deterministic`, `llm`, `human`
— and this adds `protective`. The alternative, an execution row with a NULL
`decision_id`, would say that nothing decided, which is the one thing that is
definitely false: the agent acted, and something decided that it should.

What a protective decision does **not** carry is load-bearing too. No provider,
no model, no params, no prompt hash, no response hash, no thesis. There was no
model and no forward-looking claim; those columns stay NULL because the record
is refusing to invent an author rather than because nobody filled them in.

`reason_code` is `stop_loss` or `take_profit`. `action` is `sell`, because it
was one.

The Passport reports the split under `decided_by`:

```json
"decided_by": { "own": 4, "protective": 2, "stop_loss": 2, "take_profit": 0,
                "unattributed": 6,
                "note": "2 of 6 trades were protective exits (2 stop loss, 0 take profit), decided by a level rather than by the agent." }
```

`unattributed` is rows written before the distinction existed. They are not
folded into `own`: "we do not know" is a different statement from "the agent
decided".

## Where the levels come from

Two routes, and the second is the one the free prompt opened.

**The risk profile**, for an owner who wants a standing rule:
`risk_profile.stop_loss_pct` / `take_profit_pct`. Applied to every position the
agent opens, including those a coded strategy opens — a deterministic strategy
has no way to ask for a level.

**The model**, per trade. The output contract gained `stop_loss_pct` and
`take_profit_pct`, so a mandate written in the owner's own words —

> get out if it drops 0.15% below what you paid, and take the profit if it rises
> 0.15% above

— reaches the guard as two numbers. Nothing in the mandate names a column or a
field. The model turns the sentence into a request and the code decides what is
allowed, which is the same division that makes free prompts safe everywhere
else: a prompt can be talked out of its instructions, and `resolveGuardLevels`
cannot.

A per-trade level overrides the standing one. A model that says nothing about
stops keeps the ones its owner configured.

## What is refused, and why the bound is not a preference

**The near bound is the pool's round trip.** Buying pays the fee and selling
pays it again, so immediately after entry:

```
entry paid = mid × (1 + fee)
realizable = mid × (1 − fee)
realizable / entry ≈ 1 − 2·fee
```

A stop at `entry × (1 − p)` is therefore crossed **at the moment of entry**
whenever `p ≤ 2·fee` — not after a move, not after a loss, but by the arithmetic
of the round trip alone. That is 0.1% on the 5 bp pools (AAPL, NVDA, GOOGL, SPY,
QQQ) and 0.6% on the 30 bp ones (TSLA, AMZN, MSFT, META).

> This was wrong in the first version. It used one flat 0.4%, reasoned from
> **one** side of the round trip on the widest pool, so every level between 0.4%
> and 0.6% on a 30 bp pool would have been accepted and would have fired on its
> own entry. It surfaced while working out how to trigger a stop on purpose for
> the verification — not from reading the code.

A take profit inside the round trip is refused too. It cannot fire at open, but
exiting there realises **less** than was paid, and an owner reading "take profit
fired" would draw the wrong conclusion.

**The far bound** is 95%: a level that far below entry cannot be crossed, so it
is a guard that watches forever and never fires.

A refused level **does not cost the agent its trade**. The buy happens, the other
level is armed if it is valid, and the decision's rationale names each refusal.
Silently dropping a stop loss would be the worst failure this feature has: the
owner believes they are protected and nothing is watching.

## What the level is measured from

The price **actually paid**: quote units spent divided by shares received, from
the execution. Not the snapshot price, not the quote — a level 5% below a number
that never happened is not 5% below anything.

**A top-up is a second entry.** When a position is added to, the new levels are
anchored to the volume-weighted average of both entries, using the replaced
guard's own record of the first one. Anchoring to the latest fill alone would
move an existing stop every time the agent added to a winner, which is the
opposite of what a stop is for.

Shares held before any guard existed have no cost basis this system can see.
They are covered — the exit sells the whole balance either way — and the guard's
note says their cost is unknown, rather than silently pricing them at today's
fill.

## What the watcher reads

`router.factory() → factory.getPool(token, quote, fee) → pool.slot0()`, times
`(1 − fee)`.

Not a simulation of the sell, which would be more accurate. The first version
did exactly that — `eth_call` of the same `exactInputSingle` calldata a sell
would send — and it fails:

```
scan: 1 armed, 0 fired, first error: quote GOOGL: execution reverted: STF
```

`STF` is SafeTransferFrom. The simulation runs `transferFrom(wallet, pool,
amount)`, which checks `allowance[wallet][router]` — and this system grants
allowances for the exact amount of a swap, immediately before sending it, on
purpose. There is no standing allowance to simulate against. The two ways to
make the simulation work were both worse than the problem: grant the router a
standing allowance, throwing away a deliberate part of the signer's posture for
a monitoring convenience; or fake the allowance with `eth_call` state overrides,
which means knowing each token's storage layout through beacon proxies and
breaking silently whenever an implementation changes.

So the price is a mid price net of the fee, and it does **not** include price
impact. That omission is bounded by something other than optimism: the exit is
sent with a `min_out` floor, so a realizable price materially worse than this
makes the transaction fail its slippage floor rather than fill badly. The level
decides *when* to try; the floor decides whether the fill is acceptable.

Reading it costs no gas. An agent with no armed guard costs not even a call.

## Every brake still applies

This is not a route around the limits.

| brake | how it applies |
|---|---|
| signature cap | the signer counts this signature like any other; at the cap it refuses |
| cost meter | checked before the exit, and it **can refuse it** — when the owner set one |
| allowlist / `paused()` | same signer, same file, same checks |
| dust floor | a residue is not a position: the guard expires rather than firing |
| custody drift | the same `noteDrift` on the same path |
| approval row | its own row, its own hash, its own priced gas |

**The cost meter refusing a stop loss is deliberate — when the owner asked for a
cost meter.** It is not a platform brake: `cost_budget_monthly_pct` lives in the
agent's own `risk_profile`, and an agent that set none is unmetered, which is
the default. An owner who says "stop my agent when its costs cross 2% a month"
means that for its exits too. Nobody wants to be the reason a stop did not fire,
and that is exactly why this is the path most likely to be argued into an
exception — but an exception here would mean the owner's own brake stopped
applying at the moment it was most expensive.

It is also not the only thing that would stop the exit: the signature cap would
refuse the signature anyway once the daily allowance ran out, so a hole here
would not save the exit, only hide why it did not happen.

So: the refusal is **recorded as a decision** with `cost_budget_exceeded`, the
guard stays **armed** rather than being consumed, and the watcher's failure is
visible. When the budget frees, the level is still watching.

## One intent, one transaction

The guard can cross a level in the same second a decision cycle decides to sell
the same position. Both read a position that is there, both build a sell, both
broadcast — the same failure the "never retry an unresolved transaction" rule
exists to prevent, arriving from a different direction.

`agent_execution_leases` holds the exclusive right to move one agent's funds.
A row with an expiry, not an advisory lock: both writers use pooled connections
they do not own for the length of an execution, and a row survives a crash
without a human, is visible to anyone debugging, and cannot be held forever by a
process that died mid-swap.

**Nobody waits.** Whoever takes it acts; whoever does not stands down and records
why — the cycle as a hold with `position_locked`, the guard by leaving the level
armed. Queuing would produce exactly the thing being prevented: two transactions
from one intent, a second apart, the second discovering the position is gone.

A stop loss five seconds late is still a stop loss. A position sold twice cannot
be un-sold.

The lease is proved by **making the race happen** — two real processes, one real
lease, a shared start instant, repeated — with a control that the winner
alternates, so the suite is measuring contention rather than start order. See
`cmd/leaserace` and `infra/verify/guard-verify.mjs`.

## The watcher's own liveness

This project has a specific record here: the `go run` parent/child trap has bit
three times, a watcher was once confirmed alive by a `pgrep` that matched its own
command line, and a watchdog alarm path was broken from its first line.

So:

- **Built, not `go run`.** systemd supervises the process that does the work.
- **`Restart=always`**, because a watcher that exits cleanly is still a watcher
  that has stopped watching.
- **A heartbeat on every scan**, including scans that find nothing. That is the
  part that makes a dead watcher distinguishable from a quiet one — the rule
  `docs/execution.md` states and the reason `guard_heartbeat` has no condition
  on it.
- **`arcana-guard-watchdog`** reads that heartbeat every two minutes, alongside
  `systemctl is-active`, because the combination is the diagnosis:

  | unit | heartbeat | meaning |
  |---|---|---|
  | inactive | stale | it is not running |
  | active | stale | it is running and stuck |
  | active | fresh, with an error | it is scanning and failing |
  | inactive | fresh | something else is writing heartbeats |

  Each of those is a separate alarm with separate wording, and each was fired on
  purpose in `guard-verify`. The delivery path was fired for real through ntfy
  (HTTP 200) before this was called finished.

## Files

| what | where |
|---|---|
| levels, bounds, crossing | `services/decision-engine/internal/engine/guard.go` |
| the exit | `services/decision-engine/internal/engine/protective.go` |
| the watcher | `services/decision-engine/cmd/guard/main.go` |
| pool pricing | `services/decision-engine/internal/execution/pool.go` |
| storage, lease, heartbeat | `services/decision-engine/internal/store/guards.go` |
| schema | `packages/db-migrations/migrations/0034_position_guards.up.sql` |
| unit + watchdog | `infra/systemd/arcana-guard*.{service,timer}` |
| verification | `infra/verify/guard-verify.mjs`, `internal/engine/guard_test.go` |
