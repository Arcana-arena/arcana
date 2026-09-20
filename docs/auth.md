# Authentication & Authorisation

**Status:** live since 2026-09-09. Verified by `infra/verify/auth-verify.mjs`
(75 checks, every one of which requires something to actually be refused).

Until this work every ARCANA endpoint was open. Identity arrived as a field in
the request — `creatorId` in a body, `userWallet` in a query — and was believed.
Anyone could create an agent under another creator, evolve or retire someone
else's agent, mint a deposit address in another person's name, or read any
wallet's subscription history. Nothing was compromised only because the
provider firewall kept the ports unreachable; the application itself had no
opinion about who was calling.

---

## 1. Mechanism: Sign-In with Ethereum, and only that

Identity in ARCANA was already wallet-shaped before any of this:
`creators.wallet_address`, `subscriptions.user_wallet`,
`payment_claims.buyer_wallet`, and every $ARCA entitlement is evaluated
per-wallet. SIWE (EIP-4361) makes the address a *proven* fact instead of a
claimed one, and it fits without a translation layer: the address that comes
out of a verified signature is the same string those columns already hold.

**Non-custodial, without exception.** The wallet signs locally; only the
signature crosses the wire. ARCANA never asks for, receives, or stores a private
key — the same principle as Wood Liquidity.

### No email or OAuth in v1 — deliberately

Every write in ARCANA already requires a wallet for reasons that have nothing to
do with login: creating and evolving agents is gated on $ARCA balances per
wallet, and subscribing generates a per-wallet deposit address. An email account
would arrive at the first useful action and be told to connect a wallet anyway.

Worse, if an email user were to genuinely *own* an agent, somebody would have to
hold their key — and that somebody would be ARCANA. That is custody, and it is
ruled out.

Because the entire read surface is public (§3), a visitor without a wallet loses
nothing they could have used. Email belongs here only once a feature exists that
genuinely needs no wallet — a watchlist, notifications, comments. At that point
email should be a **secondary identity linked to a wallet**, never a replacement
for one.

### What is verified in a sign-in message

A `personal_sign` signature proves exactly one thing: this key signed these
bytes. It says nothing about which site the bytes were meant for, which chain
they name, or when they were produced. All three are plain text an attacker
writes, so all three are checked against configuration rather than trusted:

| Field | Rule | Why |
|---|---|---|
| `Domain` | must equal `AUTH_SIWE_DOMAIN` | a signature the user produced for another site cannot be replayed here |
| `URI` | must equal `AUTH_SIWE_URI` | same |
| `Chain ID` | must be in `AUTH_ALLOWED_CHAIN_IDS` (4663 mainnet / 46630 testnet) | **EIP-191 signatures are not chain-bound at all** — the Chain ID line is a claim, not a guarantee |
| `Issued At` | within ±`AUTH_ISSUED_AT_SKEW_SECONDS` (default 300s) | bounds staleness independently of the nonce |
| `Expiration Time` | honoured when present | — |
| `Version` | must be `1` | — |
| signature | recovered address must equal the address in the message | the signer is the subject |

### Nonce and replay

```
GET  /v1/auth/nonce   → 128-bit single-use nonce, TTL 5 min
POST /v1/auth/verify  → { message, signature }
```

The order of operations in `AuthService.verifySignIn` **is** the security
property:

1. validate every message field (above)
2. **consume the nonce atomically**
3. only then recover the signature

Step 2 is one statement:

```sql
WITH consumed AS (
  UPDATE auth_nonces SET used_at = now()
   WHERE nonce = $1 AND used_at IS NULL AND expires_at > now()
  RETURNING nonce
)
SELECT nonce FROM consumed
```

A `SELECT` followed by an `UPDATE` would let two concurrent replays both pass
the `SELECT` and both proceed — a defence that holds only when nothing races it.
The verification suite fires five simultaneous requests carrying one nonce and
requires exactly one to succeed.

