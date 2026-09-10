# On-Chain Rollout — the phases

How the [direction change](./on-chain-direction.md) gets built. Each phase
produces something that can be verified on its own, and no phase depends on a
later one to be worth having.

Two rules govern the order:

- **Nothing that touches money ships before the chain guard does** (phase 2).
  The permission this whole direction rests on can be revoked by the issuer in
  one transaction; a monitor for that is worth more than any feature.
- **What runs today keeps running until its replacement is proven.** The daily
  tick, the score batch and the DNA batch stay live through phase 6.

| # | Phase | Status | Blocked on |
|---|---|---|---|
| 1 | Decisions and document corrections | **done** | — |
| 2 | Chain guard — beacon and issuer-control monitor | **done** | — |
| 3 | Infrastructure cleanup — Kafka and Redis off | **done** | — |
| 4 | Retire the code the direction change kills | next | — |
| 5 | `MarketIndexService` — remove the per-snapshot round trip | | — |
| 6 | Decider abstraction + DeepSeek, still on virtual money | | — |
| 7 | Signer service, policy engine, router allowlist — no money | | — |
| 8 | **First real swap, ~$20, one wallet** | | **owner: approval to spend** |
| 9 | Deposit, withdrawal, and the attack suite that proves it refuses | | — |
| 10 | Pool prices, Chainlink referee, cost meter, staggered cadence | | — |
| 11 | Marketplace — tx-hash verification | | — |
| 12 | User-created agents, public signup | | **owner: legal answer on the US exclusion** |

---

## Phase 1 — Decisions and document corrections *(done)*

Ten decisions written down with their reasoning, so they can be revisited
deliberately rather than discovered as hidden assumptions:
[on-chain-direction.md](./on-chain-direction.md). The go/no-go evidence is
recorded in the repository rather than in a link:
[go-no-go-stock-tokens.md](./go-no-go-stock-tokens.md).

`architecture.md` corrected in six places. The important one: §2.7 and §10 both
stated the chain was permissioned and that ARCANA could not deploy contracts.
**That was never true**, and §10's entire deposit-address design exists because
of it.

**Verified by:** no claim of a permissioned chain survives in the repository;
every superseded section names what replaces it and why.

## Phase 2 — Chain guard *(done)*

`infra/alerting/arcana-chain-guard.mjs`, every four hours, watching the things
the issuer controls: the beacon's `implementation()` (**the one that matters**),
`paused()`, the routed pool's `liquidity()`, and — from phase 8 —
`isBlocked()` for each ARCANA wallet. Alerts go through the existing
`arcana-notify.sh`.

Written as a script beside the other monitors rather than as a Go service,
because that is where an operator looks and because it could then be tested
against the live chain immediately. Its baseline is committed to git, not stored
in the database: a monitor that remembers what it last saw adopts a change as
normal and stays silent at the one moment it existed to speak.

**Verified:** `infra/verify/chain-guard-verify.sh`, ten cases against the live
chain with drift injected through test hooks. The case that matters: a single
forced implementation change alarms on **all nine tokens at once**, because they
share one beacon — which is exactly what a real upgrade would look like.

