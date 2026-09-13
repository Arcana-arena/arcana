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
 * NO MONEY IS SPENT, AND THE TOKEN IS THE REAL ONE. The marketplace settles in
 * USDG as of 2026-09-11, so this suite and production point at the same
 * contract — the verification stopped being an analogy for a token that did
 * not exist and became a test of the token that does. It is driven with REAL
 * TRANSACTIONS that already exist. Every "does this transaction say what the claimer says it
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
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

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

/**
 * ONE INSTANCE AT A TIME, and a clean slate before starting.
 *
 * This suite's fixture puts a REAL ON-CHAIN ADDRESS on a creator, and
 * `creators.wallet_address` is UNIQUE. Two consequences that only show up in a
 * full regression:
 *
 *   1. TWO CONCURRENT RUNS CANNOT BOTH EXIST. Both find the same recipient on
 *      chain and both want it on their own creator row; the second gets
 *      "duplicate key value violates unique constraint". Widening the scan
 *      window from 18 blocks to 4096 made the pick deterministic, which turned
 *      a rare collision into a reliable one — a regression introduced by the
 *      previous fix.
 *
 *   2. AN INTERRUPTED RUN POISONS THE NEXT ONE. Kill the suite between the
 *      INSERT and its cleanup and the row survives, holding the address every
 *      subsequent run needs. The suite then fails forever, on a machine where
 *      nothing is wrong, until somebody deletes a row by hand.
 *
 * Both are removed here rather than in the fixture, because the fixture is
 * right: driving the checks with a transaction somebody else really made is
 * the whole point, and a synthetic address would prove only that the code
 * agrees with itself.
 *
 * The lock is the same mechanism the systemd units use, for the same reason.
 * It is non-blocking: a second instance says so and exits rather than queueing
 * behind a run that may take minutes.
 */
const LOCK = '/tmp/arcana-claims-verify.lock';

/**
 * A PID lock rather than flock(2), because Node has no flock and shelling out
 * to flock(1) would mean re-executing this script under it.
 *
 * SELF-HEALING, which a bare lock file is not. A run killed with SIGKILL never
 * removes its lock, and a lock nobody can clear is a permanent outage of the
 * check — the same shape as the poisoned fixture row this exists to prevent.
 * So the holder's pid is written down and a lock whose holder is gone is taken
 * over, loudly.
 */
