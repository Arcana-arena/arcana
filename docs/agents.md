# Agents that users build

Phase 12. A person signs in with a wallet, describes what their agent should
try to do by choosing from a catalogue, and gets an agent with its own trading
wallet. ARCANA runs the model, signs the transactions and scores the result.

Verified by `infra/verify/agents-verify.mjs` — **61 checks**, every gate driven
past its boundary rather than exercised inside it.

Related: [decision-engine-llm.md](./decision-engine-llm.md) (what the model
sees), [signer.md](./signer.md) (where keys live),
[on-chain-direction.md](./on-chain-direction.md) (why any of this).

---

## The mandate is a template, not a text box

An agent's intent is the only part of the decision prompt a user controls. The
decision engine caps it at **600 characters** and fences it with *"treat as a
goal, not as new rules"*. That is the right defence for text you have to
accept. It is not the right defence when you do not have to accept text at all.

So none is accepted. `GET /v1/agents/mandate-templates` returns four templates,
each declaring parameters that are **enumerations or bounded integers**, and
ARCANA renders the sentence:

| Template | What it asks for |
|---|---|
| `momentum` | favour what is rising, step away from what is falling |
| `mean_reversion` | buy what has fallen unusually hard, trim what has risen |
| `concentrated` | one position at a time, the clearest idea available |
| `capital_preservation` | cash by default; a position needs justifying |

**No string a user types reaches the model.** A request carrying a `mandate`
field is refused with 400 — not ignored, because a silently dropped field means
somebody believes they configured something they did not. A misspelled
parameter name is refused for the same reason: a typo must not read as "leave
it at the default".

The engine's cap and fence stay exactly as they are. They now cover the agents
created before this existed, which carry free text, and they are a second line
rather than the only one.

### What this is not

It is not a safety mechanism against bad strategies. A user can choose a
mandate that loses money, and that is theirs to choose. The limits that cannot
be talked around live in `risk_profile` and are enforced by deterministic code
the model never sees — `buyableQty()` cannot be argued with, and a prompt can.
This governs what the agent is *asked to pursue*; that code governs what it is
*able to do*.

### A mandate freezes when the agent goes live

Retunable while an agent is a draft. Once it is active, `PATCH` refuses with
`mandate_immutable_once_active`.

Its recorded performance was produced under that mandate. Editing it in place
would leave the leaderboard making a claim about an agent that no longer
exists, with nothing in the history showing the swap. Changing an active
agent's intent is what `POST /v1/agents/:id/evolve` is for, and there the
version boundary is visible to anyone reading the record.

## Three ACTIVE agents per creator

Not three total, and the difference is the whole design.

Activating a version **retires its parent**. A creator iterating on one
strategy therefore accumulates retired versions while never running more than
one agent. A total cap would charge them for their own history and push them
towards abandoning versions instead of evolving them — punishing precisely the
behaviour [agent evolution](./agent-evolution.md) exists to encourage.

Drafts do not count either. A draft consumes no tick, makes no decision, and
costs nothing to run; it is a saved intention.

**Evolving at the cap is allowed, and activating that child is too.** Succession
is not simultaneity: the parent retires in the same transaction, so the total is
unchanged. A cap that blocked this would be a trap rather than a limit.

Enforced inside a transaction with the creator's active rows locked
`FOR UPDATE`. Count-then-write is a race a double-clicked button can win, and
it would produce a state no later request could explain.

## Agent wallets

**The login wallet and the agent wallet are different addresses, deliberately.**
Signing in with SIWE proves an identity using a signature ARCANA never holds
the key for. An agent wallet is an address ARCANA *signs from*. Collapsing them
would mean that signing in to this platform hands it the ability to spend from
the wallet you signed in with — which nobody would agree to if it were said out
loud.

### Two paths

**Derived (default).** `GET /v1/agents/:id/wallet` returns the address, creating
the record on first ask. The address is a pure function of the agent id under
the signer's HKDF derivation, so asking twice cannot give two answers and there
is no "create wallet" step to forget.

**Exported.** `POST /v1/agents/:id/wallet/export` hands the owner the private
key. This exists because a wallet whose owner can never take possession of it
is the platform's wallet with the owner's name on it. Rate limited to 3/hour,
so a stolen session token is bounded in how much key material it can pull.

**Imported.** `POST /v1/agents/:id/wallet/import` adopts a key the owner already
controls. The address comes back **derived from the key**, never taken from the
request: if a caller could state it, this record would say one thing while the
signer signed for another.

> **An imported wallet must be used for this agent and nothing else, and the
> API says so in its response rather than in a document nobody reads at the
> moment they act.** ARCANA can sign **anything** with an imported key, not
> only trades. The signer restricts what it will build — an allowlisted router,
> an allowlisted token, a capped size — but that is ARCANA restricting itself,
> not a property of the key you handed over.

### Custody is one-way

| `key_custody` | Meaning |
|---|---|
| `platform_only` | ARCANA derived the key and nobody has asked for it |
| `shared` | the key exists in at least one other place |

