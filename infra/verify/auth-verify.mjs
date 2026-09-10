/**
 * ARCANA auth verification.
 *
 * Every check here must actually REFUSE something. A gate that has never said
 * no has not been tested (docs/arca-go-live.md).
 */
import { readFileSync } from 'node:fs';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const AGENT = 'http://127.0.0.1:3001';
const ARCA = 'http://127.0.0.1:3004';
const MKT = 'http://127.0.0.1:3002';
const SCORING = 'http://127.0.0.1:8082';
const MARKETDATA = 'http://127.0.0.1:8083';
const DECISION = 'http://127.0.0.1:8081';

const DOMAIN = 'arcana.local';
const URI = 'https://arcana.local';
const CHAIN_ID = 4663;

const env = Object.fromEntries(
  readFileSync('/home/ubuntu/arcana/.env.auth', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const INTERNAL_KEY = env.INTERNAL_API_KEY;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(`${name} — ${detail}`);
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}

async function req(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  // Headers are returned so a caller can read Retry-After. Added when the
  // nonce endpoint became rate limited: backing off correctly requires the
  // number the server already sends, and guessing it is how a client ends up
  // polling a limit it is trying to respect.
  return { status: res.status, body, headers: res.headers };
}

const errCode = (b) => b?.error?.code ?? b?.message ?? JSON.stringify(b)?.slice(0, 120);

/**
 * Fetch a nonce, waiting out the rate limit rather than failing under it.
 *
 * `GET /v1/auth/nonce` became rate limited in phase 12 — 20/min per IP,
 * because it is unauthenticated and writes a database row per call. This suite
 * signs in many times to exercise the auth surface, so it runs into that limit
 * legitimately, and the first run after the limiter shipped failed seven
 * checks: bob could not sign in at all, and four ownership checks read
 * `401 unauthenticated` instead of `403 forbidden_not_owner` — a cascade that
 * looks like an authorisation bug and is not one.
 *
 * The suite waits, using the Retry-After the endpoint already returns. The
 * alternative — exempting loopback from the limiter — would be far worse than
 * a slow test: put a reverse proxy in front of these services later and every
 * request arrives from 127.0.0.1, silently disabling rate limiting for the
 * whole platform on the day it is most needed.
 */
async function getNonce() {
  let r = await req(`${AGENT}/v1/auth/nonce`);
  if (r.status === 429) {
    const wait = Math.min(70, Number(r.headers?.get?.('retry-after') ?? 60) + 2);
    console.log(`  (nonce allowance spent; waiting ${wait}s, as a client should)`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    r = await req(`${AGENT}/v1/auth/nonce`);
  }
  return r.body?.nonce;
}

async function signIn(account, overrides = {}) {
  const nonce = overrides.nonce ?? (await getNonce());
  const message = createSiweMessage({
    address: account.address,
    chainId: overrides.chainId ?? CHAIN_ID,
    domain: overrides.domain ?? DOMAIN,
    nonce,
    uri: overrides.uri ?? URI,
    version: '1',
    issuedAt: overrides.issuedAt ?? new Date(),
    statement: 'Sign in to ARCANA.',
  });
  const signature = overrides.signature ?? (await account.signMessage({ message }));
  const r = await req(`${AGENT}/v1/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  });
  return { ...r, message, signature, nonce };
}

const bearer = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

// ---------------------------------------------------------------------------

console.log('\n=== 1. Public surface is reachable with NO credentials ===');
for (const [name, url] of [
  ['agents list', `${AGENT}/v1/agents`],
  ['creators list', `${AGENT}/v1/creators`],
  ['seasons list', `${AGENT}/v1/seasons`],
  ['competitions list', `${AGENT}/v1/competitions`],
  ['leaderboard', `${SCORING}/v1/leaderboard`],
  ['market universe', `${MARKETDATA}/v1/market/universe`],
  ['marketplace listings', `${MKT}/v1/marketplace/listings`],
  ['marketplace discover', `${MKT}/v1/marketplace/agents`],
]) {
  const r = await req(url);
  check(`${name} is public (200)`, r.status === 200, `got ${r.status}`);
}

// per-agent public reads
// PAGED, since 2026-09-11. These lists return { items, page, page_size,
// total, has_more } rather than a bare array — they were unbounded public
// reads, and one request serialising the whole table needed a ceiling.
//
// The shape change is real and this suite is where it was caught: it read
// the body as an array and died on .filter. Recorded here rather than
// papered over, because a previous commit message claimed nothing that
// worked would stop working, and that was wrong.
const agentsList = (await req(`${AGENT}/v1/agents?page_size=500`)).body.items;
const creatorsList = (await req(`${AGENT}/v1/creators?page_size=500`)).body.items;
const legacyCreatorIds = new Set(
  creatorsList.filter((c) => c.origin === 'legacy_seed').map((c) => c.id),
);
const legacyAgent = agentsList.find((a) => legacyCreatorIds.has(a.creatorId));
if (!legacyAgent) {
  console.error('no legacy-seed agent found — cannot verify the frozen path');
  process.exit(2);
}
for (const [name, path] of [
  ['profile', ''],
  ['passport', '/passport'],
  ['evolution', '/evolution'],
  ['autopsy', '/autopsy'],
]) {
  const r = await req(`${AGENT}/v1/agents/${legacyAgent.id}${path}`);
  check(`agent ${name} is public`, r.status === 200, `got ${r.status}`);
}

// DNA is public, but a row only exists once the batch has computed it, so 404
// is a legitimate answer for a fresh agent. The property under test is that it
// is never GATED — no agent may answer 401/403.
{
  let dnaOk = 0;
  let dnaGated = 0;
  for (const a of agentsList) {
    const r = await req(`${AGENT}/v1/agents/${a.id}/dna`);
    if (r.status === 200) dnaOk++;
    if (r.status === 401 || r.status === 403) dnaGated++;
  }
  check(
    `agent dna is never gated (checked ${agentsList.length} agents)`,
    dnaGated === 0,
    `${dnaGated} returned 401/403`,
  );
  check(
    `agent dna readable without login where computed (${dnaOk} agents)`,
    dnaOk > 0,
    'no agent returned 200',
  );
}

console.log('\n=== 1b. Public lists are bounded ===');
// These four are public, unauthenticated, and used to return every row. The
// rate limiter bounds how OFTEN one request happens; it does nothing about how
// much one costs. Both are needed, and only one existed.
for (const [name, url] of [
  ['agents', `${AGENT}/v1/agents`],
  ['creators', `${AGENT}/v1/creators`],
  ['seasons', `${AGENT}/v1/seasons`],
  ['competitions', `${AGENT}/v1/competitions`],
]) {
  const r = await req(url);
  const b = r.body;
  check(`${name} list is paged, not an unbounded array`,
    b !== null && typeof b === 'object' && Array.isArray(b.items) &&
    typeof b.total === 'number' && typeof b.has_more === 'boolean',
    JSON.stringify(b)?.slice(0, 80));

  // REFUSED, not clamped. A caller asking for 100000 has a belief about what
  // they are getting, and silently handing them 500 rows means they process a
  // fraction of the data and never find out.
  const over = await req(`${url}?page_size=100000`);
  check(`${name} refuses an out-of-range page_size rather than clamping`,
    over.status === 400 && /invalid_page_size/.test(errCode(over.body)),
    `${over.status} ${errCode(over.body)}`);
}

console.log('\n=== 2. Protected endpoints refuse anonymous callers (401) ===');
for (const [name, url, method] of [
  ['create agent', `${AGENT}/v1/agents`, 'POST'],
  ['create creator', `${AGENT}/v1/creators`, 'POST'],
  ['activate agent', `${AGENT}/v1/agents/${legacyAgent.id}/activate`, 'POST'],
  ['evolve agent', `${AGENT}/v1/agents/${legacyAgent.id}/evolve`, 'POST'],
  ['retire agent', `${AGENT}/v1/agents/${legacyAgent.id}/retire`, 'POST'],
  ['auth me', `${AGENT}/v1/auth/me`, 'GET'],
]) {
  const r = await req(url, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
  check(`${name} → 401`, r.status === 401 && r.body?.error?.code === 'unauthenticated', `got ${r.status} ${errCode(r.body)}`);
}

console.log('\n=== 3. Admin tier refuses a signed-in non-admin (403) ===');
const alice = privateKeyToAccount(generatePrivateKey());
const bob = privateKeyToAccount(generatePrivateKey());

const aliceSession = await signIn(alice);
check('alice signs in', aliceSession.status === 200, `got ${aliceSession.status} ${errCode(aliceSession.body)}`);
const aliceToken = aliceSession.body.access_token;

const seasonAttempt = await req(`${AGENT}/v1/seasons`, {
  method: 'POST',
  headers: bearer(aliceToken),
  body: JSON.stringify({ name: 'should-not-exist', startAt: new Date().toISOString(), endAt: new Date(Date.now() + 86400000).toISOString() }),
});
check('non-admin create season → 403 forbidden_not_admin',
  seasonAttempt.status === 403 && seasonAttempt.body?.error?.code === 'forbidden_not_admin',
  `got ${seasonAttempt.status} ${errCode(seasonAttempt.body)}`);

console.log('\n=== 4. SIWE rejects forged / stale / replayed messages ===');

// forged signature: bob signs, message claims alice
{
  const nonce = await getNonce();
  const message = createSiweMessage({
    address: alice.address, chainId: CHAIN_ID, domain: DOMAIN, nonce, uri: URI,
    version: '1', issuedAt: new Date(), statement: 'Sign in to ARCANA.',
  });
  const signature = await bob.signMessage({ message });
  const r = await req(`${AGENT}/v1/auth/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  });
  check('forged signature (signer ≠ claimed address) → rejected', r.status === 401, `got ${r.status} ${errCode(r.body)}`);
}

// stale issuedAt
{
  const r = await signIn(alice, { issuedAt: new Date(Date.now() - 60 * 60 * 1000) });
  check('stale Issued At (1h old) → rejected', r.status === 401, `got ${r.status} ${errCode(r.body)}`);
}

// wrong domain
{
  const r = await signIn(alice, { domain: 'evil.example' });
  check('wrong domain → rejected', r.status === 401, `got ${r.status} ${errCode(r.body)}`);
}

// wrong uri
{
  const r = await signIn(alice, { uri: 'https://evil.example' });
  check('wrong URI → rejected', r.status === 401, `got ${r.status} ${errCode(r.body)}`);
}

// wrong chain id
{
  const r = await signIn(alice, { chainId: 1 });
  check('chainId 1 (not 4663/46630) → rejected', r.status === 401, `got ${r.status} ${errCode(r.body)}`);
}

// nonce reuse, sequential
{
  const nonce = await getNonce();
  const first = await signIn(bob, { nonce });
  const second = await signIn(bob, { nonce });
  check('nonce first use succeeds', first.status === 200, `got ${first.status} ${errCode(first.body)}`);
  check('nonce REUSE → rejected', second.status === 401, `got ${second.status} ${errCode(second.body)}`);
}

// nonce reuse, concurrent — this is what proves UPDATE...RETURNING, not SELECT-then-UPDATE
{
  const nonce = await getNonce();
  const msg = createSiweMessage({
    address: bob.address, chainId: CHAIN_ID, domain: DOMAIN, nonce, uri: URI,
    version: '1', issuedAt: new Date(), statement: 'Sign in to ARCANA.',
  });
  const sig = await bob.signMessage({ message: msg });
  const fire = () => req(`${AGENT}/v1/auth/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg, signature: sig }),
  });
  const results = await Promise.all([fire(), fire(), fire(), fire(), fire()]);
  const ok = results.filter((r) => r.status === 200).length;
  check(`5 concurrent requests on ONE nonce → exactly 1 succeeds (got ${ok})`, ok === 1,
    `statuses: ${results.map((r) => r.status).join(',')}`);
}

console.log('\n=== 5. Refresh rotation and reuse detection ===');
{
  const s = await signIn(bob);
  const r1 = s.body.refresh_token;
  const rot = await req(`${AGENT}/v1/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: r1 }),
  });
  check('refresh rotates to a new pair', rot.status === 200 && rot.body.refresh_token !== r1,
    `got ${rot.status} ${errCode(rot.body)}`);
  const r2 = rot.body.refresh_token;

  const replay = await req(`${AGENT}/v1/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: r1 }),
  });
  check('reusing the OLD refresh token → 401', replay.status === 401, `got ${replay.status} ${errCode(replay.body)}`);

  const afterRevoke = await req(`${AGENT}/v1/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: r2 }),
  });
  check('reuse revokes the WHOLE family (the good token dies too) → 401',
    afterRevoke.status === 401, `got ${afterRevoke.status} ${errCode(afterRevoke.body)}`);
}

