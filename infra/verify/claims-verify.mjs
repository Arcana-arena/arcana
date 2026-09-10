/**
 * ARCANA payment-claim verification.
 *
 * The marketplace is P2P with no fee: ARCANA never receives the money. A buyer
 * pays the creator directly and submits a transaction hash, and everything the
 * platform then believes has to come from the CHAIN.
 *
 * That inverts who is trusted. Under §10 the deposit address was ours, so a
 * payment could only arrive somewhere we controlled and a stranger could not
 * submit one. A transaction hash is PUBLIC the moment it is mined, so two
 * attacks are free to mount and neither needs any access to ARCANA:
 *
 *     claiming somebody else's payment
 *     spending one payment on many listings
 *
 * Both are mounted here, for real.
 *
 * NO MONEY IS SPENT. $ARCA has not launched, so the verifier is pointed at
 * USDG — a real ERC-20 on the same chain — and driven with REAL TRANSACTIONS
 * that already exist. Every "does this transaction say what the claimer says it
 * says" check runs against a transaction somebody else made, months ago,
 * for their own reasons. The conditions the chain cannot supply on demand (a
 * reverted transaction, an unreadable node) come from a controlled RPC that
 * speaks the same protocol — the technique the LLM and signer suites use.
 *
 * Usage (on the VPS, from the repo root):
 *   node infra/verify/claims-verify.mjs
 */
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const REPO = process.env.REPO || '/home/ubuntu/arcana';
const ARCA_PORT = Number(process.env.TEST_ARCA_PORT || 3094);
const RPC_PORT = Number(process.env.TEST_RPC_PORT || 3095);
const DEAD_RPC = Number(process.env.TEST_DEAD_RPC || 3096);
const REAL_RPC = 'https://robinhood-rpc.publicnode.com';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const AAPL_POOL = '0xaae0d815ee56e4092a5e5c2911e676fea50b2d6d';

const env = Object.fromEntries(
  readFileSync(`${REPO}/.env.auth`, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const KEY = env.INTERNAL_API_KEY;
const DB = 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';

const sql = (q) =>
  execFileSync('docker', ['exec', 'arcana-postgres', 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc', q],
    { encoding: 'utf8' }).trim();

let pass = 0, fail = 0;
const failures = [];
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; failures.push(`${n} — ${d}`); console.log(`  FAIL  ${n} — ${d}`); }
};

// --- find a REAL USDG transfer on chain -------------------------------------
let rpcId = 0;
const chain = async (method, params) => {
  const r = await fetch(REAL_RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function findRealTransfer() {
  // Poll the live window for a USDG transfer into the AAPL pool. Any real
  // transfer will do; what matters is that nobody made it for this test.
  for (let attempt = 0; attempt < 60; attempt++) {
    const head = Number(BigInt(await chain('eth_blockNumber', [])));
    let logs = [];
    try {
      logs = await chain('eth_getLogs', [{
        address: USDG, fromBlock: '0x' + (head - 18).toString(16), toBlock: '0x' + head.toString(16),
        topics: [TRANSFER],
      }]);
    } catch { /* archive limits; try again at the new head */ }
    const hit = logs.find((l) => l.topics.length >= 3 && BigInt(l.data || '0x0') > 0n);
    if (hit) {
      return {
        hash: hit.transactionHash,
        from: ('0x' + hit.topics[1].slice(-40)).toLowerCase(),
        to: ('0x' + hit.topics[2].slice(-40)).toLowerCase(),
        value: BigInt(hit.data),
        block: Number(BigInt(hit.blockNumber)),
      };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

// --- an RPC we control, for the conditions the chain will not supply --------
let mode = 'passthrough';
const controlled = createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', async () => {
    const j = JSON.parse(b || '{}');
    if (mode === 'dead') { res.writeHead(500).end('{}'); return; }
    try {
      let result = await chain(j.method, j.params);
      if (mode === 'reverted' && j.method === 'eth_getTransactionReceipt' && result) {
        result = { ...result, status: '0x0' };          // the same tx, reverted
      }
      if (mode === 'unmined' && j.method === 'eth_getTransactionReceipt') {
        result = null;                                   // mined -> pending
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }));
    } catch (e) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { code: -32000, message: String(e) } }));
    }
  });
});

// --- fixtures ---------------------------------------------------------------
const TAG = 'verify-claim';
let proc = null, creatorId = null, agentId = null, listingId = null, listingId2 = null;

function cleanup() {
  try {
    if (listingId) sql(`DELETE FROM payment_claims WHERE listing_id IN ('${listingId}','${listingId2}')`);
    if (listingId) sql(`DELETE FROM subscriptions WHERE listing_id IN ('${listingId}','${listingId2}')`);
    if (listingId) sql(`DELETE FROM marketplace_listings WHERE id IN ('${listingId}','${listingId2}')`);
    if (agentId) sql(`DELETE FROM agents WHERE id = '${agentId}'`);
    if (creatorId) sql(`DELETE FROM creators WHERE id = '${creatorId}'`);
  } catch (e) { console.log('  cleanup warning: ' + e.message); }
}