> **The CTE wrapper is load-bearing, not style.** TypeORM's `query()` returns a
> row array for a `SELECT` but a `[rows, affectedCount]` **tuple** for a bare
> `UPDATE ... RETURNING`. `.length` on that tuple is always 2, so a
> `length === 0` test never fires. The first implementation had exactly that
> shape and **the nonce gate admitted every replay** — caught only because the
> suite replays a nonce and demands a refusal. Selecting over a CTE gives one
> unambiguous shape while keeping the UPDATE atomic. Any future
> `UPDATE ... RETURNING` used as a guard must do the same.

Consuming before recovery means a bad signature burns the nonce. That is
intended: it stops a live nonce being used as an oracle to grind signatures.

---

## 2. Sessions

| | Access token | Refresh token |
|---|---|---|
| Form | JWT, HS256 | 32 random bytes, opaque |
| TTL | **15 min** (`AUTH_ACCESS_TTL_SECONDS`) | **30 days** (`AUTH_REFRESH_TTL_SECONDS`) |
| Stored | nowhere | **SHA-256 hash only**, in `auth_sessions` |
| Subject | wallet address, lowercased | — |

`sub` is the **wallet**, not a creator id: the wallet is what was proven, and a
wallet may hold a valid session before it has ever created a creator profile
(`GET /v1/auth/me` returns `creator_id: null` in that case, which is a normal
state, not an error). It also returns `is_operator`, which says only whether
the CALLING wallet is in `AUTH_ADMIN_WALLETS` — the list itself is never
published. It exists so the web can render moderation controls to somebody who
can use them, and it is not a permission: every operator route still asks
`AdminGuard`, because a control that is merely absent has never stopped anyone.

**A signed-in wallet is not yet an author.** Everything published here —
agents, articles, forum threads, replies — belongs to a creator profile, so the
write routes marked "+ creator profile" refuse a profile-less wallet with `403
creator_profile_required` and name the form that makes one. That refusal exists
because the alternative was a 500: `creatorIdForWallet(...)!` asserted non-null
over a value that is null for every wallet that has signed in and stopped
there, and the insert then failed on a NOT NULL constraint.

JWT verification is written directly on `node:crypto` rather than pulled from a
library, so the three classic failures are visible and closed in one file:
`alg: none` and algorithm confusion are impossible because the header algorithm
never selects the verifier (HS256 is hardcoded and anything else is rejected
before a signature is computed), and comparison is `timingSafeEqual`.

**Rotation and reuse detection.** Every refresh mints a new pair and marks the
old one used. Presenting an already-used refresh token is not a retry — the
legitimate holder rotated it away, so a copy exists somewhere it should not.
The response is to revoke the **entire family** (`family_id`), logging out both
parties, because we cannot tell which one is asking.

### The 15-minute revocation window — a conscious trade

Logout and revoke kill the refresh family immediately, so no new access token
can be minted. **An access token already in the caller's hand stays valid until
it expires — at most 15 minutes.**

The alternative is a revocation lookup on every request (a Redis denylist). That
was considered and rejected: it puts a cache on the critical path of the whole
API, and its outage poses a question with no honest answer — we would not know
whether a session was revoked, leaving only fail-open (admit a revoked session)
or fail-closed (503 the entire platform over a cache blip). A bounded, stated
15-minute window is more honest than an unbounded dependency.

**Break-glass:** rotating `AUTH_JWT_SIGNING_KEY` invalidates every access token
everywhere, instantly, at no per-request cost.

---

## 3. Endpoint tiers

🌐 public · 🔑 login · 🔒 login + ownership · ⚙️ machine · 👑 operator

**The entire read surface is public and stays public.** A track record anyone
can inspect is the product, not a feature behind a login. Public endpoints also
keep working when auth is misconfigured (§5).

### agent-service `:3001`

