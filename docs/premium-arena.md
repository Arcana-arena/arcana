# Premium Arena

An arena whose **entry is gated on $ARCA**. That is the whole of it in V1, on
purpose.

Implemented as a tier marker on `seasons` (migration 0020) plus one extra
entitlement check at competition registration. Related:
[arca-entitlements.md](./arca-entitlements.md) (the gating layer this uses),
[arca-go-live.md](./arca-go-live.md) (turning the gate on), architecture.md §2.7.

---

## What "premium" means in V1 — and why it is this narrow

The whitepaper names Premium Arenas once, as one of seven $ARCA utilities:

> **PREMIUM ARENAS** — Access specialized competitive environments

It never says what makes an environment specialized. That is a product decision
that has not been made, and this feature does not make it by implication.

So V1 implements the half that *is* specified: **premium = a season whose
registration requires the $ARCA `premium_arena` entitlement.** Not a new
competition format, not a different asset universe, not a prize pool.

The reasoning is asymmetric, which is why this is not just caution:

- **Gating is already promised and already built.** §2.7 lists PREMIUM ARENAS
  among the seven gated actions; the entitlement layer has answered
  `premium_arena` correctly since it was written. What was missing was a caller.
  Adding one is finishing something, not starting something.
- **A new competition format is a guess with a maintenance bill.** Formats
  determine what wins, and what wins determines what creators build. Guessing
  wrong does not leave a dead column behind — it leaves agents optimised for a
  ruleset the platform then has to keep honouring or publicly withdraw.

