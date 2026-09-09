# $ARCA Entitlements (gating)

Which actions are gated on holding $ARCA, where each gate sits, and — most
importantly — how to tell a *verified* entitlement from one that merely passed
because nothing was checked.

Implemented in `services/arca-service/src/entitlements/` (the authority) and
`services/agent-service/src/entitlements/` (the client at each gate point).

---

## Status today: wired, not enforcing

**The $ARCA token has not launched.** `ARCA_TOKEN_ADDRESS` and `ARCA_RPC_URL`
are deliberately empty in production, so no balance can be read and **every
entitlement check passes**.

That is the correct behaviour — operations must keep working — and it is the
single most dangerous thing about this feature. A gate that waves everyone
through while looking like a gate is worse than no gate at all, and this
codebase has already been bitten by exactly that: `activate()` carried a
docstring claiming it verified a CREATE entitlement while verifying nothing,
and §2.7 promised a gating layer that did not exist.

So every response says how it was reached:

```json
{
  "action": "create",
  "allowed": true,
  "reason": "gating_inactive_token_not_launched",
  "balance_checked": false,
  "required": null,
  "balance": null,
  "note": "The $ARCA token is not configured, so no balance was read. This is a pass by default, not a verified entitlement."
}
```

`balance_checked` is the field that matters. **`allowed: true` with
`balance_checked: false` is not an entitlement** — it is the absence of one.

The boot log says the same thing, alongside the four warnings that already
describe the payment features:

```
WARN [EntitlementService] $ARCA gating INACTIVE: ARCA_TOKEN_ADDRESS / ARCA_RPC_URL
not set — every entitlement check passes WITHOUT balance verification.
```

## Gated actions

§2.7 names seven. Each has an env threshold, all unset — the numbers have not
been decided:

| Action | Threshold env | Gate point | Wired |
|---|---|---|---|
| `create` | `ARCA_GATE_CREATE` | `POST /v1/agents/:id/activate` | ✅ |
| `compete` | `ARCA_GATE_COMPETE` | `POST /v1/competitions` (per participant) | ✅ |
| `evolve` | `ARCA_GATE_EVOLVE` | `POST /v1/agents/:id/evolve` | ✅ |
| `access` | `ARCA_GATE_ACCESS` | — | check exists, no call site yet |
| `marketplace` | `ARCA_GATE_MARKETPLACE` | — | check exists, no call site yet |
| `passport` | `ARCA_GATE_PASSPORT` | — | check exists, no call site yet |
| `premium_arena` | `ARCA_GATE_PREMIUM_ARENA` | — | Premium Arena is unbuilt |

The last four are answerable but nothing calls them. Listed as unwired rather
than quietly omitted — that is the distinction this whole document exists to
preserve.

### Why COMPETE is checked at registration, not per tick

A tick is the platform running an agent it already admitted. Re-checking every
minute would put an external HTTP call inside the competition loop and let an
arca-service outage halt a running season. After launch, the gate applies to
entry; agents already competing are unaffected.

## Decision rules, in order

1. **Token not configured** → `allowed`, `gating_inactive_token_not_launched`,
   no balance read.
2. **No threshold for this action** → `allowed`,
   `gating_inactive_no_threshold_configured`, no balance read. Gating can be
   live for some actions and dormant for others.
3. **No linked EVM wallet** → `denied`, `no_wallet_linked`. Denied because the
   entitlement *cannot be established*, not because it failed — the note says
   so, since the two deserve different remedies.
4. **Balance read** → `balance_meets_threshold` or `balance_below_threshold`,
   with both the balance and the requirement in the response.

The order matters: the "gating is off" cases are answered **before** the wallet
is validated, so a missing wallet cannot block operations while there is nothing
to check anyway. After launch, a creator without `creators.wallet_address` is
blocked — one seeded creator (`algo_trader`) currently has none.

## When arca-service is unreachable

The caller returns **502**, in the §8 error shape:

```json
{"error": {"code": "entitlement_check_unavailable",
           "message": "Could not verify the 'create' entitlement: ... The request was neither allowed nor denied.",
           "trace_id": "..."}}
```

Not fail-open, which would grant an entitlement nobody checked. Not
fail-closed, which would tell a paying user they lack a right they may well
hold. Both are lies wearing a clean response. This is the same correction made
earlier to the marketplace's `hasAccess`.

## No `arca_accounts` table

An entitlement is "does this wallet hold enough $ARCA" — a live chain read, not
stored state. A cached balance introduces a staleness mode where a gate grants
or denies on fiction, and a second version of the truth that can disagree with
the chain. `GET /v1/arca/accounts/:user_id` is served from the same live read.

A table earns its place when there is something the chain cannot answer —
staking, or grants that are not balance-derived. Not before. (Note: contrary to
an earlier assumption, `arca_accounts` is **not** in architecture.md §7.)

## API

```
GET /v1/arca/entitlements/check?user_id=<wallet>&action=<action>
GET /v1/arca/accounts/<wallet>
```

`user_id` is an EVM wallet address: a token balance attaches to a wallet, and
that is the only identity a balance can be read for.

## Verified behaviour

Against a local chain with `ARCA_GATE_CREATE=100`, `ARCA_GATE_EVOLVE=500`:

| Case | Result |
|---|---|
| wallet holding 1,000,000 | `allowed`, `balance_meets_threshold`, `balance_checked: true` |
| wallet holding 0 | `denied`, `balance_below_threshold`, balance `0`, required `100` |
| no wallet supplied | `denied`, `no_wallet_linked`, `balance_checked: false` |
| `compete` (no threshold set) | `allowed`, `gating_inactive_no_threshold_configured` |
| arca-service stopped | caller returns `502 entitlement_check_unavailable` |

---

## What is deliberately not here

- **Enforcement.** Thresholds are unset and the token is unlaunched. Turning
  gating on is a go-live step: see [arca-go-live.md](./arca-go-live.md).
- **Staking.** §2.7 mentions balance; staking would need state the chain cannot
  answer, and a table to hold it.
- **The remaining four call sites.** `access`, `marketplace` and `passport`
  answer correctly but nothing asks them; `premium_arena` has no feature to
  gate.
- **Caching.** Every check is a live read. Fine at current volume; a gate on a
  hot path would need a cache with a deliberately short TTL and the same
  honesty about staleness.