| Endpoint | Tier |
|---|---|
| `GET /healthz` | 🌐 |
| `GET /v1/agents`, `GET /v1/agents/:id` | 🌐 |
| `GET /v1/agents/:id/passport` · `/dna` · `/dna/similar` · `/evolution` · `/autopsy` | 🌐 |
| `GET /v1/agents/:id/series/score` · `/series/nav` · `/decisions` | 🌐 (see docs/series-endpoints.md) |
| `GET /v1/creators`, `GET /v1/creators/:id`, `GET /v1/creators/:id/agents` | 🌐 |
| `GET /v1/theses/recent` · `GET /v1/theses/:id` · `GET /v1/creators/:id/theses` · `GET /v1/creators/:id/articles` · `GET /v1/articles` · `GET /v1/articles/:id` · `GET /v1/agents/:id/articles` | 🌐 (see docs/theses.md) |
| `GET /v1/forum/boards` · `/boards/:slug/threads` · `/threads/:id` · `/threads/:id/posts` · `GET /v1/articles/:id/comments` · `GET /v1/creators/:id/threads` | 🌐 (see docs/forum.md) |
| `GET /v1/seasons`, `/:id` | 🌐 |
| `GET /v1/competitions`, `/:id`, `/:id/ticks`, `/:id/tick/open` | 🌐 |
| `GET /v1/auth/nonce` · `POST /v1/auth/verify` · `/refresh` · `/logout` | 🌐 (they are how you sign in) |
| `POST /v1/agents` | 🔑 |
| `POST /v1/creators` | 🔑 |
| `GET /v1/auth/me` · `POST /v1/auth/logout-all` | 🔑 |
| `PATCH /v1/creators/:id` | 🔒 self |
| `PATCH /v1/agents/:id` | 🔒 |
| `POST /v1/agents/:id/activate` | 🔒 + $ARCA `create` |
| `POST /v1/agents/:id/evolve` | 🔒 + $ARCA `evolve` |
| `POST /v1/agents/:id/retire` | 🔒 |
| `POST /v1/agents/:id/decisions` | 🔒 |
| `POST /v1/theses` | 🔒 owner of `linked_agent_id`, 10/hour per wallet |
| `POST /v1/articles` | 🔑 + creator profile, 30/hour per wallet |
| `PATCH /v1/articles/:id` | 🔒 author |
| `POST /v1/forum/threads` | 🔑 + creator profile, 10/hour per wallet |
| `POST /v1/forum/threads/:id/posts` · `POST /v1/articles/:id/comments` | 🔑 + creator profile, 60/hour per wallet |
| `PATCH /v1/forum/threads/:id` · `PATCH /v1/forum/posts/:id` | 🔒 author |
| `POST`/`DELETE` `/v1/forum/threads/:id/reactions/:kind` · `/v1/articles/:id/reactions/:kind` | 🔑 + creator profile, 300/hour per wallet |
| `POST /v1/forum/threads/:id/reports` · `/posts/:id/reports` · `/v1/articles/:id/reports` | 🔑 + creator profile, 30/hour per wallet |
| `POST …/hide` · `…/unhide` on a thread, post or article | 🔒 operator **or** the author it sits under (see docs/forum.md) |
| `GET /v1/me/reactions` · `/v1/me/saved` · `/v1/me/threads` | 🔑 + creator profile |
| `GET /v1/moderation/reports` | 👑 |
| `POST /v1/seasons` · `PATCH /v1/seasons/:id` | 👑 |
| `POST /v1/competitions` · `POST /v1/competitions/:id/complete` | 👑 |
| `POST /internal/v1/competitions/:id/ticks` · `/ticks/close` | ⚙️ |
| `POST /internal/v1/competitions/:id/participants/reconcile` | ⚙️ |
| `GET /internal/v1/agents/due` (optional `?as_of=`) | ⚙️ |
| `POST /v1/subscriptions/:id/wallet` | 🔒 buyer |
| `GET /v1/subscriptions/:id/book` | 🔒 buyer |
| `PATCH /v1/subscriptions/:id` | 🔒 buyer |
| `POST /v1/subscriptions/:id/wallet/export` | 🔒 buyer |
| `POST /internal/v1/agents/dna/compute` | ⚙️ |
| `POST /internal/v1/theses/resolve` | ⚙️ |