console.log('\n=== 6. Tampered / expired access tokens ===');
{
  const bad = aliceToken.slice(0, -4) + 'AAAA';
  const r = await req(`${AGENT}/v1/auth/me`, { headers: bearer(bad) });
  check('tampered token signature → 401', r.status === 401, `got ${r.status} ${errCode(r.body)}`);

  const [h, p] = aliceToken.split('.');
  const noneTok = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
  const r2 = await req(`${AGENT}/v1/auth/me`, { headers: bearer(noneTok) });
  check('alg:none token → 401', r2.status === 401, `got ${r2.status} ${errCode(r2.body)}`);
}

console.log('\n=== 7. Ownership: 403 for a signed-in non-owner ===');
const aliceCreator = await req(`${AGENT}/v1/creators`, {
  method: 'POST', headers: bearer(aliceToken),
  body: JSON.stringify({ handle: `verify_alice_${Date.now().toString(36)}` }),
});
check('alice creates her creator profile', aliceCreator.status === 201, `got ${aliceCreator.status} ${errCode(aliceCreator.body)}`);

const aliceAgent = await req(`${AGENT}/v1/agents`, {
  method: 'POST', headers: bearer(aliceToken),
  body: JSON.stringify({ name: `verify_agent_${Date.now().toString(36)}`, assetUniverse: 'us_equity' }),
});
check('alice creates an agent', aliceAgent.status === 201, `got ${aliceAgent.status} ${errCode(aliceAgent.body)}`);
const aliceAgentId = aliceAgent.body?.id;

