# Three things waiting on the owner

Each is **prepared to the point where only the owner's part remains**. No
engineering work is left in any of them; what is left is a credential, an
authorisation, or a decision to spend.

A fourth — `AUTH_ADMIN_WALLETS` — was closed on 2026-09-11 and is kept below as
a record of how it was verified, not as an outstanding item.

Nothing here is a blocker for anything else. They are listed together because
they share that shape, not because they are related.

| | What is waited on | What is already done | What it unblocks |
|---|---|---|---|
| 1 | Google Drive authorisation | script, alarm, verification, retention | off-site backups |
| ~~2~~ | ~~KMS decision + a new seed~~ | **SEED DONE 2026-09-11.** KMS deferred by the owner: option A (file-backed) stays for now | — |
| ~~3~~ | ~~The first mainnet swap~~ | **DONE 2026-09-11** — $2 executed on chain, filled exactly as simulated | — |
| ~~4~~ | ~~`AUTH_ADMIN_WALLETS`~~ | **DONE 2026-09-11** — set, and proved from both sides: it refuses a non-admin AND admits a configured one | — |

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

**Status 2026-09-11: the seed is replaced. KMS is deferred, deliberately.**

The owner chose to keep option A — the file-backed seed — rather than hold
phase 8 for a KMS account. That reverses the earlier "both are preconditions
before the first wallet is funded", and it is written down here rather than
left implied: **the seed protecting real money is a plaintext file on one
host.** Its blast radius today is one wallet holding $10. It stops being $10
the moment anyone else funds an agent, and the KMS decision belongs before
that, not before the first swap.

The shapes below are unchanged and still the decision to make.

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
#    MODE 0600 WHILE WRITING, sealed to 0400 after. 0400 is read-only for its
#    OWNER too, so creating the file at 0400 and then writing to it fails with
#    "Permission denied" — and tee reports that on stderr while the pipeline
#    still exits 0, so the next line happily installs an EMPTY seed. That is
#    how this procedure was first run: the signer came back up INACTIVE on a
#    0-byte seed, and only the retired copy still existing made it recoverable.
sudo -u arcana-signer install -m 0600 /dev/null /etc/arcana/signer/master.key.new
openssl rand -hex 32 | sudo -u arcana-signer tee /etc/arcana/signer/master.key.new >/dev/null
#    Refuse on an empty file here, rather than discovering it after the move.
sudo -u arcana-signer test -s /etc/arcana/signer/master.key.new || exit 1
sudo chmod 0400 /etc/arcana/signer/master.key.new

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

# 6. Prove it took: the SAME agent id must derive a DIFFERENT address under
#    the old seed and the new one. agents-verify alone cannot show this — with
#    zero agent_wallets rows there is no "before" to compare against, and it
#    passes just as happily on a seed that was never rotated. Build a throwaway
#    binary against internal/keys, point it at each file, and compare:
#      kr, _ := keys.LoadKeyring(os.Args[1]); kr.Address("<any fixed uuid>")
#    Run it BEFORE step 7, while the retired seed still exists. Then:
node infra/verify/agents-verify.mjs
bash infra/verify/signer-isolation-verify.sh

