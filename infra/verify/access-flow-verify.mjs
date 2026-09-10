/**
 * ARCANA subscription access flow verification.
 *
 * WHY THIS EXISTS. The §10 payment subsystem was retired on 2026-09-10, and
 * `subscriptions` sits in the middle of it — same migration, same module, same
 * directory. It is NOT part of that retirement: it is the access record, and
 * `GET /v1/arca/access` is the single place the grace rule lives.
 *
 * Neighbouring code is how things get deleted by association. So the rule is
 * pinned here, by exercising it rather than by asserting it exists:
 *
 *     active  -> access granted
 *     grace   -> access STILL granted    <- the one that is easy to get wrong
 *     expired -> access revoked
 *
 * The grace case is the whole reason this file is worth having. A grace period
 * that only relabels an already locked-out subscription is not a grace period,
 * and the marketplace once kept its own copy of this rule which denied access
 * for the entire window. One rule, one owner, proven to behave.
 *
 * It also checks that the reminder job — which writes those transitions — is
 * still the thing that moves a subscription between states. The payout job was
 * retired with the rest of §10; the reminder job was not, and the difference
 * matters because access depends on it.
 *
 * READ-WRITE, on purpose: it inserts subscription rows and deletes them again.
 * Every row it creates carries a wallet prefixed `0xACCE55` so a leftover is
 * identifiable at a glance, and the cleanup runs even when a check fails.
 *
 * Usage (on the VPS, from the repo root):
 *   node infra/verify/access-flow-verify.mjs
 * Exits non-zero if any case behaves differently from the rule.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ARCA = process.env.ARCA_URL || 'http://127.0.0.1:3004';
const PG_CONTAINER = process.env.PG_CONTAINER || 'arcana-postgres';
const ENV_FILE = process.env.AUTH_ENV || '/home/ubuntu/arcana/.env.auth';

const env = Object.fromEntries(
  readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const INTERNAL_KEY = env.INTERNAL_API_KEY;
if (!INTERNAL_KEY) {
  console.error('access-flow-verify: INTERNAL_API_KEY missing from ' + ENV_FILE);
  process.exit(1);
}

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name} — ${detail}`); console.log(`  FAIL  ${name} — ${detail}`); }
}

const sql = (q) =>
  execFileSync('docker', ['exec', PG_CONTAINER, 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc', q],
    { encoding: 'utf8' }).trim();

async function accessFor(wallet, listingId) {
  const r = await fetch(`${ARCA}/v1/arca/access?userWallet=${wallet}&listingId=${listingId}`, {
    headers: { 'X-Internal-Key': INTERNAL_KEY },
  });
  if (!r.ok) return { httpError: r.status };
  return r.json();
}

const WALLET = '0xACCE55' + '0'.repeat(35).slice(0, 34);
let listingId = null;

try {
  // A listing to attach to. Any active one will do — this tests the access
  // rule, not the catalogue.
  listingId = sql("SELECT id FROM marketplace_listings WHERE active = true LIMIT 1");
  if (!listingId) {
    console.error('access-flow-verify: no active marketplace listing to test against.');
    process.exit(1);
  }
  console.log(`access-flow-verify: listing ${listingId}, wallet ${WALLET}\n`);

  const graceHours = 48; // ARCA_GRACE_HOURS default; the rule below must honour it

  console.log('=== 1. No subscription at all ===');
  sql(`DELETE FROM subscriptions WHERE user_wallet = '${WALLET}'`);
  check('unknown wallet → no access', (await accessFor(WALLET, listingId)).access === false,
    JSON.stringify(await accessFor(WALLET, listingId)));

  console.log('\n=== 2. active → access granted ===');
  sql(`INSERT INTO subscriptions (user_wallet, listing_id, expires_at, status)
       VALUES ('${WALLET}', '${listingId}', now() + interval '10 days', 'active')`);
  check('active subscription → access', (await accessFor(WALLET, listingId)).access === true);

  console.log('\n=== 3. grace → access STILL granted ===');
  console.log('    (a grace period that locks the user out is not a grace period)');
  sql(`UPDATE subscriptions SET status = 'grace', expires_at = now() - interval '1 hour'
       WHERE user_wallet = '${WALLET}'`);
  check('expired 1h ago, status grace → access still granted',
    (await accessFor(WALLET, listingId)).access === true);

  sql(`UPDATE subscriptions SET expires_at = now() - interval '${graceHours - 1} hours'
       WHERE user_wallet = '${WALLET}'`);
  check(`still inside the ${graceHours}h window → access still granted`,
    (await accessFor(WALLET, listingId)).access === true);

  console.log('\n=== 4. past the grace window → access revoked ===');
  sql(`UPDATE subscriptions SET expires_at = now() - interval '${graceHours + 2} hours'
       WHERE user_wallet = '${WALLET}'`);
  check(`${graceHours + 2}h past expiry → access revoked even while status still says grace`,
    (await accessFor(WALLET, listingId)).access === false);

  console.log('\n=== 5. expired → access revoked ===');
  sql(`UPDATE subscriptions SET status = 'expired' WHERE user_wallet = '${WALLET}'`);
  check('expired subscription → no access', (await accessFor(WALLET, listingId)).access === false);

  console.log('\n=== 6. canceled → access revoked ===');
  sql(`UPDATE subscriptions SET status = 'canceled', expires_at = now() + interval '10 days'
       WHERE user_wallet = '${WALLET}'`);
  check('canceled, even with time left → no access',
    (await accessFor(WALLET, listingId)).access === false);

  console.log('\n=== 7. the reminder job still writes the transitions ===');
  console.log('    (retired with §10 would have left access frozen in whatever state it was in)');
  sql(`UPDATE subscriptions SET status = 'active', expires_at = now() - interval '1 hour'
       WHERE user_wallet = '${WALLET}'`);
  const r = await fetch(`${ARCA}/internal/v1/payments/reminder/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Key': INTERNAL_KEY },
    body: '{}',
  });
  const body = await r.json().catch(() => ({}));
  // NestJS answers a POST with 201 by default, so assert 2xx rather than a
  // specific code. Pinning it to 200 made this fail on a run that worked.
  check('reminder job runs (route alive, not retired with the payout batch)',
    r.ok, `got ${r.status} ${JSON.stringify(body)}`);
  const after = sql(`SELECT status FROM subscriptions WHERE user_wallet = '${WALLET}'`);
  check('an expired-but-active subscription was moved to grace by the job',
    after === 'grace', `status is now '${after}'`);
  check('and access is still granted during that grace',
    (await accessFor(WALLET, listingId)).access === true);

  console.log('\n=== 8. the payout job is gone and stays gone ===');
  const p = await fetch(`${ARCA}/internal/v1/payments/payout/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Key': INTERNAL_KEY },
    body: '{}',
  });
  check('payout route → 404 with a valid internal key', p.status === 404, `got ${p.status}`);
} finally {
  const removed = sql(`WITH d AS (DELETE FROM subscriptions WHERE user_wallet = '${WALLET}' RETURNING 1)
                       SELECT count(*) FROM d`);
  console.log(`\naccess-flow-verify: cleaned up ${removed} test subscription row(s)`);
  const leftover = sql("SELECT count(*) FROM subscriptions WHERE user_wallet LIKE '0xACCE55%'");
  if (leftover !== '0') console.log(`access-flow-verify: WARNING ${leftover} test row(s) left behind`);
}

console.log(`\n========================================`);
console.log(`  PASS: ${pass}   FAIL: ${fail}`);
console.log(`========================================`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