function startArca(extra = {}) {
  return spawn('node', ['dist/main.js'], {
    cwd: `${REPO}/services/arca-service`,
    env: { ...process.env, DATABASE_URL: DB, PORT: String(ARCA_PORT), INTERNAL_API_KEY: KEY,
           ARCA_TOKEN_ADDRESS: USDG, ARCA_TOKEN_DECIMALS: '6',
           ARCA_RPC_URL: `http://127.0.0.1:${RPC_PORT}`,
           ARCA_CLAIM_MIN_CONFIRMATIONS: '1', ARCA_CLAIM_MAX_AGE_HOURS: '24', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
async function stop() {
  if (!proc) return;
  proc.kill('SIGKILL');
  try { execFileSync('bash', ['-lc', `fuser -k ${ARCA_PORT}/tcp 2>/dev/null || true`]); } catch {}
  proc = null; await new Promise((r) => setTimeout(r, 1000));
}
async function waitUp(ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(`http://127.0.0.1:${ARCA_PORT}/healthz`); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 350));
  }
  return false;
}
const claim = async (userWallet, listing, txHash) => {
  const r = await fetch(`http://127.0.0.1:${ARCA_PORT}/internal/v1/payments/claims`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Key': KEY },
    body: JSON.stringify({ userWallet, listingId: listing, txHash }) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const code = (r) => r.body?.code || r.body?.message?.code || '';

try {
  console.log('claims-verify: looking for a real USDG transfer on chain...');
  const real = await findRealTransfer();
  if (!real) { console.error('claims-verify: no live USDG transfer found; cannot run'); process.exit(1); }
  console.log(`  found ${real.hash}`);
  console.log(`  ${real.from} -> ${real.to}, ${real.value} base units, block ${real.block}\n`);

  await new Promise((r) => controlled.listen(RPC_PORT, '127.0.0.1', r));

  // A creator whose wallet is the REAL recipient, and a listing priced just
  // under what was really paid — so the genuine transaction is a valid payment.
  creatorId = randomUUID(); agentId = randomUUID();
  listingId = randomUUID(); listingId2 = randomUUID();
  const priceHuman = (Number(real.value) / 1e6 / 2).toFixed(8);   // half of what was paid
  sql(`INSERT INTO creators (id, handle, wallet_address, status)
       VALUES ('${creatorId}', '${TAG}-${creatorId.slice(0, 8)}', '${real.to}', 'active')`);
  sql(`INSERT INTO agents (id, creator_id, name, version, strategy_type, risk_profile, asset_universe, status)
       VALUES ('${agentId}', '${creatorId}', '${TAG}', 1, 'llm', '{}'::jsonb, 'us_equity', 'active')`);
  for (const id of [listingId, listingId2]) {
    sql(`INSERT INTO marketplace_listings (id, agent_id, access_type, arca_gate_amount, active)
         VALUES ('${id}', '${agentId}', 'subscription', ${priceHuman}, true)`);
  }

  proc = startArca();
  check('arca-service came up against the controlled RPC', await waitUp(), 'never became healthy');

  console.log('\n=== It refuses ===');
  let r = await claim(real.from, listingId, 'not-a-hash');
  check('a malformed hash → malformed_tx_hash', code(r) === 'malformed_tx_hash', JSON.stringify(r.body));

  r = await claim(real.from, listingId, '0x' + 'a'.repeat(64));
  check('a hash for a transaction that does not exist → tx_not_found',
    code(r) === 'tx_not_found', code(r));

  // THE ATTACK: a stranger claims a payment they can see on chain.
  const stranger = '0x' + '9'.repeat(40);
  r = await claim(stranger, listingId, real.hash);
  check('a stranger claiming somebody else\'s payment → sender_is_not_claimant',
    code(r) === 'sender_is_not_claimant', code(r));

  // Wrong recipient: the creator's wallet is not who was paid.
  sql(`UPDATE creators SET wallet_address = '0x${'1'.repeat(40)}' WHERE id = '${creatorId}'`);
  r = await claim(real.from, listingId, real.hash);
  check('paid to a different wallet than the listing\'s creator → no_matching_transfer',
    code(r) === 'no_matching_transfer', code(r));
  sql(`UPDATE creators SET wallet_address = '${real.to}' WHERE id = '${creatorId}'`);

  // Wrong token: same transfer, a token address nobody configured.
  await stop();
  proc = startArca({ ARCA_TOKEN_ADDRESS: '0x' + '2'.repeat(40) });
  await waitUp();
  r = await claim(real.from, listingId, real.hash);
  check('a transfer of a DIFFERENT token → no_matching_transfer',
    code(r) === 'no_matching_transfer', code(r));
  await stop();

  // Amount: price the listing above what was actually paid.
  proc = startArca();
  await waitUp();
  const tooMuch = (Number(real.value) / 1e6 * 10).toFixed(8);
  sql(`UPDATE marketplace_listings SET arca_gate_amount = ${tooMuch} WHERE id = '${listingId}'`);
  r = await claim(real.from, listingId, real.hash);
  check('underpayment → insufficient_amount', code(r) === 'insufficient_amount', code(r));
  sql(`UPDATE marketplace_listings SET arca_gate_amount = ${priceHuman} WHERE id = '${listingId}'`);

  // Confirmations: demand more than the chain can have produced.
  await stop();
  proc = startArca({ ARCA_CLAIM_MIN_CONFIRMATIONS: '999999999' });
  await waitUp();
  r = await claim(real.from, listingId, real.hash);
  check('too few confirmations → insufficient_confirmations',
    code(r) === 'insufficient_confirmations', code(r));
  await stop();

  // Age: a window so short that a transaction minted seconds ago is too old.
  proc = startArca({ ARCA_CLAIM_MAX_AGE_HOURS: '0' });
  await waitUp();
  r = await claim(real.from, listingId, real.hash);
  check('a payment older than the window → tx_too_old', code(r) === 'tx_too_old', code(r));
  await stop();

  // A reverted transaction: same hash, same logs, status 0.
  proc = startArca();
  await waitUp();
  mode = 'reverted';
  r = await claim(real.from, listingId, real.hash);
  check('a REVERTED transaction → tx_reverted', code(r) === 'tx_reverted', code(r));

  mode = 'unmined';
  r = await claim(real.from, listingId, real.hash);
  check('a transaction not yet mined → tx_pending, distinguished from not_found',
    code(r) === 'tx_pending', code(r));
  mode = 'passthrough';

  console.log('\n=== It refuses to guess when it cannot check ===');
  await stop();
  proc = startArca({ ARCA_RPC_URL: `http://127.0.0.1:${DEAD_RPC}` });
  await waitUp();
  r = await claim(real.from, listingId, real.hash);
  check('an unreadable chain → payment_verification_unavailable, NOT a rejection',
    code(r) === 'payment_verification_unavailable', `${r.status} ${code(r)}`);
  check('and it answers 503, not 400 — the claim was never judged',
    r.status === 503, `got ${r.status}`);

  await stop();
  proc = startArca({ ARCA_TOKEN_ADDRESS: '' });
  await waitUp();
  r = await claim(real.from, listingId, real.hash);
  check('no token configured → payment_verification_unavailable',
    code(r) === 'payment_verification_unavailable', code(r));
  await stop();

  console.log('\n=== It accepts a genuine payment ===');
  proc = startArca();
  await waitUp();
  r = await claim(real.from, listingId, real.hash);
  check('a real, confirmed, sufficient payment is accepted',
    r.status < 300 && r.body?.granted === true, `${r.status} ${JSON.stringify(r.body)}`);
  check('and it grants a subscription with an expiry',
    !!r.body?.expires_at, JSON.stringify(r.body));
  const rows = sql(`SELECT count(*) FROM subscriptions WHERE user_wallet = '${real.from}' AND listing_id = '${listingId}'`);
  check('the subscription exists in the database', rows === '1', `${rows} rows`);

  console.log('\n=== The replay surface ===');
  r = await claim(real.from, listingId, real.hash);
  check('the SAME hash on the SAME listing → tx_already_claimed',
    code(r) === 'tx_already_claimed', code(r));

  r = await claim(real.from, listingId2, real.hash);
  check('the SAME hash on a DIFFERENT listing → tx_already_claimed',
    code(r) === 'tx_already_claimed', code(r));
  const claimed = sql(`SELECT count(*) FROM payment_claims WHERE tx_hash = '${real.hash.toLowerCase()}'`);
  check('and exactly one claim row exists for that hash', claimed === '1', `${claimed} rows`);

  // Concurrency: the index check above is an optimisation, the UNIQUE is the
  // guard. Prove the guard by racing past the optimisation.
  sql(`DELETE FROM subscriptions WHERE listing_id IN ('${listingId}','${listingId2}')`);
  sql(`DELETE FROM payment_claims WHERE tx_hash = '${real.hash.toLowerCase()}'`);
  const race = await Promise.all([
    claim(real.from, listingId, real.hash),
    claim(real.from, listingId2, real.hash),
    claim(real.from, listingId, real.hash),
  ]);
  const granted = race.filter((x) => x.body?.granted === true).length;
  check('three simultaneous claims of one hash → exactly one succeeds',
    granted === 1, `${granted} succeeded`);
  const afterRace = sql(`SELECT count(*) FROM payment_claims WHERE tx_hash = '${real.hash.toLowerCase()}'`);
  check('and the database holds exactly one row for it', afterRace === '1', `${afterRace} rows`);
} finally {
  await stop();
  controlled.close();
  cleanup();
  console.log('\nclaims-verify: fixtures removed');
}

console.log(`\n========================================`);
console.log(`  PASS: ${pass}   FAIL: ${fail}`);
console.log(`========================================`);
if (fail) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
