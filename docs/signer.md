# The Signer

The only ARCANA process that holds key material. It runs as its own Linux user,
accepts named intents rather than calldata, and **does not broadcast**.

Implemented in `services/signer/`. Verified by
`infra/verify/signer-verify.mjs` (31 checks) and
`infra/verify/signer-isolation-verify.sh` (15 checks).

Related: [on-chain-direction.md §f](./on-chain-direction.md#f-agent-authority--six-layers-and-only-one-of-them-binds),
[go-no-go-stock-tokens.md](./go-no-go-stock-tokens.md) conditions 1, 2 and 5.

---

## The rule the whole design turns on

**The signer can do the things whose shape is permitted — not the things no rule
forbids.**

An allowlist, not a denylist, expressed in code rather than in a policy
document. It does not accept calldata and validate it; it accepts a **named
intent** and builds the calldata itself:

```json
{ "intent": "swap_exact_in", "agent_id": "...", "token_in": "...", "token_out": "...",
  "router": "...", "amount": "10000000", "min_out": "1", "price_usd": 1 }
```

There are two intents: `approve` and `swap_exact_in`. **A caller cannot ask for
a raw transfer because there is no way to say it** — no `to`, no `data`, no
`value`, and no `recipient`. Unknown JSON fields are rejected outright rather
than ignored, so a request that thinks it is asking for something else is told
it is wrong instead of quietly getting something it did not ask for.

Validating attacker-supplied calldata would mean every future encoding trick is
a bug waiting to be found. Constructing it means the set of possible
transactions is whatever `internal/tx` can build, and nothing else.

## Why the limits are enforced *here*

Every check below also exists, or will exist, in the decision engine's policy
layer. They are repeated at the signer because **a limit that lives one layer up
is a limit any future caller can bypass by not knowing about it** — a migration
script, an operator tool, an endpoint someone adds in a hurry. The caller
decides what it wants; the signer decides what is possible.

| Enforced at the signer | Why there |
|---|---|
| Router allowlist | the contract being called is the transaction's whole meaning |
| Token allowlist | ditto, for what moves |
| **Recipient is the agent's own wallet** | a swap whose proceeds go elsewhere is a withdrawal wearing a swap's clothes. It is not a parameter |
| Notional cap per trade | the last place a bad number can be stopped |
| Approval cap | an unlimited approval is the standard convenience and the standard way a compromised router drains a wallet |
| Daily signature cap | bounds a runaway caller without needing to diagnose it first |
| Chain id | a transaction signed for the wrong chain is replayable on it |
| `value` is always zero | not a field. A field that is always zero is a field that can one day be set by mistake |

### `wallet_blocked` and `token_paused` — where each belongs

Both are issuer-controlled switches that make a transfer revert
([go/no-go](./go-no-go-stock-tokens.md) conditions 1 and 2). They do **not**
belong in the same place, and that was a decision:

- **`wallet_blocked` → primary home is the signer.** It is a property of the
  *key the signer is about to use*. The signer is the only component that knows
  which key that is, and it is the last thing to run before a signature exists.
  Checking it anywhere else means every future caller has to remember; checking
  it here means none of them can forget.

- **`token_paused` → primary home is the decision engine, backstopped here.** A
  paused token should stop an agent *earlier* than signing: before inference is
  purchased, before a decision is recorded that can never settle. But the issuer
  can pause between deciding and signing, so the signer checks it too.

**And the rule that binds both: if the chain cannot be read, the signer
refuses.** "Could not check" is not "fine". A signer that signs when it cannot
verify is a signer whose checks disappear exactly when the network is having the
kind of day on which things go wrong.

`isBlocked()` currently *reverts* on these tokens — most likely delegating to a
registry that is not set — so today this refusal fires on the expected path. An
unreadable blocklist is not an empty one.

## Key custody

Every agent's private key is **derived** from one master seed with HKDF-SHA512,
keyed by the agent id. No per-agent private key is written anywhere. Deriving
rather than storing reduces the things that must be backed up, guarded and
rotated from N to one, and means creating a wallet requires no write at all.

**The cost of that, stated plainly: the seed is a single point of total failure
in both directions.**

> **If the master seed is lost, every wallet is unrecoverable. Permanently. There
> is no support path, no reset, and no partial recovery.** If it leaks, every
> wallet can be drained.

That is why the seed is the only thing in this system with its own Linux user,
its own file mode, and a service that refuses to start when either is wrong.

### The options, with what they actually cost

| | Recurring | If the host is compromised | If the secret is lost |
|---|---|---|---|
| **A. File on the signer host** *(what runs today)* | **$0** | seed can be copied; every wallet drained | every wallet unrecoverable |
| **B. Seed wrapped by cloud KMS** *(recommended)* | **~$1/mo** AWS, **~$0.06/mo** GCP | attacker can *ask* KMS to decrypt, but cannot copy the key; **every decrypt is logged and access is revocable in one click** | recoverable while the KMS key lives; unrecoverable if that is deleted too |
| C. One KMS key per wallet | **~$100/mo** AWS at 100 agents, ~$6/mo GCP | same as B | same as B |
| D. Hardware HSM (YubiHSM 2) | **~$650 once** | key cannot leave the device | unrecoverable |

AWS KMS: $1/month per key plus $0.03 per 10,000 requests. GCP Cloud KMS: $0.06
per key version per month plus $0.03 per 10,000 operations. At one decrypt per
signer boot, request charges round to nothing in both.

### DECIDED 2026-09-11: option A, deliberately

**The seed stays a file on the host.** No KMS, no cloud account, no additional
service. This is a considered choice for a phase with no money in it, recorded
here so it reads as a decision rather than as something nobody got to.

**What that accepts, in plain terms:**

- **Host compromised → every wallet drained.** The seed can be copied by anyone
  who gets root, and nothing about that would be logged or revocable.
- **Seed lost → every wallet gone permanently.** No support path, no reset, no
  partial recovery.

Both are survivable today for exactly one reason: the wallets are empty.

**Option B is a PRECONDITION of funding the first wallet, not an improvement to
schedule later.** The moment real money is in an agent wallet, "an attacker who
gets root can copy the key silently" stops being an accepted risk and becomes an
unacceptable one. Because the seed is loaded through a single function, moving
to a KMS-wrapped seed changes that function and nothing else — a swap, not a
rewrite. That is why it was built this way rather than left until it was needed.

**The seed must never move into Postgres.** It is the obvious-looking
simplification and it would undo everything this component is for:

- every service holding a database connection could read it, which is the exact
  separation the Linux user, the 0700 directory and the 0400 file exist to
  create;
- and it would be carried into every database backup, including the off-site
  archive, which is not encrypted at rest.

A seed in a backup is a seed in however many copies of that backup exist, in
whatever places they were copied to, for as long as they are retained.


For the record, the ranking behind that decision: **B** when money arrives. C
buys almost nothing over B — B's compromise scope is already "the seed" — for
a hundred times the money. D is the strongest and is not available on a rented
VPS.

### What runs today, and its expiry

A **phase-7 seed** exists at `/etc/arcana/signer/master.key`, generated on the
host, owned `arcana-signer:arcana-signer` at mode `0400`.

**It is for empty wallets only and must be replaced before anything is funded**,
alongside the move to option B.
It was created before the custody decision was made, which means it has never
been protected by whatever that decision turns out to be. Treat it as a test
fixture that happens to be real.

Whatever replaces it needs two things this one does not have: a backup in two
physically separate places, and a **recovery drill that is performed rather than
documented** — the precedent being `arcana-restore-test.sh`, which proves the
database restores instead of claiming it.

## Process isolation

Every other ARCANA service runs as `ubuntu`. The signer does not.

| | |
|---|---|
| User | `arcana-signer`, system account, `/usr/sbin/nologin` |
| Seed | `/etc/arcana/signer/master.key`, `0400`, owned by the signer |
| Directory | `/etc/arcana/signer`, `0700` — `ubuntu` cannot even list it |
| Binary | `/usr/local/bin/arcana-signer`, root-owned |
| Listens | `127.0.0.1:8085` only |
| Hardening | `ProtectHome=yes`, `ProtectSystem=strict`, `NoNewPrivileges`, `MemoryDenyWriteExecute`, `LimitCORE=0` |

**The seed is not in an environment file**, unlike every other secret in this
project. Environment is visible in `/proc/<pid>/environ` to anything running as
the same user, is inherited by every child process, and is printed by a careless
crash handler. A file is read once, by a process that refuses to start if its
mode allows group or other access.

### The first install failed, and the failure was the proof

`systemd` refused to start the service:

```
Changing to the requested working directory failed: Permission denied
Failed at step CHDIR spawning /home/ubuntu/arcana/scheduler-bin/signer
```

`arcana-signer` genuinely cannot traverse into the application user's home. **The
fix was to remove the dependency, not to widen the permission**: binary,
allowlist and environment now live under `/usr/local/bin` and `/etc/arcana`, and
nothing the signer touches is under `/home/ubuntu`.

The shared internal API key is copied to `/etc/arcana/signer/signer.env`
(`0640`, `root:arcana-signer`). The same secret exists in two places, each at the
permissions its reader needs. The alternative was letting a key-holding process
read the home directory of the user that answers HTTP, which is worse.

## Proof

```bash
node infra/verify/signer-verify.mjs           # 31 checks
bash infra/verify/signer-isolation-verify.sh  # 15 checks
```

Every refusal is triggered for real: a paused token and a blocked wallet come
from an RPC that answers that way, a chain it cannot read is a genuinely closed
port, the daily cap fires by actually being exceeded, and the exposed-seed
refusal uses a real `0644` file.

**And the cryptography is checked by someone else.** `viem` parses the raw
transaction the Go signer produced and recovers the sender. It comes back as the
signer's own derived wallet — so the key derivation, the RLP encoding and the
signature are all correct, confirmed by an independent implementation rather
than by the one under test.

The accept path is proved too. A gate that refuses everything has not been shown
to be right either.

## What this phase deliberately does not do

- **It does not broadcast.** There is no code path that sends a transaction.
- **No router is allowlisted.** `routers` is empty in the shipped configuration,
  so every swap is refused. That is correct until a router is proven to work
  against this chain's factory — the canonical UniversalRouter address exists on
  Robinhood Chain and is **not** wired to it, failing with an empty revert. The
  verification suite adds a test router to its own copy, which is why the accept
  path can be proved without weakening what ships.
- **Nothing calls it yet.** The decision engine does not ask it for signatures;
  wiring that is phase 8, with the first real swap.
