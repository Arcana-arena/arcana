# $ARCA Go-Live Checklist

What to do the day the $ARCA token actually launches, in order. Everything in
the payment path is built and verified end-to-end against a local chain
simulator, but it is deliberately inert: five environment variables are empty,
and every feature that moves funds refuses to start without them.

This file exists so that moment is a checklist, not an improvisation.

Related: [scheduling.md](./scheduling.md) (the timers), architecture.md §10
(the design these steps implement).

---

## Before you touch anything

Confirm you have all five values below and the two things the design cannot
supply for you: the **KMS/HSM** holding the wallet keys, and a **funded
treasury wallet**. If either is missing, stop — do not fill in a placeholder to
"see if it works". The whole point of the empty env is that a half-configured
payment path refuses to run instead of half-running.

---

## 1. Fill the five variables

All live in `/home/ubuntu/arcana/services/arca-service/.env` (mode `600`, never
committed). Restart is required for each — they are read once at boot.

| Variable | Source | Notes |
|---|---|---|
| `ARCA_TOKEN_ADDRESS` | the deployed $ARCA ERC-20 contract | Must be the real address. Never a test token, never guessed — the listener refuses to run without it precisely so no placeholder can slip through. |
| `ARCA_RPC_URL` | Robinhood Chain RPC gateway | The internal project gateway (§10.2). Read-only access is all that is needed for the listener. |
| `ARCA_CHAIN_ID` | Robinhood Chain | Not recorded anywhere in this repo. The code falls back to `31337` (anvil) — **wrong for production**, and only harmless while payouts are disabled. Set it before the first payout. |
| `ARCA_MASTER_PRIVATE_KEY` | **KMS/HSM** | BIP-32 master seed for deriving per-subscription deposit addresses. §10.6 calls this the most critical security point in the entire design: it controls every deposit address ever issued. It must arrive from the secret manager at deploy time and never be written to a file that outlives the process, never committed, never logged. |
| `ARCA_TREASURY_PRIVATE_KEY` | **KMS/HSM** | The operational wallet that sends creator payouts. Separate key from the deposit master — compromise of one must not imply the other. |

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
| `ARCA_GATE_ACCESS`, `ARCA_GATE_MARKETPLACE`, `ARCA_GATE_PASSPORT`, `ARCA_GATE_PREMIUM_ARENA` | answerable, no call site yet |

Before setting any of them, confirm every creator who should keep operating has
a `creators.wallet_address`: without one the check denies with
`no_wallet_linked`, and at least one seeded creator has no wallet today.

Optional, already sane by default: `ARCA_CONFIRMATIONS` (12),
`ARCA_TOKEN_DECIMALS` (18 — **verify against the real token**, it is a
documented assumption), `ARCA_DEPOSIT_TTL_HOURS` (24),
`ARCA_POLL_INTERVAL_MS` (15000), `ARCA_AUDIT_INTERVAL_MS` (300000),
`ARCA_GRACE_HOURS` (48), `SUBSCRIPTION_DAYS` (30).

## 2. Fund the treasury wallet

It needs **both**:
- enough **$ARCA** to cover creator shares of everything collected, and
- enough **native gas** for one transfer per creator per payout run.

The payout batch checks gas and skips loudly rather than failing halfway, but a
skipped payout is still a creator who was not paid.

## 3. Restart and read the boot log

```bash
sudo systemctl restart arcana-arca.service
journalctl -u arcana-arca.service -n 30 --no-pager
```

The five `WARN` lines that have been there since day one — four payment ones
plus ` gating INACTIVE` — **must now be gone**, replaced by:

```
payment listener started (poll 15000ms, confirmations=12, audit 300000ms)
```

If any "disabled" warning survives, that variable did not take effect. Fix it
before going further — do not proceed on the assumption that it is cosmetic.

## 4. Verify before opening subscribe to real users

Do these in order. Steps 1-4 involve real money on a permissioned chain; there
is no undo.

1. **Entitlement check responds**
   `curl 'http://localhost:3004/v1/arca/access?userWallet=0x...&listingId=...'`
   → `{"access":false}` for an unknown wallet.
2. **Deposit address generation works**
   `POST /v1/arca/deposit-address` returns an address, `expected_amount`, and
   `expires_in`. Confirm the row in `deposit_addresses` has a **non-null
   `created_at_block`** — that column is what keeps the listener's scan from
   starting above a payment (§10.2). If it is null, the chain was unreadable
   and the address should never have been issued; treat it as a blocker.
3. **One real end-to-end payment, small, from a wallet you control.**
   Transfer exactly `expected_amount`, then watch:
   `journalctl -u arcana-arca.service -f`
   Expect `scanning blocks A..B` → `payment recorded` → `granted access`, and
   the subscription active with the right `expires_at`. Then confirm the
   marketplace agrees: `GET /v1/marketplace/listings/{id}/access`.
4. **One real payout**, with a single small `payment_event` pending:
   `sudo systemctl start arcana-arca-payout.service`
   `journalctl -u arcana-arca-payout.service -n 20 --no-pager`
   Expect `payout: ok {"processed":1,"paid_out":1,...}` — not the SKIPPED line.
   Verify the creator's on-chain balance actually moved and `creator_payouts`
   has the tx hash.
5. **Run it again immediately.** It must report `processed:0` and move nothing.
   Idempotency is what stands between a retry and paying a creator twice.
6. **Reminder job**: `sudo systemctl start arcana-arca-reminder.service`
   → `reminder: ok {...}`, exit 0.
7. **Audit is clean**: `curl -X POST http://localhost:3004/internal/v1/payments/listener/audit`
   → `stranded: 0`. Any non-zero value means a user paid and was not credited;
   resolve it before opening the doors.
8. **Gating actually gates.** After setting a threshold, prove the check reads a
   balance rather than passing by default:
   `curl 'http://localhost:3004/v1/arca/entitlements/check?action=create&user_id=<a wallet you control>'`
   → the response must show `"balance_checked": true` with a real `balance` and
   `required`. If it still says `gating_inactive_*`, gating is not on, whatever
   the env file says. Then confirm a wallet below the threshold is denied with
   `balance_below_threshold` — a gate that never refuses anyone has not been
   tested.

## 5. Then open subscribe

Only after every step above passes. From this point the daily timers carry it:
reminder at 09:00 UTC, payout at 10:00 UTC.

---

## What to watch in the first week

- `journalctl -u arcana-arca.service | grep STRANDED` — must stay empty. A hit
  means funds arrived and access was not granted; it names the address, user,
  and listing.
- `arcana-arca-payout.service` should report `ok`, never `SKIPPED`, once the
  env is filled. A SKIPPED line after go-live means a variable was lost —
  probably a restart that did not pick up the secret.
- Deposits stuck at `pending` well past their TTL that the audit has **not**
  retired: retirement requires a zero balance, so a pending row that refuses to
  retire is one that holds funds.
- `ARCA_TOKEN_DECIMALS` — if amounts look off by powers of ten, this is the
  first thing to check. It is an assumption, not a verified fact.