Two failures found while building it, both by running the suite repeatedly
rather than once: a fallback RPC that served `eth_chainId` and refused
`eth_call`, and a missing retry that turned one dropped connection into a
false "monitor fault". Both are written up in
[alerting.md](./alerting.md#layer-3--the-chain-guard).

Also fixed on the way: `install.sh` copied nine timer files and enabled five.
The four left disabled were backup, backup-verify, tick-watchdog and this guard.

## Phase 3 — Infrastructure cleanup

Kafka and Redis are both scaffolded and **neither is used**: no client library
in any of the four `go.mod` files or three `package.json` files, no producer, no
consumer, no cache. Services talk over HTTP; batches run on systemd timers.

Turn both off in `infra/docker/docker-compose.yml`, measure RAM before and after
on the 2 GB VPS, and record the number.

**Verified:** all six services `active`, all six `/healthz` returning 200, and
the measured result recorded in [capacity.md](./capacity.md): RAM used 1279 MB
→ 619 MB, swap 1175 MB → 442 MB. Nearly 1.4 GB of pressure removed from a
1963 MB host, for components with no clients.

## Phase 4 — Retire what the change kills

Delete or clearly archive, each with a note saying what replaced it:

- `services/market-data/internal/session/` — trading-day resolution
- vendor-as-calendar, `ErrMarketClosed`, the `/session/expected` endpoint
- `infra/alerting/arcana-tick-watchdog.sh` and its timer
- `services/decision-engine/internal/engine/strategy.go` — keeping
  `RiskLimits` and `buyableQty()`, which become the policy engine
- `ExecuteManual()` and the `human` strategy path
- `services/arca-service/src/payments/` — the whole §10 subsystem, its two
  timers, and the `deposit_addresses` machinery

**Nothing that holds a record is deleted.** Retired agents, human participants,
Season 1 and every decision ever recorded stay exactly where they are.

**Verified by:** the services build and boot with the code gone; no timer
references a removed unit; `docs/data-resets.md` gains an entry saying what was
removed and why.

## Phase 5 — `MarketIndexService`

`load()` makes **one HTTP round trip per snapshot, across every snapshot ever
recorded**, behind a 60-second in-process cache, inside the service that answers
web requests. At ~250 snapshots a year it costs 854 ms. Under continuous trading
it is thousands, and four consumers each trigger it.

**This breaks when the cadence changes, before a single agent is added.** Fix:
read prices from Postgres/object storage in one pass, cache the derived index
rather than the raw snapshots.

**Verified by:** the same Autopsy response, measured against the current 854 ms,
with a synthetic snapshot count an order of magnitude larger.

## Phase 6 — The decider

A `Decider` interface with two implementations: the existing deterministic
strategies (as a reference to diff against) and an LLM decider. Provider-agnostic
— base URL, model id, key — so changing model is configuration, not surgery.
`deepseek-flash` first.

Every decision records prompt hash, raw response, model id and version. Every
refusal state from the direction doc is implemented and recorded.

**Still on virtual money.** The point of this phase is that the pipeline, the
scoring and the evidence trail work before anything is at stake.

**Verified by:** running a season on virtual capital with the LLM decider; the
score still computes; and a deliberately broken provider produces
`llm_unavailable` rows in the log rather than a gap in the record.

## Phase 7 — The signer

A separate process, its own systemd unit, its own Linux user, its own
`.env` at mode 600, bound to `127.0.0.1`. It holds the keys and **accepts only
a fixed set of transaction shapes**: `approve` to an allowlisted router, a swap
on an allowlisted router, tokens from the allowlist, to and from the agent's own
wallet. It refuses a raw transfer to an arbitrary address.

Keys: envelope encryption, one master key in a KMS, per-agent keys encrypted at
rest. **One KMS key, not one per wallet.**

Router allowlist is built from addresses observed working in production. The
canonical UniversalRouter address is explicitly **not** among them — it exists
on this chain but is not wired to its factory.

**No money yet.** The signer signs against a wallet with nothing in it.

**Verified by:** an attempt to sign a raw transfer to an outside address is
refused, and no signature is produced. Proven by a test that mounts the attack,
not by reading the code.

## Phase 8 — The first real swap ⛔ *needs the owner*

One wallet, roughly **$20**, one swap on a 5 bp pool, end to end: decision
recorded, transaction signed, receipt read back, NAV read from the chain,
reconciliation confirming the database matches the chain.

**This is the phase that spends money, and it will be raised before it is
spent** — the amount, the pool and the moment.

**Verified by:** a transaction hash that succeeded, *and* a deliberate failure
— RPC pulled, LLM response corrupted — proven to produce a refusal rather than a
trade.

## Phase 9 — Deposit, withdrawal, and proving the gate refuses

Withdrawal to the creator's registered wallet only, never an address from the
request body. Manual approval. Daily caps. A withdrawal nonce consumed in the
same transaction as the record insert.

Then the part that matters: **an attack suite as a deliverable of its own.** For
each check, a test that mounts the attack and asserts both that it was refused
*and that no transaction was signed*. Exits non-zero if any attack succeeds.

The precedent is already in the repository — `infra/verify/auth-verify.mjs` and
`arcana-restore-test.sh` both prove a property rather than assert it. This
project has shipped a nonce gate that never rejected a single replay because
what was tested was its existence, not its refusal.

Plus reconciliation: on-chain balance versus recorded balance, per agent, with a
mismatch logged at ERROR.

**Verified by:** the suite runs and every attack is refused.

## Phase 10 — Continuous operation

Pool prices as the execution source, Chainlink as the referee, the cost meter
that pauses an agent when its actual gas and fees cross the budget, per-agent
staggered cadence, and the rebalance-band filter that skips inference when
nothing moved.

**Verified by:** a week of continuous operation with no missed cycles, the cost
meter proven to pause an agent by driving one past its budget, and
`price_implausible` proven to fire by feeding a deviating price.

## Phase 11 — Marketplace

Buyer transfers to the creator directly and submits the transaction hash.
Verification against the chain: exists, confirmed, amount matches, recipient is
that listing's creator.

**Verified by:** a replayed hash is refused; a hash for a real transfer to the
wrong recipient is refused; a failed verification is logged at ERROR with the
hash rather than swallowed.

## Phase 12 — Users ⛔ *needs a legal answer*

Template-based agent creation, public signup.

**Blocked, and not by engineering.** The US exclusion on Stock Tokens is a
product geofence in Robinhood's app, not enforced on-chain. Nothing stops ARCANA
technically, which is exactly the problem: operating outside an issuer's intended
distribution while holding other people's funds is a question that needs a real
answer, and it is not one for me to give.

---

## What is still waited on, and what it blocks

| Item | Blocks | Note |
|---|---|---|
| `AUTH_ADMIN_WALLETS` | phase 9 | withdrawal approval has no owner until this is set — it went from convenience to control |
| healthchecks.io ping URL | phase 10 | under continuous operation there is no "market closed" excuse; a silent stop is always a fault |
| Cloudflare R2 credentials | phase 8 | backups now protect a record that maps to real money. **Key material is a separate requirement R2 does not solve** — it must not sit beside the database dump behind the same access path |
| `MARKET_VENDOR_API_KEY` | nothing | **confirmed no longer a blocker.** Prices come from the pool; Chainlink referees. Polygon keeps one narrow use — backfilling pre-launch history for DNA and Autopsy depth — and loses the redistribution-licence problem, since the leaderboard no longer publishes vendor closes |

None of the four blocks phases 2 through 7.
