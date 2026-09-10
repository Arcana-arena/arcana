# Four things waiting on the owner

Each one is **prepared to the point where only the owner's part remains**. No
engineering work is left in any of them; what is left is a credential, an
authorisation, or a decision to spend.

Nothing here is a blocker for anything else. They are listed together because
they share that shape, not because they are related.

| | What is waited on | What is already done | What it unblocks |
|---|---|---|---|
| 1 | Google Drive authorisation | script, alarm, verification, retention | off-site backups |
| 2 | KMS decision + a new seed | interface, procedure, rotation steps | funding the first wallet |
| 3 | Approval to spend $10 | full procedure, allowlist, simulation | phase 8 |
| 4 | `AUTH_ADMIN_WALLETS` | guard, routes, refusals | operator actions |

---

## 1. Google Drive — off-site backups

**Waiting on:** one interactive `rclone config` on the VPS, which needs a
browser sign-in the owner has to perform.

### Already done

- `arcana-backup.service` runs daily at 02:00 UTC and works today, local-only,
  saying so loudly every run.
- **A failed upload is a failed backup.** The script `die`s and
  `OnFailure=arcana-alert@` turns it into an alert. Drive uses OAuth and a
  refresh token stops working on its own schedule — it expires, is revoked, or
  goes stale — and when it does, everything else keeps succeeding. The dump
  runs, the archive appears, local retention rotates, the log says "ok", and
  the only thing that stopped is the part that made the copy off-site.
- **The upload is verified, not assumed.** `rclone` exiting 0 says the transfer
  reported success; the script then asks the remote for the file and compares
  its size against the local archive. For a half-alive credential that
  difference is the whole question.
- The weekly copy is fatal too. It was `&& log ok` with no `else` — a silent
  weekly failure, on the copy that survives a fault nobody noticed for a week.

### The owner's part

```bash
sudo apt-get install -y rclone

# Interactive. Choose "drive". This is the step that needs a browser.
rclone config --config /home/ubuntu/arcana/.rclone.conf
chmod 600 /home/ubuntu/arcana/.rclone.conf      # secrets live HERE, never in a unit

sudo systemctl edit arcana-backup.service
#   [Service]
#   Environment=BACKUP_REMOTE=arcana-offsite:arcana-backups

sudo systemctl daemon-reload
sudo systemctl start arcana-backup.service
sudo journalctl -u arcana-backup -n 30 --no-pager   # expect "off-site copy ok and verified present"
```

### Then prove the alarm, before trusting it

A monitor that has never alerted is indistinguishable from one that cannot —
this repository has now produced that exact bug twice, most recently in the
decision watchdog, whose alert path was broken from the moment it was written.

```bash
# Break the token on purpose.
rclone config update arcana-offsite token '{}' --config /home/ubuntu/arcana/.rclone.conf
sudo systemctl start arcana-backup.service      # MUST exit non-zero and alert
# then restore the real token by re-running rclone config
```

A token whose expiry has never been handled is a token whose expiry is not
handled.

---

## 2. KMS, and replacing the phase-7 seed

**Waiting on:** the owner's choice between two KMS shapes, and a decision to
spend the small monthly cost. **Both are preconditions before the first wallet
is funded** — that was decided when option A was chosen.

### The shape matters more than the provider

| | KMS as a **signing service** | KMS as an **encrypted secret store** |
|---|---|---|
| Where the key lives | inside the module, never leaves | sealed on disk, unsealed into memory at boot |
| Plaintext seed on disk | none | none |
| In a stolen backup archive | nothing usable | nothing usable |
| Access logged and revocable | yes | yes |
| **Key export to the user** | **impossible** | works |

**Recommendation: the secret store.** The signing service buys custody the
platform is not entitled to. Phase 12 promises every user they can take
possession of their agent's key at any time, on the grounds that a wallet whose
owner can never hold the key is the platform's wallet with the owner's name on
it. The signing service breaks that promise in exchange for protecting against
a threat — someone extracting a key from memory on a host they already control
— that is strictly worse than the one option A actually carries, which is a
plaintext file. The secret store removes exactly that file.

This is the owner's call because it trades a product promise against a security
posture, and it costs money.

### Already done

`keys.Vault` is the interface the whole signer talks to. Swapping custody is
one new implementation and one line at boot; no handler changes. `Export` may
return `ErrExportUnsupported`, so an implementation that cannot export says so
at the call — to a caller that can tell the user — rather than the interface
quietly not offering something the product promised.

A compile-time assertion proves the file-backed keyring still satisfies it, so
a mismatch surfaces at build time rather than when the second implementation
arrives.

### Replacing the phase-7 seed

The seed on the host now was created during phase 7 to develop against. It has
never held money and never should. **Replace it before funding anything**, for
the same reason a test credential is never promoted: nobody can prove where it
has been.

Order matters. Derived addresses are a pure function of the seed, so a new seed
means **new addresses for every agent**. Doing this after funding would strand
funds at addresses nothing points at any more.