🔒 buyer is the `user_wallet` on the subscription, and NOT scoped by status: a
lapsed buyer must still be able to read what they hold and take the key. See
`docs/subscription-trading.md`.

### arca-service `:3004`

| Endpoint | Tier |
|---|---|
| `GET /healthz` | 🌐 |
| `GET /v1/subscriptions/:userWallet` | 🔒 self |
| `GET /v1/arca/accounts/:userId` | 🔒 self |
| `GET /v1/arca/access` · `GET /v1/arca/entitlements/check` | ⚙️ |
| `POST /internal/v1/payments/claims` | ⚙️ (marketplace calls it; the buyer wallet is a fact it proved, not a field it forwarded) |
| `GET /internal/v1/payments/quote` | ⚙️ — what a buyer must send and to whom. Fronted publicly by `GET /v1/marketplace/listings/:id/quote`; canonical here because the payee and the amount come from the rows the *verification* reads |
| `GET /internal/v1/payments/payable` | ⚙️ — can this agent's creator receive a payment at all? Asked by marketplace before publishing a listing, so a listing with no payee is never created |
| `GET /internal/v1/payments/unclaimed` | ⚙️ — transfers this buyer already made to this creator. **Grants nothing**: candidate hashes only, and claiming one still passes every check. The wallet searched is the session's, passed as a proven fact |
| `GET /internal/v1/chain/balances` | ⚙️ — what one address holds: the settlement token and the native gas, each with its own `available` so a failed read is never rendered as a balance of zero. Machine tier because the map from an agent to its wallet is not public; agent-service fronts it for the owner |
| `GET /internal/v1/creators/:id/earnings` | ⚙️ — what a creator has been paid, summed over `payment_claims` (money) and never over `subscriptions` (access). agent-service fronts it, having proved the caller owns the creator profile — this service does not hold the session and must not be the thing deciding who may read somebody’s revenue |
| `POST /internal/v1/payments/reminder/run` | ⚙️ |

### marketplace `:3002`

| Endpoint | Tier |
|---|---|
| `GET /healthz` · `GET /v1/marketplace/listings` · `/agents` · `/listings/:id` | 🌐 |
| `POST /v1/marketplace/listings` | 🔒 owner of the agent being listed |
| `PATCH /v1/marketplace/listings/:id` | 🔒 owner of the listing |
| `GET /v1/marketplace/listings/:id/quote` | 🌐 — the payee and the price. Public because a buyer needs both before signing in and neither is secret; it closes a payment-redirection hole, since the address otherwise came from outside the platform |
| `GET /v1/marketplace/listings/:id/unclaimed-payments` | 🔒 self — payments you already made, for the buyer who closed the tab. Grants nothing |
| `POST /v1/marketplace/listings/:id/claim-payment` | 🔑 (claiming wallet from session, never the body) |
| `GET /v1/marketplace/listings/:id/access` | 🔒 self |

### scoring-engine `:8082` · market-data `:8083` · decision-engine `:8081`

| Endpoint | Tier |
|---|---|
| `GET /healthz` · `GET /v1/leaderboard` · `GET /v1/agents/:id/score` | 🌐 |
| `GET /v1/market/universe` · `/snapshots/{ref}` · `/snapshots/{ref}/previous` | 🌐 |
| `POST /internal/v1/scoring/batch` | ⚙️ |
| `POST /internal/v1/market/sessions/daily` · `/backfill` | ⚙️ |
| `POST /internal/v1/market/snapshots/prices` | ⚙️ |
| `POST /internal/v1/decisions/execute` · `/manual` | ⚙️ |

### Two endpoints that moved

`POST /internal/v1/decisions/manual` was a **human** action sitting on a prefix
that means "machines only". The user-facing door is now
`POST /v1/agents/:id/decisions` on agent-service, where sessions and ownership
live; agent-service forwards to the engine with the machine key. The engine
never learns about wallets.