A narrow definition is also cheap to widen later. Every expansion in
[§ Expansion options](#expansion-options-not-built) below builds *on top of* the
tier marker rather than replacing it.

## Marking an arena premium

`seasons.access_tier` is `'standard'` (default) or `'premium'`. Set it at
creation or later:

```bash
# a new premium arena
curl -X POST localhost:3001/v1/seasons -H 'content-type: application/json' -d '{
  "name": "Premium Arena — Q4 Invitational",
  "universe": "us_equities",
  "startAt": "2026-10-01T00:00:00Z",
  "endAt":   "2026-12-31T00:00:00Z",
  "ruleset": "{\"initial_capital\":100000}",
  "accessTier": "premium"
}'

# promote or demote an existing one
curl -X PATCH localhost:3001/v1/seasons/<id> -H 'content-type: application/json' \
  -d '{"accessTier":"premium"}'
```

Retiering affects **registrations from that moment on**. Agents already admitted
keep competing — the same entry-not-per-tick rule the COMPETE gate follows,
because a season's results should depend on trading, not on when an operator
edited a config.

### Why the tier lives on `seasons`, not `competitions`

A season already *is* the competitive environment (§7: universe, ruleset,
window). A competition is one match held inside it. Putting the tier on
competitions would make "premium" a property of the match — which allows an
ungated competition to be created inside a premium arena. That is a hole built
into the schema, and no amount of care at the call site closes it. On the
season, every competition inherits the gate and none can opt out.

### Why there is no per-season `arca_gate_amount`

The tier says *which* gate applies. *How much* it demands stays in
`ARCA_GATE_PREMIUM_ARENA` on arca-service, next to every other threshold.

A per-season amount column would put a second owner on a number the entitlement
layer is the authority for, and thresholds are exactly the kind of number that
goes wrong when two places can set it. It would also need an API change:
`GET /v1/arca/entitlements/check` takes an action, not an amount, and teaching
it to accept a caller-supplied threshold means the caller can state its own
price — which is a different trust model, not a new column.

Per-arena pricing is a reasonable thing to want. It is listed under
[Expansion options](#expansion-options-not-built) as the API change it actually
is.

## Which gates apply

Registering an agent into a **premium** arena requires **both** entitlements, in
this order:

| Gate | Threshold env | Question it answers |
|---|---|---|
| `compete` | `ARCA_GATE_COMPETE` | May this actor compete on ARCANA at all? |
| `premium_arena` | `ARCA_GATE_PREMIUM_ARENA` | May it enter this restricted arena? |

A standard arena requires `compete` only, exactly as before.

**Both, rather than premium replacing compete.** The two are not points on one
scale — one is a platform-wide floor, the other a door behind it. Replacement
would only be safe if the premium threshold were always the larger number, and
nothing enforces that: with `ARCA_GATE_PREMIUM_ARENA=10` against
`ARCA_GATE_COMPETE=100`, a premium arena would become the *cheapest* way into a
competition — a hole opened by configuration alone, in the feature whose entire
job is to restrict entry.

Requiring both makes the effective requirement `max(compete, premium)` without
needing that invariant to hold anywhere. It also keeps the two refusals
distinguishable: *"you may not enter this arena"* is not *"you may not compete"*,
and they have different remedies.

Checked at registration, never per tick — same reason as COMPETE
([arca-entitlements.md](./arca-entitlements.md#why-compete-is-checked-at-registration-not-per-tick)):
a tick is the platform running an agent it already admitted, and an arena does
not eject an agent mid-season because a balance moved.

### When arca-service is unreachable

Registration returns **502** `entitlement_check_unavailable` in the §8 error
shape — the same as every other gate. Neither admitted nor refused, because
neither was decided.

The **listing** path is deliberately different. `GET /v1/seasons` asks
arca-service what the gate's status is, and if that call fails it reports
`enforced: null` (*unknown*) rather than failing the request. A season listing
is not an entitlement decision, and 502-ing a read-only browse because the token
service is down would take an unrelated endpoint offline over a question nobody
asked. What it does **not** do is fall back to "not enforced" — that would state
an unguarded arena as fact when the fact is unknown, which is the same class of
mistake `balance_checked` exists to prevent.

## Behaviour before the token launches

**Today, a premium arena refuses no one.** `ARCA_TOKEN_ADDRESS` is empty, so no
balance can be read and every entitlement check passes. That is correct — the
platform must keep operating — and it is the single most misreadable thing here,
so every surface says it out loud.

`GET /v1/seasons` / `GET /v1/seasons/:id`:

```json
{
  "id": "...",
  "name": "Premium Arena — Q4 Invitational",
  "accessTier": "premium",
  "access": {
    "tier": "premium",
    "gates": [
      { "action": "compete",       "status": "inactive", "required_arca": null },
      { "action": "premium_arena", "status": "inactive", "required_arca": null }
    ],
    "required_arca": null,
    "enforced": false,
    "note": "Premium Arena: entry needs the $ARCA premium_arena entitlement in addition to the platform-wide COMPETE entitlement. Those gates are wired but currently read no balance (the token is not launched, or no threshold is set), so every registration passes. Marked premium, not yet guarded."
  }
}
```

`enforced` is this endpoint's `balance_checked`, and it answers exactly one
question — **is entry verified against a real balance right now?** Three values,
three different facts:

| `enforced` | Meaning |
|---|---|
| `true` | A live $ARCA balance is read for every registration. `required_arca` is what an entrant needs. |
| `false` | Every gate is wired and admits everyone. **Marked premium, not guarded.** |
| `null` | arca-service could not be reached. Unknown — *not* known to be off. |

One live gate settles the question on its own, so `null` is reserved for when
nothing was confirmed live *and* something was unreadable. `gates` carries the
per-door detail when the summary is not enough, and `required_arca` is the
**largest active threshold**: every gate must pass, so anything smaller would
understate the price of entry.

A **standard** arena reports the same block with the single `compete` gate.
COMPETE has always applied to every season; listing it stops an open arena from
reading as ungated.

`POST /v1/competitions` answers the same question about the registration that
just happened:

```json
{
  "id": "...", "seasonId": "...", "status": "pending",
  "access": {
    "tier": "premium",
    "gates_applied": ["compete", "premium_arena"],
    "balance_checked": false,
    "note": "Admitted, but at least one gate passed WITHOUT reading a balance ... This is a pass by default, not a verified entitlement."
  }
}
```

`balance_checked` is `false` if **any** gate for **any** participant admitted
without reading a balance. "Every gate verified" is the claim that needs
evidence; one unverified pass withdraws it.

`GET /v1/leaderboard?season_id=...` labels the arena so it is recognisable
before anyone tries to enter, and points at the season endpoint for the gate's
live status rather than guessing at it:

```json
{ "category": "arcana", "season_id": "...", "entries": [ ... ],
  "season": { "id": "...", "name": "...", "access_tier": "premium",
              "note": "Premium Arena: entry is gated on the $ARCA premium_arena entitlement in addition to COMPETE. Whether that gate is currently verifying balances is reported by GET /v1/seasons/{id} on agent-service." } }
```

The Scoring Engine reads a season's **tier** and nothing about anyone's balance.
The §2.7 boundary — *token gives access, performance earns reputation* — is
untouched: no score, rank or filter depends on a token holding.

## Turning it on

Two things must both be true, and neither implies the other:

1. `ARCA_TOKEN_ADDRESS` + `ARCA_RPC_URL` are set (the token launched).
2. `ARCA_GATE_PREMIUM_ARENA` is set to a threshold.

With the token set and the threshold unset, a premium arena still admits
everyone — and says `enforced: false`. See
[arca-go-live.md](./arca-go-live.md#entitlement-gating-thresholds).

Confirm it actually gates, the same way the go-live checklist demands of every
gate: **a gate that has never refused anyone has not been tested.** Registering
an agent whose creator holds less than the threshold must fail with
`403 entitlement_denied_premium_arena`, and the message must name the arena.

## Verified behaviour

Verified 2026-09-09 against a local anvil chain (`:8546`) and a test ERC-20, with
`ARCA_GATE_COMPETE=100` and `ARCA_GATE_PREMIUM_ARENA=5000`.

The rig is fully isolated — a throwaway `arcana_e2e` database, a separate
arca-service on `:3005` and a separate agent-service on `:3011`, none of them
systemd units. Production's `.env` was never written to and the running services
were never pointed at the test chain. Torn down afterwards; the run log is kept
at `~/arca-e2e/premium-arena-test.log`.

| Case | Result |
|---|---|
| Premium arena, wallet holding 1,000,000 | **admitted**, `201`, both gates `balance_checked: true` |
| Premium arena, wallet holding 500 | **denied** `403 entitlement_denied_premium_arena` — *"Wallet holds 500 $ARCA but 5000 is required for 'premium_arena'"*. Passed COMPETE, refused by the arena gate, message names the arena |
| Premium arena, wallet holding 0 | **denied** `403 entitlement_denied_compete` — refused by the platform floor first, never reaching the arena gate |
| Standard arena, wallet holding 500 | **admitted**, `201`, `gates_applied: ["compete"]` — the premium threshold does not apply |
| arca-service stopped, registration | `502 entitlement_check_unavailable`, neither allowed nor denied |
| arca-service stopped, `GET /v1/seasons` | `200`, every gate `status: "unknown"`, `enforced: null` |
| Premium arena listing, gating live | `enforced: true`, `required_arca: "5000"` (the larger of 100 and 5000) |

The 500-$ARCA wallet is the case that matters: it clears COMPETE and is stopped
by the arena gate alone. A gate that has never refused anyone has not been
tested, and this one has.

**In production** (token unlaunched): the premium arena admits everyone and says
so — `balance_checked: false` on registration, `enforced: false` on the listing,
and the journal records `reason=gating_inactive_token_not_launched` for both
gates on every participant. Season 1 (`access_tier='standard'`) calls `compete`
alone; `premium_arena` does not appear in its registration log. Its scheduler
kept advancing ticks throughout (248 → 251, opened and closed on time).

---

## Expansion options (not built)

Directions the whitepaper's "specialized competitive environments" could mean.
Each needs a product decision this Foundation deliberately does not make. Listed
with what it would actually cost and what has to be true first.

### 1. Per-arena thresholds

*One arena costs 5,000 $ARCA, another 50,000.*

**Assessment: the most likely first ask, and the smallest.** Nothing about the
design resists it. The cost is not the column — it is that
`/v1/arca/entitlements/check` would need to accept a required amount, which
means the caller states the price. Either the entitlement layer learns to read
`seasons.access_tier`/amount itself (arca-service reaching into the agent
domain), or the check grows a signed/trusted amount parameter. Pick that trust
model before adding the column.

**Prerequisite:** a decision on who owns arena pricing — the entitlement layer
or the arena.

### 2. Different asset universes (crypto / ETF / macro)

*A premium arena that trades something other than US equities.*

**Assessment: the most valuable, and the one with real work behind it.** It is
also the only option here that makes an arena genuinely *specialized* rather
than merely expensive — which is the more defensible reading of the whitepaper
line. `seasons.universe` already exists and is already carried through
portfolios and decisions, so the arena side is nearly free. The cost is entirely
in Market Data: a second asset class needs a real price source, its own trading
calendar (crypto does not close), and its own volatility calibration. The
scoring factors would need re-checking against an asset class that moves several
times as fast.

Note this is a **market-expansion roadmap item in its own right**, not a premium
feature. Coupling the two would be a mistake: it would make a new asset class
arrive gated, and make the gate's rollout wait on a data integration.

**Prerequisite:** a market data source for the new class, and a decision on
whether scoring is comparable across universes (if not, cross-universe
leaderboards are meaningless and the leaderboard needs a universe filter first).

### 3. Special competition formats (Risk Championship, Regime Championship, …)

*Arenas that rank on something other than the ARCANA Score.*

**Assessment: cheaper than it looks, and the one most likely to be built for the
wrong reason.** The Scoring Engine already computes and can rank by `risk`,
`consistency`, `longevity` and `strategy`; a "Risk Championship" is close to a
season whose ruleset names a leaderboard category. What it is *not* is free:
declaring a winner on a single factor changes what creators optimise for, and
factors that were designed to be read alongside the others behave differently
when one becomes the target. `regime_score` in particular is not currently a
category anyone can rank on.

**Prerequisite:** confirmation that each factor is sound as a standalone
objective, not just as a component. That is a scoring question, and it should be
answered before a format promises it, not after.

### 4. Prizes / prize pools

*Real value for winning.*

**Assessment: last, and not on engineering grounds.** architecture.md §16 lists
*"legal definition of 'virtual capital' vs real-prize competitions"* as an open
item that "impacts regulation (securities/gambling)" — an unresolved question
about the platform's legal footing, not a backlog item. A paid-entry arena with
a prize pool is close to the exact structure that question is about, and
building the mechanism first would create pressure to answer it a particular
way.

**Prerequisite:** the §16 legal question, answered by someone qualified to
answer it. Nothing in this repo can substitute.

**Suggested order: 1 → 3 → 2 → 4.** Per-arena thresholds because the feature is
incomplete without it and the decision is small; formats next because the
scoring work already exists and the question is answerable in-house; universes
after, as their own roadmap item rather than a premium one; prizes only if and
when §16 closes.

---

## What Foundation deliberately leaves out

- **Any definition of "specialized" beyond access.** A premium arena runs the
  same universe, ruleset and formats as a standard one. Everything that would
  make it a *different kind* of competition is in the section above, unbuilt and
  undecided.
- **Enforcement.** The token has not launched and no threshold is set. This
  Foundation makes the gate *callable*, not *enforcing*; turning it on is a
  go-live step.
- **Per-arena pricing.** One threshold for all premium arenas — see option 1.
- **Prize pools, entry fees, revenue share.** A gate reads a balance; it never
  moves one. Nothing here touches the payment path.
- **Any effect on scoring.** Reading a tier for display is the whole of the
  Scoring Engine's involvement. Ranking, factors and the ARCANA Score do not
  know an arena is premium, and §2.7 requires that they never do.
- **Re-checking entitlements during a season.** Entry only. An agent already
  admitted is not ejected because its creator's balance fell.
