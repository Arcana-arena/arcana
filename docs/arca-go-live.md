# $ARCA Go-Live Checklist

> **Rewritten 2026-09-11.** The previous version of this file was a live
> hazard, and the history is worth keeping because the shape of the mistake
> recurs.
>
> It was a written procedure instructing an operator to fill in
> `ARCA_MASTER_PRIVATE_KEY`, `ARCA_TREASURY_PRIVATE_KEY`, `ARCA_TOKEN_ADDRESS`,
> `ARCA_RPC_URL` and `ARCA_CHAIN_ID`, then to restart and watch for
> `payment listener started`. Those five empty variables were, for a while, the
> *only* thing keeping the abandoned §10 payment path inert. Following the
> steps would have activated a model this project had already discarded —
> routing real user money into ARCANA-derived deposit addresses, sweeping it to
> a treasury, splitting it off-chain — and every step would have reported
> success while doing it.
>
> **A retirement that a document can undo is not a retirement.** On 2026-09-11
> the code went: `HdWalletService`, `DepositAddressesService`,
> `PaymentListenerService`, the deposit-address route, the two listener routes,
> and the marketplace `subscribe` route that called them. There is now nothing
> for those variables to configure. The steps below are what is left, and all
> of it is real.

The marketplace is **P2P with no fee**: the buyer transfers straight to the
creator's wallet and submits the transaction hash, which ARCANA verifies
against the chain. No deposit address, no treasury, no split, no contract. See
[marketplace-payments.md](./marketplace-payments.md) and
[on-chain-direction.md §g](./on-chain-direction.md#g-marketplace--tx-hash-confirmation).

So "go-live" now means one thing only: **the $ARCA token exists and its address
is known.**

**And that is one system, not two, as of 2026-09-11.** The marketplace used to
be on this list and is not any more: it settles in **USDG**, which exists on
chain today, through a separate `MARKETPLACE_PAYMENT_TOKEN`. The verification
had always been driven against real USDG transfers, so nothing had to be
re-proven to make the switch — the payment path was already tested against
exactly this token.

What still waits here is **entitlement gating**: what a creator must HOLD to
create, compete, evolve or enter a premium arena. That is a different question
from what a buyer PAYS, and the two now have different variables so they cannot
be swapped by accident.

Related: [scheduling.md](./scheduling.md) (the timers), migration 0027
(`payment_claims`), migration 0028 (what was retired).

---

## What is actually blocked, and by what

| Blocked | Blocked by | Not blocked by |
|---|---|---|
| ~~Marketplace payment claims~~ | **NOTHING — unblocked 2026-09-11.** Settled in USDG, which exists on chain. The verification had already been driven against real USDG transfers, so nothing had to be re-proven; the suite is now 26/26 against the production token itself | — |
| $ARCA entitlement gating | `ARCA_TOKEN_ADDRESS` **and** a per-action threshold | — |

Note what is **not** on that list any more. Token decimals used to be, as a
"documented assumption of 18". It is not a blocker and never should have been
one: `decimals()` is a view function on the token, so whatever token is
configured, the chain says. The value is read from the token at the moment it
is needed, cached for the process, and there is deliberately **no fallback** —
a token that cannot be asked is a token that cannot be verified against, which
answers `503 payment_verification_unavailable` rather than guessing. Guessing
18 where the truth is 6 scales every price check by a factor of a trillion,
silently.

---

## 1. Fill three variables

All live in `/home/ubuntu/arcana/services/arca-service/.env` (mode `600`, never
committed). Restart is required — they are read once at boot.

| Variable | Source | Notes |
|---|---|---|
| `ARCA_TOKEN_ADDRESS` | the deployed $ARCA ERC-20 contract | Must be the real address. Never a test token, never guessed. **GATING ONLY since 2026-09-11** — the marketplace settles in USDG via `MARKETPLACE_PAYMENT_TOKEN` and no longer waits for this. While it is empty every entitlement check passes WITHOUT reading a balance, and says so in its response. |
| `ARCA_RPC_URL` | Robinhood Chain RPC | Read-only access is all that is needed. |
| `ARCA_CHAIN_ID` | Robinhood Chain | **4663** (`0x1237`), measured. The code falls back to `31337` (anvil), which is wrong for production. |

No private key appears in this table, and that is the point. Claim verification
**reads** the chain. ARCANA holds no wallet in the payment path at all — the
money never touches it.

(Custodial *trading* wallets are a different subsystem with its own key
custody; see [signer.md](./signer.md). Nothing here funds or unlocks them.)

### Entitlement gating thresholds

Gating stays inactive until BOTH the token is configured and a threshold is set
per action. Both halves matter: with `ARCA_TOKEN_ADDRESS` filled but
`ARCA_GATE_CREATE` unset, CREATE still passes without reading a balance — and
says so.

| Variable | Gates |
|---|---|
| `ARCA_GATE_CREATE` | activating an agent |
| `ARCA_GATE_COMPETE` | registering into a competition |
| `ARCA_GATE_EVOLVE` | creating a new agent version |
| `ARCA_GATE_PREMIUM_ARENA` | entering a Premium Arena — a season with `access_tier='premium'`. Applied **in addition to** `ARCA_GATE_COMPETE`, so the effective requirement is the larger of the two. See [premium-arena.md](./premium-arena.md). |
| `ARCA_GATE_ACCESS`, `ARCA_GATE_MARKETPLACE`, `ARCA_GATE_PASSPORT` | answerable, no call site yet |

Before setting any of them, confirm every creator who should keep operating has
a `creators.wallet_address`: without one the check denies with
`no_wallet_linked`, and at least one seeded creator has no wallet today.

Sane by default, and now genuinely optional:
`ARCA_CLAIM_MIN_CONFIRMATIONS` (600 — **a block count on a 0.100 s/block
chain, so about 60 seconds**; the old `ARCA_CONFIRMATIONS=12` was Ethereum's
convention and meant 1.2 seconds here), `ARCA_CLAIM_MAX_AGE_HOURS` (24),
`ARCA_GRACE_HOURS` (48), `SUBSCRIPTION_DAYS` (30).

## 2. Restart and read the boot log

```bash
sudo systemctl restart arcana-arca.service
journalctl -u arcana-arca.service -n 30 --no-pager
```

Expect the ` gating INACTIVE` warning to be gone, and the claim service to
state its settings in wall-clock terms:

```
payment claims: 600 confirmations (~60s at 0.100 s/block), max age 24h
```

If a "disabled" warning survives, that variable did not take effect. Fix it
before going further — do not proceed on the assumption that it is cosmetic.

## 3. Verify before opening claims to real users

Step 2 involves real money on Robinhood Chain (which is **permissionless** —
the "permissioned" claim that shaped the original design was never true). There
is no undo.

1. **The token answers.** Confirm the boot log's `decimals=` line names the
   value you expect from the deployed contract. If the two disagree, stop: one
   of them is not the token you think it is.
2. **One real end-to-end claim, small, from a wallet you control.** Transfer at
   least the listing price to the creator's wallet, wait ~60 seconds, then
   `POST /v1/marketplace/listings/{id}/claim-payment` with the hash. Expect the
   grant, then confirm `GET /v1/marketplace/listings/{id}/access` agrees.
3. **Claim it again.** It must fail `tx_already_claimed` and grant nothing.
   Replay is the primary attack surface here — a transaction hash is public the
   moment it is mined — and `UNIQUE (tx_hash)` is what stops it. A guard that
   has never refused anyone has not been tested.
4. **Claim someone else's payment.** Find any transfer between two other
   wallets and submit it. It must fail `sender_is_not_claimant`.
5. **Reminder job**: `sudo systemctl start arcana-arca-reminder.service`
   → `reminder: ok {...}`, exit 0.
6. **Gating actually gates.** After setting a threshold, prove the check reads a
   balance rather than passing by default:
   `curl 'http://localhost:3004/v1/arca/entitlements/check?action=create&user_id=<a wallet you control>'`
   → the response must show `"balance_checked": true` with a real `balance` and
   `required`. If it still says `gating_inactive_*`, gating is not on, whatever
   the env file says. Then confirm a wallet below the threshold is denied with
   `balance_below_threshold`.
7. **Premium arenas gate.** Only if `ARCA_GATE_PREMIUM_ARENA` is set. Check the
   arena reports itself as enforcing:
   `curl localhost:3001/v1/seasons/<premium season id>`
   → `access.enforced` must be `true` with a real `required_arca`. `false` means
   the gate still admits everyone; `null` means arca-service was unreachable and
   nothing was read. Then register an agent whose creator holds less than the
   threshold: it must fail `403 entitlement_denied_premium_arena`, naming the
   arena. Confirm a standard season still admits the same agent — the premium
   threshold must not have leaked onto every arena.

## 4. Then open claims

Only after every step above passes. From this point the daily timer carries the
subscription lifecycle: reminder at 09:00 UTC.

---

## What to watch in the first week

- `journalctl -u arcana-arca.service | grep payment_verification_unavailable` —
  a steady trickle means the chain is unreadable and buyers are being told
  "not checked" rather than being wrongly refused. That is the designed
  behaviour, but a *sustained* trickle is an RPC problem, not a payments one.
- `SELECT count(*) FROM payment_claims WHERE created_at > now() - '1 day'::interval;`
  against the number of new subscriptions. They should match exactly: a claim
  is the only way a subscription is now granted.
- Any claim rejected `insufficient_amount` where the buyer insists they paid in
  full. One case is a user error; a pattern means the decimals read from the
  token disagrees with what the listing price assumes.