`POST /v1/competitions/:id/ticks` and `/ticks/close` moved to `/internal/`.
Opening and closing a tick is the platform running a competition, not a user
acting on one, and they were reachable by anyone who could reach the port — an
extra tick could be opened or a live one closed mid-window. **A competition must
never require a user to be logged in**; the scheduler presents the machine key
and runs unattended exactly as before.

### The machine tier has two layers

1. every service binds to **`127.0.0.1`** — a leaked key is useless off-box, and
   a firewall mistake cannot expose these endpoints;
2. **`X-Internal-Key`**, compared in constant time.

Either alone is thin: a leaked key with services on `0.0.0.0` is full access,
and localhost-only with no key trusts every process on the box.

A missing `INTERNAL_API_KEY` is **never** a pass — it yields 503. That does mean
the scheduler stops until it is configured, which is the correct failure: a tick
that opens because a secret was missing is worse than a tick that does not open
and says why.

### The operator tier

`AUTH_ADMIN_WALLETS` is an allowlist of addresses, checked **after** SIWE, so
every operator action is attributable to a wallet that proved itself. An empty
allowlist denies everyone — it never means everyone is allowed.

---

## 4. Ownership, and why it is separate from $ARCA

Two questions, asked in this order, never merged:

```ts
await this.ownership.assertOwnsAgent(wallet, id);   // is this yours?          403 forbidden_not_owner
await this.entitlements.require('evolve', ...);     // do you hold enough $ARCA? 403 entitlement_denied_evolve
```

They have different answers, different remedies and different messages. Someone
who owns the agent but lacks $ARCA needs a different sentence from someone
holding plenty of $ARCA and reaching for another person's agent. A single
`isAllowed()` helper would erase that distinction.

A wallet owns an agent when **all three** hold: the agent has a creator, that
creator has a non-NULL `wallet_verified_at`, and that creator is not a frozen
seed row. The rule lives once, in `@arcana/auth`'s `resolveAgentOwnership`, and
both agent-service and marketplace call it. It is not reimplemented per service
— this codebase has already paid for that mistake, when marketplace kept its own
copy of the listing-access rule, drifted from arca-service's, and denied paying
users through the entire grace window.

**Entitlements are now charged to the caller by construction.** `activate()` and
`evolve()` read the wallet via the agent's creator. Before auth, that meant a
stranger evolving someone else's agent spent the *victim's* entitlement. Because
ownership is asserted first, the agent's creator is provably the caller — this
is now correct on purpose, not by accident.

---

## 5. Failure modes — 401 vs 403 vs 502 vs 503

| Status | Code | Means |
|---|---|---|
| 401 | `unauthenticated` | no token, or the token is invalid/expired |
| 403 | `forbidden_not_owner` | signed in, but this is not yours |
| 403 | `forbidden_not_admin` | signed in, but this is an operator action |
| 403 | `forbidden_legacy_readonly` | it exists, but nobody owns it (§6) |
| 403 | `forbidden_internal` | machine-only endpoint, key absent or wrong |
| 403 | `entitlement_denied_*` | you own it, but you lack the $ARCA |
| 502 | `entitlement_check_unavailable` | arca-service could not answer |
| 503 | `auth_unavailable` | **we could not check at all** |

All use the §8 envelope `{error:{code,message,trace_id}}`.

**503 is the one that matters.** It is raised when the signing key is missing or
too short, the internal key is unset, or an ownership lookup fails against the
database. Its message says the request was *neither allowed nor denied*.

Answering 401 there would tell a signed-in user "you are not logged in" when the
truth is "we are broken" — the same clean-looking lie that the marketplace's
`hasAccess` and the entitlement 502 were fixed to stop telling. And returning
200 would grant access nobody checked. Neither fail-open nor a fail-closed that
impersonates a permission error.

**Public reads are unaffected by any of it.** Verified: with a deliberately
broken signing key, `/v1/agents`, `/v1/creators`, `/v1/seasons`,
`/v1/competitions`, passport, evolution and autopsy all returned 200 while every
protected endpoint returned 503.

### Which origin sign-in is for