const bobSession = await signIn(bob);
const bobToken = bobSession.body.access_token;
await req(`${AGENT}/v1/creators`, {
  method: 'POST', headers: bearer(bobToken),
  body: JSON.stringify({ handle: `verify_bob_${Date.now().toString(36)}` }),
});

if (aliceAgentId) {
  for (const [name, path, method] of [
    ['evolve', `/evolve`, 'POST'],
    ['activate', `/activate`, 'POST'],
    ['retire', `/retire`, 'POST'],
    ['patch', ``, 'PATCH'],
  ]) {
    const r = await req(`${AGENT}/v1/agents/${aliceAgentId}${path}`, {
      method, headers: bearer(bobToken),
      body: method === 'PATCH' ? JSON.stringify({ name: 'hijacked' }) : JSON.stringify({}),
    });
    check(`bob ${name} on alice's agent → 403 forbidden_not_owner`,
      r.status === 403 && r.body?.error?.code === 'forbidden_not_owner',
      `got ${r.status} ${errCode(r.body)}`);
  }

  const ownOk = await req(`${AGENT}/v1/agents/${aliceAgentId}`, {
    method: 'PATCH', headers: bearer(aliceToken),
    body: JSON.stringify({ strategyType: 'momentum' }),
  });
  check('alice CAN patch her own agent (gate is not blanket-deny)', ownOk.status === 200,
    `got ${ownOk.status} ${errCode(ownOk.body)}`);
}

