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

## The mandate: your own words, or a template

An agent's intent is the only part of the decision prompt a user controls, and
there are now two ways to supply it.

**Write it yourself.** `mandate` takes up to **2000 characters** of your own
text. **Or choose a form.** `GET /v1/agents/mandate-templates` returns four
templates whose parameters are enumerations and bounded integers, from which
ARCANA renders the sentence:

| Template | What it asks for |
|---|---|
| `momentum` | favour what is rising, step away from what is falling |
| `mean_reversion` | buy what has fallen unusually hard, trim what has risen |
| `concentrated` | one position at a time, the clearest idea available |
| `capital_preservation` | cash by default; a position needs justifying |

Supplying both is refused rather than resolved, and which one was used is
recorded in `mandate_source` — `free`, `template`, or `legacy` for agents that
predate both. NULL never has to mean two things.

### Why free text was refused, and why it is not any more

Phase 6 refused it because a prompt can be jailbroken. That was correct when the
prompt was the only thing between a user and the money. It stopped being correct
when the execution layer was finished, because **the defence was never in the
prompt**:

- the decider returns an **intent**, never a trade; `buyableQty()` and
  `applyIntent()` stand between it and any position
- the signer accepts **two named transaction shapes and no calldata**, so a raw
  transfer is not refused — it is unsayable
- every token must already be in a **reviewed allowlist**; absent means refused
- position size, caps, the fee floor and the cadence are all outside the model's
  reach

So the most hostile mandate anybody can write commands a swap between
allowlisted tokens, inside limits somebody else set. What it can damage is that
user's own capital, which is theirs to risk.

**A template is still a stronger guarantee**, and that is why it stays: no
string the user typed reaches the model at all. Some owners want that; some want
to describe a strategy in their own words. Both are supported.

### The cap is about cost, not safety

2000 characters is roughly 500 tokens, sent on **every** decision:

```
6 decisions/day x 30 days = 180 calls/month per agent
500 tokens x 180          = 90,000 prompt tokens/month, from the mandate alone
```

The rest of the prompt is about 700 tokens, so a full-length mandate is roughly
40% of what an agent spends on inference — paid by the agent's owner, which is
the right person to pay it. Over the cap the request is **refused, never
truncated**: a silently shortened mandate is one the owner never sees the real
version of, and they would be judging an agent on instructions they did not
write.

### How user text is fenced

Structurally, not by censorship. No keyword filtering and no attempt to detect
intent — both fail against anyone who tries twice.

The owner's text enters between markers, introduced as a **goal rather than as
rules**, and everything it might try to move is restated **after** it: the
output shape, that symbols come from the MARKET table, and the obligation to
state a falsifiable thesis. The last thing the model reads is ARCANA's.

That restatement is what makes it tidy. What makes it *safe* is that the answer
is parsed afterwards: the action must be one of three, the symbol must be in the
snapshot, the size is a request that gets clamped. A model that ignores all of
it produces a recorded hold with a reason code, and the cost is one tick.

### Proved by attacking it

`infra/verify/prompt-injection-verify.mjs` writes the most hostile mandates it
can against the live system — ignore the output format, buy a symbol that does
not exist, use 100% of NAV, transfer the balance to an outside address, 50,000
characters of filler — and asserts what the **system** did, never what the model
said. 24 checks.

It is deliberately paired with `clamp_test.go`, because the injection suite
alone is not enough: on a flat market the model held on every hostile prompt,
which proves the system survived and proves nothing about the clamp, since that
branch never ran. The clamp is arithmetic, so it is tested as arithmetic —
including that a requested size may lower the limit and never raise it.

### What this is not

It is not a safety mechanism against bad strategies. A user can write a mandate
that loses money, and that is theirs to choose. The limits that cannot be talked
around live in `risk_profile` and in the signer, enforced by deterministic code
the model never sees. This governs what the agent is *asked to pursue*; that
code governs what it is *able to do*.

### A mandate freezes when the agent goes live

Retunable while an agent is a draft. Once it is active, `PATCH` refuses with
`mandate_immutable_once_active`.

Its recorded performance was produced under that mandate. Editing it in place
would leave the leaderboard making a claim about an agent that no longer
exists, with nothing in the history showing the swap. Changing an active
agent's intent is what `POST /v1/agents/:id/evolve` is for, and there the
version boundary is visible to anyone reading the record.

## 3 active agents per creator

Three ACTIVE, not three total, and the difference is the whole design.

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