The domain and uri are read from `.env.siwe` at the repository root, which BOTH
systemd units load and every verification run sources. They used to be written
in the agent unit, the web unit and eight suites — a decision made eleven times,
where any place that was missed would sign for a site that no longer exists and
fail somewhere with nothing to do with domains.

They must equal the origin the browser is actually on. The sign-in page compares
them against its own host and refuses to sign when they differ, because a
message naming a domain the visitor is not on is the exact thing EIP-4361’s
domain field exists to let them catch.

### Boot log

Each service states its posture at startup, alongside arca-service's five
warnings and market-data's vendor warning:

```
auth ACTIVE: HS256 access tokens enforced, ttl=900s, refresh ttl=2592000s, chains=[4663,46630], admin wallets=0
SIWE sign-in ACTIVE: domain=arcana-arena.com, uri=https://arcana-arena.com, nonce ttl=300s
internal (machine) tier ACTIVE: X-Internal-Key required on /internal/*
WARN: auth configuration: AUTH_ADMIN_WALLETS is empty — no wallet can perform admin actions
```

and when it cannot run:

```
WARN: auth INACTIVE: AUTH_JWT_SIGNING_KEY is shorter than 32 bytes — refusing to
sign with a guessable key. Every protected endpoint will reject with 503
auth_unavailable — INACTIVE does NOT mean open. Public reads are unaffected.
```

**INACTIVE never means open.** Anyone reading this journal in six months must
not have to guess whether a warning meant "unguarded" or "closed".

---

## 6. Legacy creators — frozen, and why there is no claim endpoint

Migration `0023_auth` marks every creator that existed before auth as
`origin='legacy_seed'`, `wallet_verified_at=NULL`, and **withdraws its wallet**
into `legacy_wallet_note` (an audit record; nothing reads it for access).

The obvious migration would be "sign with the wallet on record to claim your
creator". That is exactly what must not be built here.

`dummy_creator` — owner of all nine existing agents — carried
`0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC`. **That is Anvil/Hardhat's default
account #2, whose private key is published in the Foundry documentation and
thousands of tutorials.** A claim-by-signature endpoint would not be a
safeguard; it would be a race, handing every existing agent to whoever noticed
first. `algo_trader` had no wallet at all and no agents.

So the wallet is withdrawn rather than guarded, and these rows are frozen:

- **readable forever** — leaderboard, profile, passport, DNA, evolution, autopsy
  all continue to serve them;
- **writable by nobody** — every mutating path returns 403
  `forbidden_legacy_readonly`, including to a signed-in caller;
- **competing normally** — ownership is checked only on user-facing writes.
  Scheduler, scoring, ticks and leaderboard never consult it, so the agents in
  Season 2 were untouched by this migration.

Taking one over is a manual SQL statement, run by the operator after signing in
with a real wallet. Deliberately not something the API can do.

**There is no ownership-claim endpoint, in any form.** Do not add one without
first resolving the wallet above.

---

## 7. Configuration

Secrets live in `/home/ubuntu/arcana/.env.auth`, mode `600`, referenced by
`EnvironmentFile=`. They are never committed and never inline in a unit file —
unit files are world-readable (`644`) and `systemctl show` prints `Environment=`
to any user.

| Variable | Secret | Notes |
|---|---|---|
| `AUTH_JWT_SIGNING_KEY` | yes | ≥32 bytes; shorter is refused, not silently accepted |
| `INTERNAL_API_KEY` | yes | shared by all services and the scheduler |
| `AUTH_SIWE_DOMAIN` / `AUTH_SIWE_URI` | no | matched exactly against the signed message |
| `AUTH_ALLOWED_CHAIN_IDS` | no | default `4663,46630` |
| `AUTH_ACCESS_TTL_SECONDS` | no | default 900 |
| `AUTH_REFRESH_TTL_SECONDS` | no | default 2592000 |
| `AUTH_NONCE_TTL_SECONDS` | no | default 300 |
| `AUTH_ISSUED_AT_SKEW_SECONDS` | no | default 300 |
| `AUTH_ADMIN_WALLETS` | no | comma-separated; empty denies everyone |