console.log('\n=== 8. Legacy creators are frozen for everyone ===');
{
  const r = await req(`${AGENT}/v1/agents/${legacyAgent.id}/retire`, {
    method: 'POST', headers: bearer(aliceToken), body: '{}',
  });
  check('legacy agent write → 403 forbidden_legacy_readonly',
    r.status === 403 && r.body?.error?.code === 'forbidden_legacy_readonly',
    `got ${r.status} ${errCode(r.body)}`);
}

console.log('\n=== 9. Bug #1: status can no longer be set through create/patch ===');
if (aliceAgentId) {
  const r = await req(`${AGENT}/v1/agents/${aliceAgentId}`, {
    method: 'PATCH', headers: bearer(aliceToken),
    body: JSON.stringify({ status: 'active' }),
  });
  check('PATCH {status:active} by the OWNER → rejected (400)', r.status === 400,
    `got ${r.status} ${errCode(r.body)}`);

  const r2 = await req(`${AGENT}/v1/agents`, {
    method: 'POST', headers: bearer(aliceToken),
    body: JSON.stringify({ name: 'sneaky', assetUniverse: 'us_equity', status: 'active' }),
  });
  check('POST agent with {status:active} → rejected (400)', r2.status === 400,
    `got ${r2.status} ${errCode(r2.body)}`);

  const r3 = await req(`${AGENT}/v1/agents`, {
    method: 'POST', headers: bearer(aliceToken),
    body: JSON.stringify({ name: 'sneaky2', assetUniverse: 'us_equity', creatorId: '00000000-0000-0000-0000-000000000000' }),
  });
  check('POST agent with a forged creatorId → rejected (400)', r3.status === 400,
    `got ${r3.status} ${errCode(r3.body)}`);
}

console.log('\n=== 10. Machine tier refuses callers without the key ===');
for (const [name, url] of [
  ['agent-service tick open', `${AGENT}/internal/v1/competitions/${'00000000-0000-0000-0000-000000000000'}/ticks`],
  ['agent-service dna compute', `${AGENT}/internal/v1/agents/dna/compute`],
  ['arca reminder run', `${ARCA}/internal/v1/payments/reminder/run`],
  ['scoring batch', `${SCORING}/internal/v1/scoring/batch`],
  ['decision execute', `${DECISION}/internal/v1/decisions/execute`],
  ['marketdata daily session', `${MARKETDATA}/internal/v1/market/sessions/daily`],
]) {
  const r = await req(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check(`${name} without key → 403 forbidden_internal`,
    r.status === 403 && r.body?.error?.code === 'forbidden_internal',
    `got ${r.status} ${errCode(r.body)}`);

  const rWrong = await req(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Key': 'wrong-key-of-the-same-sort' },
    body: '{}',
  });
  check(`${name} with WRONG key → 403`, rWrong.status === 403, `got ${rWrong.status} ${errCode(rWrong.body)}`);
}