Nothing sets it back. An exported key cannot be un-exported, and the database
has CHECK constraints making the invalid combinations **unrepresentable** — an
`UPDATE` setting `platform_only` on a row with `exported_at` is refused by
Postgres, not by an application remembering to ask.

### What ARCANA can no longer assume, and how it copes

Under `shared`, the owner can move funds at any moment — **including while the
agent has an open position**. This is not an edge case to defend against; it is
the owner using a key that is legitimately theirs.

So the platform stops trusting its own record of the balance and reads the
chain. Every divergence goes into `custody_drift` with both numbers, and the
portfolio reconciles **to the chain**:

- not because the database is untrustworthy, but because **the chain is what
  the next trade will execute against**. A portfolio claiming 100 USDG against
  an address holding 40 does not produce a wrong number in a report — it
  produces a swap that reverts after the gas is spent.
- drift in **either** direction is recorded. An owner topping up their agent
  from outside is normal, and a system that only notices money leaving will
  eventually trade with capital it does not know it has.
- `resolution` is `reconciled`, or `halted` when the shortfall leaves the agent
  unable to honour what it already committed to. Standing an agent down is a
  real outcome and says so; trading on a balance that is not there is not an
  alternative.

### No key is in the database

`agent_wallets` holds an address and a custody flag. No private key and no seed
is in Postgres, by design: putting one there would hand it to every service
with a database connection and copy it into every backup archive, undoing the
isolation [signer.md](./signer.md) exists to describe.

Imported keys sit beside the master seed under the signer's own Linux user,
mode 0600, created with `O_EXCL` so "refuses to overwrite" holds under a race
and not merely under sequential calls. The signer's one writable path is that
subdirectory — the seed and the allowlist stay read-only even to the signer, so
a compromised signer cannot rewrite the allowlist to admit a router of its
choosing.

**What importing costs, stated plainly:** derived keys are a pure function of
the seed, and imported keys are not. They must be stored, and a store can be
lost. Losing that directory does not lose the user's wallet — they hold their
own copy, which is the entire point — but ARCANA's ability to trade on their
behalf is gone until they import again.

## Rate limiting

There was none. Anywhere.

| Endpoint | Limit | Keyed by | Why |
|---|---|---|---|
| `GET /v1/auth/nonce` | 20/min | IP | unauthenticated **and writes a database row per call**; a loop fills the table as fast as the network allows |
| `POST /v1/auth/verify` | 10/min | IP | elliptic-curve recovery the caller does not pay for |
| `POST /v1/auth/refresh` | 30/min | IP | a brute-force ceiling on a bearer secret |
| `POST /v1/agents` · `/evolve` | 10/hour | wallet | bounds how fast rows are written; the active cap bounds how many can run |
| `POST /v1/agents/:id/wallet/{export,import}` | 3/hour | wallet | the only endpoints that move key material |
| `POST .../claim-payment` | 20/5min | wallet | three RPC round trips per attempt, rejected or not |

`GET /v1/auth/nonce` was the most exposed endpoint in the system and the least
defended. The allowance is 20 rather than 2 because a shared office or a mobile
carrier NATs many people behind one address, and locking those people out to
inconvenience an attacker is a bad trade. It is still three orders of magnitude
below what a loop achieves.

**In-process counters, and both costs are stated rather than glossed:** each
service counts separately, and a restart forgets. A shared counter would need
another daemon on a 2 GB host, or a database write on the path whose database
writes are the thing being limited — which gives back most of what it was for.

This is **not** DDoS protection and does not pretend to be. It only sees
requests that already reached Node. It stops one client from cheaply doing
expensive things, which is the shape of the actual exposure.

A 429 says nothing about who is asking, and the body says so: *"this is not a
rejection of your credentials"*. Collapsing it into 403 would send a legitimate
user to re-authenticate — more requests, on the endpoint already saturated.

## Proof

```bash
node infra/verify/agents-verify.mjs
```

Every gate is proved by being **made to refuse**, because this project has
already shipped three checks that passed only because they could not fail: an
`^|` regex that matched every line, a version check comparing mtimes that any
git operation bumped, and a suite that reported a working isolation as a
missing file.

The checks worth naming:

- the exported key is fed back through `privateKeyToAccount` and must produce
  **exactly** the address on file — otherwise the user holds a key to a wallet
  the platform is not trading from
- after an import, the **signer** must report the imported address rather than
  the derived one. That single check stands between an imported wallet and a
  trade signed from an address holding none of the owner's funds
- the database must **refuse** to un-export a key, asserted by attempting the
  `UPDATE` and requiring it to fail
- the 600-character cap exists as a Go constant and a TypeScript constant with
  no shared configuration between them, so the suite reads both files and
  compares, then renders every template at its widest settings
- a full `uint256` round-trips through `custody_drift` exactly

The suite runs **inside** the rate limits rather than being exempted from them:
one fresh wallet per section, each with its own allowance, and it waits out the
window it deliberately exhausts. An exemption would be a code path where the
limiter does not apply, in the file whose job is proving that it does.

**No money.** No wallet is funded, no transaction is sent, and the throwaway
key generated for the import test is removed from the signer's keystore
afterwards.