# 7. Only once everything above is green:
sudo shred -u /etc/arcana/signer/master.key.retired
```

Step 1 is not a formality. It is the whole reason this is done before funding
rather than after.

### Executed 2026-09-11

| | |
|---|---|
| agent wallets on record at step 1 | **0** — nothing could be stranded |
| backup taken before touching the seed | `arcana-backup.service`, finished clean |
| retired seed sha256 (first 24) | `ec4767c08ffa977534af3a49` |
| new seed sha256 (first 24) | `dfd9e0b4d6e9fc3c7eb6563f` |
| proof derivation moved | agent id `…00aa` derives `0x6b6200…` under the retired seed and `0xc41438…` under the new one |
| verification | agents-verify 61/61, signer-verify 31/31, signer-isolation-verify 15/15, chain-guard-verify 10/10, deployed-version-verify 11/11 |
| retired seed | `shred -u` after all of the above went green |

The rotation **failed on its first attempt** and the failure is recorded in the
corrected step 3 above. It was recoverable only because step 7 comes last: the
retired seed still existed when the new one turned out to be empty. That
ordering was not luck, but it was also not tested until this run.

---

## 3. The first mainnet swap — $10

**Waiting on:** the transfer. Approval was given on 2026-09-11 (**$10**), the
seed was replaced, and the wallet now exists and is empty.

### The wallet, as of 2026-09-11

| | |
|---|---|
| agent | `2dbc0eb1-fd2a-40a5-9322-3337dd1186d0` — "Phase 8 first swap", mandate `concentrated` |
| address | `0xD7b7477572051afbbcbF0695a4fD6e1eB915518B` |
| provenance | `derived` — from the new seed, through `GET /v1/agents/:id/wallet` |
| custody | `shared` — the owner asked for the key and it was exported |
| on chain | ETH `0x0`, USDG `0x0`, nonce `0x0` — never used |
| status | `draft`, and in no competition, so the hourly cadence cannot reach it |

**What to send:** `10` USDG (10000000 base units) and **0.001 ETH**. The ETH
figure is set by EIP-1559's upfront reserve, not by what gets burned: the chain
holds `maxFee × gasLimit` regardless of the actual fee, and the signer's
defaults are 1 gwei and 250,000 gas, so each transaction reserves 0.00025 ETH.
Approve plus swap is 0.0005 ETH, and 0.001 leaves room for a retry. At
0.12685 gwei base fee the two together actually burn about 0.000025 ETH.

Nothing else needs to be in the wallet.

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

- ~~the agent's wallet is `platform_only`~~ — it is `shared`. The owner asked
  for the key and holds it. ARCANA is no longer the only party that can move
  these funds, including mid-trade, and reads the chain rather than trusting
  its own record because of it. This is the accepted case, not the unexpected one.
- ~~the seed has been replaced~~ — **done 2026-09-11**, see section 2
- ~~KMS is in place~~ — **deferred by the owner.** It was a stated precondition
  and it is no longer one; that is a decision, not an oversight, and section 2
  records what it costs

### Executed 2026-09-11 — it worked, and what it cost

The owner set the first swap at **$2**, not $10.

| | |
|---|---|
| wallet | `0xD7b7477572051afbbcbF0695a4fD6e1eB915518B` |
| funded with | 0.003 ETH (bridged from mainnet) + 11.7881 USDG (from Gate.io) |
| approve | `0x451b7372…f34f0`, block 59858271, status `0x1`, 57,976 gas, 0.0000073563 ETH |
| swap | `0xe089c139…ebbb`, block 59858620, status `0x1`, 163,371 gas, 0.0000206347 ETH |
| filled | 2 USDG → **0.0061448329 AAPL**, $325.4767 per share |
| **simulated vs actual** | `6144832876309440` vs `6144832876309440` — **0.000000% deviation** |
| gas accounting | burned 20,634,737,526,000 wei; the balance fell by exactly that, so nothing else moved native funds |
| custody drift | **zero rows** — see the caveat below |

Both receipts were read back **from the chain**, not taken from the response.
The control mattered: before spending, the same calldata with an impossible
minimum was simulated and reverted, so the quote was not a no-op.

**Pool and referee agreed before the trade**: pool $325.2573, Chainlink
$326.4147, deviation 0.3546% against a 2% dispute tolerance.

#### The caveat on "custody drift is zero"

It is zero because **ARCANA recorded nothing to disagree with**. This agent
has no `portfolios` row, no `decisions` row, and no snapshot: the swap was
driven by hand, because nothing in the platform drives one. Zero drift here
is the absence of a claim, not a reconciliation that succeeded, and reporting
it as a passing check would be reading a green light off an unplugged lamp.

#### What the first real transaction exposed

1. **Nothing calls the signer.** The only caller of
   `/internal/v1/signer/sign` anywhere in the repo is `signer-verify.mjs`.
   `sendRawTransaction` appears nowhere. The execution path from a recorded
   decision to a broadcast transaction does not exist — the gap is not the
   scheduler, so turning on the cadence would not close it.
2. **The signer could not sign at all**, because `isBlocked()` has no answer
   on this chain. Fixed under option A; see `docs/signer.md`.
3. **Step 4 of the procedure below was fiction** — `symbol`, `amount_usd` and
   `dry_run` are not fields the signer accepts, and it has no simulation mode.
   The real dry run is an `eth_call` of the same calldata, which is what was
   actually done.

The agent is still `draft` and in no competition, so the hourly cadence cannot
reach it. Turning it on is the owner’s call and has not been made.

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

## 4. `AUTH_ADMIN_WALLETS` — **done 2026-09-11**

Set to one address. The admin tier has an owner.

### An ADDRESS, never a private key

The guard compares `auth.wallet` — the address SIWE **recovered from a
signature the owner made in their own wallet**. The key never leaves the
wallet, never crosses the wire, and is never stored.

So this list grants no ability to sign anything. It only names who may perform
an operator action *once they have already proved who they are*. Adding an
address you do not control gives that person nothing they could use.

The only private keys anywhere in ARCANA are the **agent trading wallets**,
held by the signer in a file the application user cannot read
([signer.md](./signer.md)). Different subsystem, different threat, different
storage.

### It lives in `.env.auth`, not in the unit file

The unit is committed to git, and an admin address there would permanently
record **which address controls ARCANA** in the history. The address itself is
public on chain; the *association* is the part worth not publishing, and
avoiding it costs nothing.

`EnvironmentFile=` is declared after `Environment=` in the unit, so the file
wins over the empty inline default. That ordering is load-bearing — reversed,
the inline empty value would silently blank the setting and the admin tier
would refuse everyone while looking configured.

```bash
# On the VPS. Comma-separated; the guard lowercases, so case does not matter.
printf 'AUTH_ADMIN_WALLETS=0x…
' >> /home/ubuntu/arcana/.env.auth
sudo systemctl restart arcana-agent
```

**Verify it took.** `systemctl show -p Environment` will NOT show it — that
prints only `Environment=` directives, not `EnvironmentFile` contents, and
reading an empty value there is the obvious way to conclude wrongly that this
failed. Read the process instead:

```bash
sudo tr '\0' '\n' < /proc/$(systemctl show arcana-agent -p MainPID --value)/environ | grep ADMIN
```

### Proved from BOTH sides

`auth-verify` asserts that a signed-in non-admin gets `403
forbidden_not_admin`. **That check passed while the list was empty too**, so on
its own it proves the guard refuses — not that the list admits. A list that
never admits anyone looks identical to a working one.

So the other side was proved on purpose: a throwaway wallet was added to the
list, signed in, performed an operator action (creating a season — `AdminGuard`
protected) and got **201**, then was removed and the season deleted. No part of
it needed the owner's key, because the allowlist is addresses.

```
AUTH_ADMIN_WALLETS=0x7c1b…597d,0xdab3…0A36
signed in: true
operator action status: 201
RESULT: the allowlist ADMITS a configured wallet.
```

### Two things to keep true

- **Not also an agent's trading wallet.** Signing in as an operator and signing
  a trade are different acts and should not share a key. Checked before this
  was set: the address appears in neither `creators.wallet_address` nor
  `agent_wallets.address`.
- **Empty still means nobody.** An unset list denies everyone rather than
  allowing everyone — `AdminGuard` has always worked that way, and it is worth
  restating because the opposite is the more common default.

### Signing in

The wallet must be on **Robinhood Chain** when it signs: `AUTH_ALLOWED_CHAIN_IDS`
pins 4663 (mainnet) and 46630 (testnet). A signature produced while the wallet
sits on Ethereum mainnet is refused — EIP-191 signatures are not chain-bound,
so the `Chain ID` line is a claim in plain text and is checked against
configuration rather than believed.

The wallet needs **no funds**. It signs a message; it never sends a
transaction.