// and the key actually works
{
  const r = await req(`${SCORING}/internal/v1/scoring/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Key': INTERNAL_KEY },
    body: '{}',
  });
  check('scoring batch WITH the key → allowed', r.status < 400, `got ${r.status} ${errCode(r.body)}`);
}

// Retired payment paths must STAY retired, and the two cases differ.
//
// The payout batch was removed on 2026-09-10 with the rest of the treasury and
// split model. Two checks above used to assert its internal-key guard; a guard
// on a route that no longer exists tests nothing, so they were replaced by the
// checks below, and the guard assertion moved to the reminder route, which is
// still live and still needs one.
//
// The deposit-address path USED to be asserted differently: it still existed,
// refusing by decision, because the live subscribe flow called it and its
// replacement was not yet proven. Phase 11 proved the replacement (22/22
// against real USDG transfers) and on 2026-09-11 the whole subsystem was
// removed. So the assertion changes with it: a route that refuses is a route
// that can be un-refused by editing one line, and 404 is the only refusal
// that cannot be reverted by a configuration change.
//
// Checked WITH a valid session token on purpose. A 401 would also be "not
// usable", and would hide the route still being there behind the guard.
console.log('\n=== 10b. Retired payment paths stay retired ===');
{
  const r = await req(`${ARCA}/internal/v1/payments/payout/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Key': INTERNAL_KEY },
    body: '{}',
  });
  check('payout batch route is gone even WITH a valid internal key → 404',
    r.status === 404, `got ${r.status} ${errCode(r.body)}`);

  const d = await req(`${ARCA}/v1/arca/deposit-address`, {
    method: 'POST', headers: bearer(aliceToken),
    body: JSON.stringify({ listingId: '00000000-0000-0000-0000-000000000000' }),
  });
  check('deposit-address route is GONE even WITH a valid session → 404',
    d.status === 404, `got ${d.status} ${errCode(d.body)}`);

  for (const path of ['listener/poll', 'listener/audit']) {
    const l = await req(`${ARCA}/internal/v1/payments/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': INTERNAL_KEY },
      body: '{}',
    });
    check(`${path} is gone even WITH a valid internal key → 404`,
      l.status === 404, `got ${l.status} ${errCode(l.body)}`);
  }
}

console.log('\n=== 11. Wallet-addressed reads are self-only ===');
{
  const r = await req(`${ARCA}/v1/subscriptions/${bob.address}`, { headers: bearer(aliceToken) });
  check("alice reading bob's subscriptions → 403 forbidden_not_owner",
    r.status === 403 && r.body?.error?.code === 'forbidden_not_owner', `got ${r.status} ${errCode(r.body)}`);

  const own = await req(`${ARCA}/v1/subscriptions/${alice.address}`, { headers: bearer(aliceToken) });
  check('alice reading her own subscriptions → allowed', own.status === 200, `got ${own.status} ${errCode(own.body)}`);

  const acct = await req(`${ARCA}/v1/arca/accounts/${bob.address}`, { headers: bearer(aliceToken) });
  check("alice reading bob's $ARCA account → 403", acct.status === 403, `got ${acct.status} ${errCode(acct.body)}`);
}

console.log('\n=== 12. Entitlement and auth stay separate ===');
if (aliceAgentId) {
  const r = await req(`${AGENT}/v1/agents/${aliceAgentId}/activate`, {
    method: 'POST', headers: bearer(aliceToken), body: '{}',
  });
  // Ownership passes; the $ARCA gate then decides. Today it allows (token
  // unlaunched), so this should NOT be a 403 of any kind.
  check('owner activate passes ownership and reaches the entitlement layer',
    r.status !== 403 || r.body?.error?.code?.startsWith('entitlement_denied'),
    `got ${r.status} ${errCode(r.body)}`);
}

console.log(`\n========================================`);
console.log(`  PASS: ${pass}   FAIL: ${fail}`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(`========================================\n`);
console.log(JSON.stringify({ aliceAgentId, aliceAddress: alice.address, bobAddress: bob.address }));
process.exit(fail === 0 ? 0 : 1);