```bash
# 1. Confirm nothing is funded. Every agent wallet must read zero on chain.
#    If ANY balance is non-zero, stop: the rotation below abandons it.
docker exec arcana-postgres psql -U arcana -d arcana -tAc \
  "SELECT agent_id, address, key_custody FROM agent_wallets ORDER BY created_at"
#    ...then check each address on the explorer, or with eth_getBalance.

# 2. Back up first — the current seed is about to stop being reachable.
sudo systemctl start arcana-backup.service

# 3. Generate a new seed AS THE SIGNER USER, directly into place.
#    Never via a shell that logs, never through a file the app user can read.
sudo -u arcana-signer install -m 0400 /dev/null /etc/arcana/signer/master.key.new
openssl rand -hex 32 | sudo -u arcana-signer tee /etc/arcana/signer/master.key.new >/dev/null

# 4. Swap and restart.
sudo mv /etc/arcana/signer/master.key /etc/arcana/signer/master.key.retired
sudo mv /etc/arcana/signer/master.key.new /etc/arcana/signer/master.key
sudo systemctl restart arcana-signer
journalctl -u arcana-signer -n 20 --no-pager     # expect "signer ACTIVE"

# 5. Every derived wallet now has a NEW address. Clear the stale rows so they
#    are re-derived on next read. Imported wallets are NOT affected — their
#    keys are files, not derivations — so they are excluded.
docker exec arcana-postgres psql -U arcana -d arcana -c \
  "DELETE FROM agent_wallets WHERE provenance = 'derived'"

# 6. Prove it took: an agent's address must have changed.
node infra/verify/agents-verify.mjs

# 7. Only once everything above is green:
sudo shred -u /etc/arcana/signer/master.key.retired
```

Step 1 is not a formality. It is the whole reason this is done before funding
rather than after.

---

## 3. The first mainnet swap — $10

**Waiting on:** the owner's approval to spend. **$10**, set by the owner on
2026-09-11.

### Already done

- **SwapRouter02 verified by execution, not documentation.** `eth_getCode`
  returns 24,497 bytes; `factory()` returns the same factory the pools came
  from, derived independently, so the two agree without either being told the
  other; the bytecode carries `exactInputSingle` (`0x04e45aaf`), the selector
  the signer builds.
- **The exact calldata the signer produces has already been executed** against
  live pool state via `eth_call`, returning a real fill of 0.308992 AAPL for
  100 USDG — and a control with an impossible minimum reverted, so the
  simulation is not a no-op.
- The signer refuses anything not on the allowlist, and refuses a paused or
  blocked token by reading the chain before signing.
- Pool prices are read and refereed against Chainlink every tick.

### The procedure, in order

Nothing here is discretionary. Each step exists because skipping it makes the
next one unreadable.

```bash
# 1. Choose the agent and confirm its wallet. Note the address.
curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3001/v1/agents/$AGENT/wallet

# 2. Fund it with $10 of USDG and a little native ETH for gas.
#    GAS IS SEPARATE. USDG cannot pay for gas; a wallet with 10 USDG and no
#    ETH signs a perfectly valid transaction that cannot be mined.

# 3. Confirm the chain agrees, before signing anything.
#    Balance must read 10 USDG (10000000 base units, 6 decimals).

# 4. DRY RUN FIRST — same calldata, eth_call, no transaction.
#    Expect a real quote back. A revert here is the answer; do not proceed.
curl -s -X POST -H "X-Internal-Key: $INTERNAL_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"intent":"swap_exact_in","agent_id":"'$AGENT'","symbol":"AAPL","amount_usd":"10","dry_run":true}' \
  http://127.0.0.1:8085/internal/v1/signer/sign

# 5. The approve, if USDG has never been approved for this router from this
#    wallet. One transaction, and it moves no money of its own.

# 6. THE SWAP. This spends. Read the response before doing anything else.

# 7. Read the receipt back from the chain, not from the response.
#    status must be 0x1. A reverted transaction has a hash, a receipt, a block
#    and a gas bill, and moved nothing.

# 8. Read NAV from the chain and reconcile against the portfolio.
#    They must agree. If they do not, STOP and record a custody_drift row —
#    do not adjust either side by hand.
```

### What must be true before step 6, and is checked by nothing else

- the agent's wallet is `platform_only`, or the owner accepts that a second
  party can move these funds mid-trade
- the seed has been replaced (section 2) — a phase-7 development seed must
  never hold money
- KMS is in place (section 2), which was the stated precondition for funding

### Stop conditions

Any of these ends the run; none is a reason to retry with a bigger number:

- the dry run reverts
- the receipt's status is `0x0`
- NAV and the portfolio disagree by more than rounding
- the pool price is `disputed` against Chainlink for the symbol being traded

**If $10 proves too small** — a pool too thin to fill it without absurd
slippage — the number is raised with the owner **before** any money moves, not
adjusted during the run.

---

## 4. `AUTH_ADMIN_WALLETS`

**Waiting on:** one or more wallet addresses.

### Already done

`AdminGuard` exists, is applied, and **refuses everyone while the variable is
empty** — which is the correct behaviour and not a bug. Operator actions have
no owner until somebody is named, and defaulting to "anybody with a session"
would be worse than defaulting to nobody.

### The owner's part

```bash
sudo systemctl edit arcana-agent.service
#   [Service]
#   Environment=AUTH_ADMIN_WALLETS=0xabc...,0xdef...

sudo systemctl daemon-reload && sudo systemctl restart arcana-agent
node infra/verify/auth-verify.mjs        # the admin checks stop being skipped
```

Comma-separated, lowercase or checksummed — the guard normalises. **Use a
wallet that is not also an agent's trading wallet.** Signing in as an admin and
signing a trade are different acts and should not share a key.