---

## 8. Known limits of v1 — stated, not discovered

- **EOA signatures only.** Verification is secp256k1 recovery. A
  smart-contract wallet (ERC-4337 or otherwise) signs via **EIP-1271 and will be
  rejected**. `SiweVerifier` is shaped to take a 1271 branch without disturbing
  the field checks, but v1 does not have one.
- **15-minute revocation window** on access tokens (§2).
- **HS256 is symmetric**, so every service holding the key can also mint tokens.
  Acceptable while all three are first-party; moving to EdDSA would let
  verifiers hold only a public key.
- **No rate limiting.** `/v1/auth/nonce` and `/v1/auth/verify` are unmetered.
  This belongs in the gateway when one exists.
- **Creator moderation is unreachable.** `status` (active/suspended/banned) was
  removed from `UpdateCreatorDto` because it was self-settable — a creator could
  un-ban themselves. It now has no API surface at all and needs an operator
  endpoint of its own.
- **No competition registration.** `competitions.participant_ids` is set at
  creation and there is no self-service way in, so "register my agent" has no
  endpoint to protect yet.
- **Email / OAuth** — deliberately absent (§1).

---

## 9. Re-running the verification

```bash
cd /home/ubuntu/arcana && node infra/verify/auth-verify.mjs
```

**65 checks since 2026-09-10** (was 63). The §10 payout route was retired, so
the two checks asserting its internal-key guard were testing a route that no
longer exists. They were replaced rather than dropped: the guard assertion moved
to the still-live reminder route, and new checks prove the retired routes are
**gone** — 404 even with a valid credential, which is the only refusal that
cannot be reverted by editing configuration.

The deposit-address check was, for one phase, weaker than that: the route still
existed and the suite asserted it refused **by decision**, its message saying
`retired` and specifically not `not configured`. That distinction mattered
while `docs/arca-go-live.md` was still a written procedure telling somebody to
fill in `ARCA_MASTER_PRIVATE_KEY`. On 2026-09-11 the route was removed outright
along with the rest of the §10 subsystem, so the assertion tightened with it:
404, checked **with a valid session token** on purpose, because a 401 would
also read as "not usable" while hiding a route still sitting behind the guard.

A companion suite covers the subscription access rule:

```bash
cd /home/ubuntu/arcana && node infra/verify/access-flow-verify.mjs
```

11 checks over `active → grace → expired`, including the one that is easy to
get wrong and silent when broken: **access survives expiry for the whole 48-hour
grace window and then stops**. It exists because `subscriptions` lives inside the
retired §10 module and must not be deleted by association.

63 checks: public reachability, 401 for anonymous callers, 403 for a signed-in
non-owner, non-admin and legacy writes, forged/stale/wrong-domain/wrong-chain
signatures, sequential and **concurrent** nonce replay, refresh rotation and
family revocation, `alg:none` and tampered tokens, machine-tier refusals with
absent and wrong keys, and self-only wallet reads.

It creates two throwaway wallets and their creators/agents, and **removes them
itself**. Nothing to run afterwards.

The hand-run `auth-verify-cleanup.sql` that used to live here is gone, and its
absence is the point. It had to be remembered, so it was not: 42 agents and 81
creators accumulated behind it. Worse, it selected on `handle LIKE
'verify_alice_%'` — matching fixtures by NAME, which missed every suite whose
handles nobody had listed and pointed squarely at `Phase 8c buy leg`, the one
agent holding a wallet that trades.

Rows created through the verification path now carry `provenance = 'verification'`
(migration 0042, set once and frozen by a trigger), and every suite registers
`sweepFixtures()` on the process exit event — not in a `finally`, because
`process.exit()` skips those, and a suite exits that way exactly when it has
failed. The sweep selects on the mark, so a run also clears whatever an earlier
crashed run abandoned. See `docs/data-resets.md`, 2026-09-12.

Every check must **refuse** something. A gate that has never said no has not
been tested — see `docs/arca-go-live.md`.