function takeLockAndCleanStale() {
  try {
    writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
  } catch {
    const holder = Number(readFileSync(LOCK, 'utf8').trim());
    let alive = false;
    try { process.kill(holder, 0); alive = true; } catch { alive = false; }
    if (alive) {
      console.error(
        `claims-verify: another instance (pid ${holder}) is already running.\n` +
        'This suite cannot run twice at once: its fixture claims a real on-chain\n' +
        'address, and creators.wallet_address is UNIQUE. Nothing was judged.');
      process.exit(2);
    }
    console.log(`  (taking over a lock left by pid ${holder}, which is gone)`);
    writeFileSync(LOCK, String(process.pid));
  }
  // Holding the lock, so nothing else is mid-run: any fixture row still here
  // is from a run that died before cleaning up.
  const stale = sql(`SELECT count(*) FROM creators WHERE handle LIKE '${TAG}%'`);
  if (stale !== '0') {
    console.log(`  (clearing ${stale} fixture row(s) left by an interrupted run)`);
    sql(`DELETE FROM marketplace_listings WHERE agent_id IN (
           SELECT id FROM agents WHERE creator_id IN (
             SELECT id FROM creators WHERE handle LIKE '${TAG}%'))`);
    sql(`DELETE FROM agents WHERE creator_id IN (
           SELECT id FROM creators WHERE handle LIKE '${TAG}%')`);
    sql(`DELETE FROM creators WHERE handle LIKE '${TAG}%'`);
  }
}

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
  // THE WINDOW WAS 18 BLOCKS, WHICH IS 1.8 SECONDS.
  //
  // Robinhood Chain produces a block every 0.100 s — measured, four ways. A
  // fixed 18-block window is therefore under two seconds of history, and USDG
  // transfers are not that frequent: polling it sixty times just moves the
  // same two-second slot along and can legitimately see nothing all run. That
  // is what made this suite fail intermittently inside a full regression while
  // passing every time it was run alone.
  //
  // Widest-first, narrowing on refusal. Public RPCs cap eth_getLogs ranges and
  // they do not agree on the cap, so the range is negotiated rather than
  // assumed — the same shape as the endpoint list, which exists because two
  // providers on this chain serve eth_chainId and refuse eth_call.
  const WINDOWS = [4096, 1024, 256, 18]; // ~7 min, ~1.7 min, ~26 s, ~1.8 s
  let window = WINDOWS[0];
  for (let attempt = 0; attempt < 60; attempt++) {
    const head = Number(BigInt(await chain('eth_blockNumber', [])));
    let logs = [];
    try {
      logs = await chain('eth_getLogs', [{
        address: USDG,
        fromBlock: '0x' + Math.max(0, head - window).toString(16),
        toBlock: '0x' + head.toString(16),
        topics: [TRANSFER],
      }]);
    } catch {
      // Refused: almost always the range cap. Narrow once and retry rather
      // than spending every remaining attempt on a range this node will never
      // serve.
      const next = WINDOWS[WINDOWS.indexOf(window) + 1];
      if (next) {
        window = next;
        console.log(`  (range refused; narrowing the scan to ${window} blocks)`);
      }
    }
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
           // THE PRODUCTION TOKEN, not a stand-in for it.
           //
           // This used to set ARCA_TOKEN_ADDRESS to USDG because $ARCA did not
           // exist and USDG was the closest real thing. The marketplace is now
           // settled in USDG for real, so this suite and production are
           // pointing at the same token — the verification is no longer an
           // analogy.
           //
           // ARCA_TOKEN_DECIMALS is gone. Decimals come from the token's own
           // decimals(), so the suite cannot accidentally test an assumption
           // production does not make.
           MARKETPLACE_PAYMENT_TOKEN: USDG,
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

// Taken BEFORE anything is created, and before the chain scan — the scan is
// the slow part, and two instances that both scanned before locking would
// still both want the same address.
takeLockAndCleanStale();

try {
  console.log('claims-verify: looking for a real USDG transfer on chain...');
  const real = await findRealTransfer();
  if (!real) {
    // COULD NOT RUN is not the same as FAILED, and exiting 1 with no summary
    // conflated them. In a full regression the harness saw "? pass ? fail" and
    // that reads as a crash in the system under test, not as a suite that
    // never got its precondition — which cost a full investigation to find out.
    //
    // The distinction this codebase already makes everywhere: 503
    // "could not find out" against 4xx "you are wrong"; `unrefereed` against
    // `agreed`; `enforced: null` against `false`. The suites should follow
    // their own rule.
    //
    // Exit 2, and say so in the summary format the harness reads.
    console.log('\n' + '='.repeat(40));
    console.log('  PASS: 0   FAIL: 0   COULD NOT RUN');
    console.log('='.repeat(40));
    console.error(
      'claims-verify: no live USDG transfer appeared on chain during the scan, so there\n' +
      'was nothing real to verify against. This suite deliberately drives itself with a\n' +
      'transaction SOMEBODY ELSE made — fabricating one would prove only that the code\n' +
      'agrees with itself.\n\n' +
      'Nothing was judged. This is not a failure of the claim path; re-run when the\n' +
      'chain has traffic.');
    process.exit(2);
  }
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
  // AND IT SAYS WHERE THE MONEY ACTUALLY WENT.
  //
  // "no matching transfer" is true and nearly useless: the buyer cannot tell a
  // wrong address from a wrong token from a hash pasted by mistake, and those
  // are three different next steps. The receipt is already in hand, so the
  // recipients it really paid are listed beside the one it should have.
  {
    const b = r.body || {};
    check('and it names the recipient the payment was supposed to reach',
      typeof b.expected_recipient === 'string' && b.expected_recipient.startsWith('0x'),
      String(b.expected_recipient));
    check('and lists the transfers the transaction actually made',
      Array.isArray(b.transfers) && b.transfers.length > 0,
      `transfers: ${JSON.stringify(b.transfers)}`);
    check('marking this one as the right token sent to the wrong recipient',
      b.wrong_recipient === true &&
      (b.transfers || []).some((t) => t.right_token === true && t.right_recipient === false),
      JSON.stringify({ wrong_recipient: b.wrong_recipient, transfers: b.transfers }));
  }
  sql(`UPDATE creators SET wallet_address = '${real.to}' WHERE id = '${creatorId}'`);

  // Wrong token: same transfer, a token address nobody configured.
  await stop();
  proc = startArca({ MARKETPLACE_PAYMENT_TOKEN: '0x' + '2'.repeat(40) });
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
  // AND IT SAYS BY HOW MUCH, in the units the buyer typed.
  //
  // "transferred 39950000 base units; costs 40000000" is arithmetic somebody
  // who has just lost money should not have to do, and the shortfall is the
  // only number that tells them what to send next. The screen that shows this
  // failure is built entirely from these fields.
  {
    const b = r.body || {};
    check('and it names what arrived, what was owed, and the difference',
      typeof b.paid_base_units === 'string' && typeof b.required_base_units === 'string' &&
      typeof b.shortfall_base_units === 'string',
      JSON.stringify({ paid: b.paid_base_units, required: b.required_base_units, short: b.shortfall_base_units }));
    check('in human units as well as base units',
      typeof b.paid === 'string' && typeof b.required === 'string' && typeof b.shortfall === 'string',
      JSON.stringify({ paid: b.paid, required: b.required, shortfall: b.shortfall }));
    check('the shortfall is exactly required minus paid',
      b.shortfall_base_units === String(BigInt(b.required_base_units || '0') - BigInt(b.paid_base_units || '0')),
      `${b.required_base_units} - ${b.paid_base_units} != ${b.shortfall_base_units}`);
    // THE REMEDY MUST NOT PROMISE A FEATURE THAT DOES NOT EXIST. Each claim is
    // checked against ONE transaction and the sum inside it, so "send the
    // difference and the two will be matched" would be a lie told to somebody
    // who has already lost money once by trusting this page.
    check('and the remedy does not promise that a top-up will be matched',
      typeof b.remedy === 'string' && /single transfer/i.test(b.remedy) && !/will be matched/i.test(b.remedy),
      b.remedy || 'no remedy stated');
  }
  sql(`UPDATE marketplace_listings SET arca_gate_amount = ${priceHuman} WHERE id = '${listingId}'`);

  // Confirmations: demand more than the chain can have produced.
  await stop();
  proc = startArca({ ARCA_CLAIM_MIN_CONFIRMATIONS: '999999999' });
  await waitUp();
  r = await claim(real.from, listingId, real.hash);
  check('too few confirmations → insufficient_confirmations',
    code(r) === 'insufficient_confirmations', code(r));
  // A WAIT, NOT A REFUSAL, and the difference has to be legible to whatever
  // draws the screen. Without `pending` and the counts, a buyer whose payment
  // is simply young is shown an error.
  {
    const b = r.body || {};
    check('and it is marked as pending rather than as a rejection', b.pending === true, JSON.stringify(b.pending));
    check('with the depth reached and the depth required',
      typeof b.confirmations === 'number' && typeof b.required_confirmations === 'number',
      JSON.stringify({ have: b.confirmations, need: b.required_confirmations }));
    check('and the remainder in wall-clock seconds, not only in blocks',
      typeof b.estimated_seconds_remaining === 'number' && b.estimated_seconds_remaining >= 0,
      String(b.estimated_seconds_remaining));
  }
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
  proc = startArca({ MARKETPLACE_PAYMENT_TOKEN: '' });
  await waitUp();
  r = await claim(real.from, listingId, real.hash);
  check('no token configured → payment_verification_unavailable',
    code(r) === 'payment_verification_unavailable', code(r));
  await stop();

  console.log('\n=== The quote names the address the check will look for ===');
  proc = startArca();
  await waitUp();
  {
    // THE END-TO-END VERSION of the structural checks below. The quote is
    // taken BEFORE the claim, and then the very same payment is accepted — so
    // the address the buyer would have been told is provably the address the
    // accepted transfer went to, and the amount they were quoted is provably
    // the amount the check compared against.
    //
    // Nothing here is asserted about equality of two strings computed twice.
    // The claim that follows is the second half of the proof.
    const q = await fetch(
      `http://127.0.0.1:${ARCA_PORT}/internal/v1/payments/quote?listingId=${listingId}`,
      { headers: { 'X-Internal-Key': KEY } });
    const quote = await q.json().catch(() => null);
    check('the quote answers', q.status === 200, `${q.status} ${JSON.stringify(quote)?.slice(0, 120)}`);
    check('pay_to is the address the real transfer actually went to',
      quote?.pay_to === real.to, `quote says ${quote?.pay_to}, the transfer went to ${real.to}`);
    check('the token quoted is the token the check matches on',
      quote?.token === USDG, quote?.token);
    check('the amount is stated in base units, not left to the client to convert',
      typeof quote?.amount_base_units === 'string' && /^[0-9]+$/.test(quote.amount_base_units),
      String(quote?.amount_base_units));
    check('the decimals came from the chain (USDG is 6, never assumed 18)',
      quote?.decimals === 6, String(quote?.decimals));
    // The listing is priced at half of what was really paid, so the quoted
    // requirement must be under the real transfer — which is exactly why the
    // claim below succeeds. If the quote over-stated, this would catch it.
    check('the quoted requirement is satisfied by the real payment',
      BigInt(quote?.amount_base_units ?? '0') <= real.value,
      `quoted ${quote?.amount_base_units}, paid ${real.value}`);
    check('the buyer is warned about refunds BEFORE paying',
      /cannot refund/.test(quote?.warning ?? ''), String(quote?.warning).slice(0, 60));
  }

  console.log('\n=== It accepts a genuine payment ===');
  r = await claim(real.from, listingId, real.hash);
  check('a real, confirmed, sufficient payment is accepted',
    r.status < 300 && r.body?.granted === true, `${r.status} ${JSON.stringify(r.body)}`);
  check('and it grants a subscription with an expiry',
    !!r.body?.expires_at, JSON.stringify(r.body));
  const rows = sql(`SELECT count(*) FROM subscriptions WHERE user_wallet = '${real.from}' AND listing_id = '${listingId}'`);
  check('the subscription exists in the database', rows === '1', `${rows} rows`);

  // WHAT THE PAYMENT ACTUALLY BOUGHT.
  //
  // A subscription now means the agent trades for the buyer's wallet too, and
  // the fan-out finds who to trade for with `WHERE agent_id = ...`. grant()
  // wrote user_wallet, listing_id, expires_at and status — exactly as it had
  // before subscriptions traded — so the row came out with a NULL agent_id, the
  // fan-out never matched it, and the customer paid for nothing. Every other
  // part worked: the wallet would derive, the book would read, the limits would
  // apply. The feature was complete and unreachable.
  //
  // It survived a 36-check suite because every fixture there sets agent_id
  // itself. A suite that builds its own rows never exercises the code that
  // builds the real ones — so the check belongs HERE, on the far side of a real
  // payment, and not there.
  const bound = sql(`SELECT coalesce(agent_id::text,'NULL') FROM subscriptions
                      WHERE user_wallet = '${real.from}' AND listing_id = '${listingId}'`);
  check('the payment bound the agent the listing sells', bound === agentId,
    `the subscription carries agent_id=${bound} and the listing sells ${agentId}. A subscription ` +
    'that does not name its agent is one the agent never trades for: the buyer pays, everything ' +
    'else works, and nothing happens in their wallet');

  // AND NOTHING THE BUYER MUST DO THEMSELVES WAS DONE FOR THEM. arca-service
  // holds no signer, and a wallet derived without being asked for is a custody
  // arrangement nobody requested. The buyer derives it and funds it.
  const walletYet = sql(`SELECT coalesce(wallet_address,'NULL') FROM subscriptions
                          WHERE user_wallet = '${real.from}' AND listing_id = '${listingId}'`);
  check('and no trading wallet was derived on the buyer\'s behalf', walletYet === 'NULL',
    `wallet_address=${walletYet}`);

  console.log('\n=== The replay surface ===');
  r = await claim(real.from, listingId, real.hash);
  check('the SAME hash on the SAME listing → tx_already_claimed',
    code(r) === 'tx_already_claimed', code(r));
  // AND IT SAYS WHAT THE HASH ALREADY BOUGHT.
  //
  // The bare refusal named a listing id and nothing else, which leaves the
  // buyer unable to tell an honest mistake — pasting last month's renewal —
  // from somebody else having used their transaction. Both end in the same
  // 409, so the body has to carry the difference.
  {
    const b = r.body || {};
    check('naming the listing it bought', b.claimed_listing_id === listingId, String(b.claimed_listing_id));
    check('and the wallet that bought it', typeof b.claimed_by_wallet === 'string' &&
      b.claimed_by_wallet.toLowerCase() === real.from.toLowerCase(), String(b.claimed_by_wallet));
    check('and when', typeof b.claimed_at === 'string' && !Number.isNaN(Date.parse(b.claimed_at)),
      String(b.claimed_at));
    check('and whether that term is still running',
      b.term === null || (b.term && typeof b.term.expires_at === 'string' && typeof b.term.in_grace === 'boolean'),
      JSON.stringify(b.term));
    check('and it says nothing was charged by the attempt',
      typeof b.remedy === 'string' && /nothing was charged/i.test(b.remedy), b.remedy || 'no remedy stated');
  }

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
  // Released last, after the fixture is gone. Releasing it first would let a
  // waiting instance start against rows this one is still deleting.
  //
  // A crash that skips this leaves the lock behind, and that is handled at the
  // other end: the next run finds the pid dead and takes over. Between them,
  // neither a crash nor a concurrent start can wedge this suite permanently.
  try { unlinkSync(LOCK); } catch { /* already gone; nothing to release */ }
  console.log('\nclaims-verify: fixtures removed');
}

console.log('\n=== The quote and the check cannot disagree ===');
{
  // THE PROPERTY: a buyer is told an address and an amount, and the
  // verification later looks for an address and an amount. If those came from
  // two places they would agree until the day they did not — and the failure
  // is a buyer paying the wrong party, or underpaying by a factor of a
  // million and being told `insufficient_amount`.
  //
  // Proved structurally, not by comparing two outputs and hoping. The quote
  // and the claim must be the SAME CODE, and that is checkable in the source.
  const svc = readFileSync(
    `${REPO}/services/arca-service/src/payments/claims.service.ts`, 'utf8');

  // Exactly one lookup of "who gets paid", and both paths call it.
  const walletLookups = (svc.match(/creatorWalletFor\(/g) ?? []).length;
  check('there is exactly one definition of creatorWalletFor and it has callers',
    (svc.match(/private async creatorWalletFor\(/g) ?? []).length === 1 && walletLookups >= 3,
    `${walletLookups} references`);
  check('the CLAIM resolves its payee through resolvePayable()',
    /const \{ creatorWallet \} = await this\.resolvePayable\(listingId\)/.test(svc),
    'claim() should not query the creator itself');
  check('the QUOTE resolves its payee through the same resolvePayable()',
    /async quote\([\s\S]*?await this\.resolvePayable\(listingId\)/.test(svc),
    'quote() should not query the creator itself');

  // Exactly one decimal conversion, and both paths call it.
  check('there is exactly one baseUnits() implementation',
    (svc.match(/private baseUnits\(/g) ?? []).length === 1,
    'a second conversion is how a price silently diverges');
  check('the CLAIM gets its required amount from requiredBaseUnits()',
    /const required = await this\.requiredBaseUnits\(listingId, hash\)/.test(svc),
    'claim() should not convert the price itself');
  check('the QUOTE gets its amount from the same requiredBaseUnits()',
    /async quote\([\s\S]*?await this\.requiredBaseUnits\(listingId\)/.test(svc),
    'quote() should not convert the price itself');

  // And marketplace must not compute either one. A proxy that "helpfully"
  // formats the amount is a second implementation wearing a different hat.
  const mkt = readFileSync(
    `${REPO}/services/marketplace/src/listings/listings.service.ts`, 'utf8');
  check('marketplace computes neither the payee nor the amount',
    !/wallet_address|10 \*\* |BigInt\(|toFixed\(6\)/.test(
      mkt.slice(mkt.indexOf('async quote('), mkt.indexOf('async unclaimedPayments('))),
    'marketplace should proxy the quote, not recompute it');

  // The refund consequence must be stated BEFORE the money moves.
  check('the quote warns that ARCANA cannot refund, before payment',
    /cannot refund it, reverse it, or recover it/.test(svc),
    'a buyer must learn this while they can still decide');
}

console.log('\n=== A listing with no payee cannot be published ===');
{
  // Refusing a claim correctly is not the same as working: a listing whose
  // creator has no wallet refused every claim with the right code and was
  // still a listing nobody could ever buy.
  const mkt = readFileSync(
    `${REPO}/services/marketplace/src/listings/listings.service.ts`, 'utf8');
  check('create() asserts the creator can be paid',
    /async create\([\s\S]*?await this\.assertPayable\(/.test(mkt), 'no guard on create');
  check('REACTIVATING also asserts it — a PATCH must not walk around the guard',
    /if \(dto\.active && !listing\.active\) await this\.assertPayable\(/.test(mkt),
    'update() can set active=true without a payee check');
  check('the payee check asks arca-service, not a second local query',
    /internal\/v1\/payments\/payable\?agentId=/.test(mkt) && !/FROM creators/.test(mkt),
    'a local creators query would be a second definition');

  // And no active listing may currently be unbuyable.
  const orphaned = sql(`SELECT count(*) FROM marketplace_listings l
      JOIN agents a ON a.id = l.agent_id
      JOIN creators c ON c.id = a.creator_id
     WHERE c.wallet_address IS NULL AND l.active`);
  check('no ACTIVE listing has a creator without a wallet', orphaned === '0',
    `${orphaned} active listings cannot be paid for`);
}

console.log('\n=== The payment token is not the gating token ===');
{
  // THE MISTAKE THIS FORECLOSES. One variable served both purposes while both
  // were $ARCA. They are different tokens now, and the expensive failure is
  // not either one being wrong — it is the two being SWAPPED, which would let
  // holding USDG satisfy a $ARCA gate, or price a listing in a token nobody
  // can pay in. Neither would throw.
  const unitFile = readFileSync(`${REPO}/infra/systemd/arcana-arca.service`, 'utf8');
  const payment = /MARKETPLACE_PAYMENT_TOKEN=(\S*)/.exec(unitFile)?.[1] ?? '';
  const gating = /^Environment=ARCA_TOKEN_ADDRESS=(\S*)$/m.exec(unitFile)?.[1] ?? '';

  check('the payment token is configured', /^0x[0-9a-fA-F]{40}$/.test(payment), payment || '(empty)');
  check('the payment token is USDG — the address phase zero and phase 11 both used',
    payment.toLowerCase() === USDG, payment);
  check('the two tokens are NOT the same value',
    gating === '' || payment.toLowerCase() !== gating.toLowerCase(),
    `payment=${payment} gating=${gating}`);

  // And nothing may improvise a third source. Two providers, two variables.
  const svc = readFileSync(
    `${REPO}/services/arca-service/src/payments/arca-token.service.ts`, 'utf8');
  const reads = [...svc.matchAll(/config\.get<string>\('([A-Z_]*TOKEN[A-Z_]*)'\)/g)].map((m) => m[1]);
  check('no token address is read from the environment outside the two providers',
    reads.length === 0, reads.join(', '));
}

console.log(`\n========================================`);
console.log(`  PASS: ${pass}   FAIL: ${fail}`);
console.log(`========================================`);
if (fail) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
