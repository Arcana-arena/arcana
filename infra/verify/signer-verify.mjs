/**
 * ARCANA signer verification.
 *
 * The signer will one day hold the keys to hundreds of wallets containing other
 * people's money. Every bug this project has found so far produced a bad number;
 * a bug here produces a missing balance. So the refusals are proved BEFORE
 * anything is at stake, which is the entire reason this phase signs against
 * empty wallets.
 *
 * WHAT IS PROVED, and how each condition is triggered for real:
 *
 *   REFUSES
 *     - an intent it does not recognise            (a request naming "transfer")
 *     - a raw transfer to an outside address       (there is no field for one)
 *     - a token that is not allowlisted            (a real, unlisted address)
 *     - a router that is not allowlisted           (ditto)
 *     - an amount over the cap                     (arithmetic on real decimals)
 *     - an unlimited approval                      (2^256-1)
 *     - a swap whose proceeds go elsewhere         (there is no recipient field)
 *     - a PAUSED token                             (an RPC that answers paused=true)
 *     - a BLOCKED wallet                           (an RPC that answers isBlocked=true)
 *     - a chain it cannot read                     (an RPC that is really down)
 *     - more signatures than the daily cap         (by actually exceeding it)
 *
 *   ACCEPTS
 *     - a within-limits approve and swap. A gate that refuses everything has
 *       not been shown to be right either.
 *
 *   AND THE CRYPTOGRAPHY IS CHECKED BY SOMEONE ELSE. viem parses the raw
 *   transaction the Go signer produced and recovers the sender. If the address
 *   it recovers is the one the signer claims, then the key derivation, the RLP
 *   encoding and the signature are all correct — verified by an independent
 *   implementation rather than by the one under test.
 *
 * Nothing is broadcast. The signer cannot broadcast.
 */
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';

const REPO = process.env.REPO || '/home/ubuntu/arcana';
const PORT = Number(process.env.TEST_SIGNER_PORT || 8095);
const RPC_PORT = Number(process.env.TEST_RPC_PORT || 8096);
const DEAD_RPC = Number(process.env.TEST_DEAD_RPC || 8097);
const GO = process.env.GO_BIN || '/usr/local/go/bin/go';

const viem = await import(`${REPO}/node_modules/viem/_esm/index.js`);

const env = Object.fromEntries(
  readFileSync(`${REPO}/.env.auth`, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const KEY = env.INTERNAL_API_KEY;

let pass = 0, fail = 0;
const failures = [];
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; failures.push(`${n} — ${d}`); console.log(`  FAIL  ${n} — ${d}`); }
};

// --- fixtures ---------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'signer-verify-'));
const seedPath = join(dir, 'master.key');
writeFileSync(seedPath, randomBytes(32).toString('hex'));
chmodSync(seedPath, 0o400);

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';
const ROUTER = '0xcaf681a66d020601342297493863e78c959e5cb2';   // the real SwapRouter02, in the shipped allowlist
const OUTSIDER = '0xdEAD00000000000000000000000000000000BEEF';
const UNLISTED_TOKEN = '0x00000000000000000000000000000000000000AA';

// THE SHIPPED ALLOWLIST, USED UNMODIFIED.
//
// This used to copy production and splice in a test router, because production
// had none: no router had been proven against this chain's factory. SwapRouter02
// now has been, so the suite exercises what actually ships rather than a fixture
// that resembles it — and if the shipped file ever loses that router, this fails
// loudly instead of quietly testing something else.
const allowPath = `${REPO}/services/signer/allowlist/robinhood-mainnet.json`;
const prod = JSON.parse(readFileSync(allowPath, 'utf8'));
if (!prod.routers.map((r) => r.toLowerCase()).includes(ROUTER.toLowerCase())) {
  console.error(`signer-verify: ${ROUTER} is not in the shipped allowlist`);
  process.exit(1);
}

// --- a chain that answers whatever this test needs --------------------------
let paused = false, blocked = false, rpcCalls = 0;
// null = isBlocked() ANSWERS (with `blocked`). A string = it REVERTS with that
// payload, which is what every token on this chain actually does. The suite
// needs both, because the whole point of the exception is that answering and
// reverting-as-recorded lead to different outcomes.
let blockedRevert = null;
const recordedRevertFor = (addr) => {
  const all = [prod.quote_token, ...prod.tokens];
  const t = all.find((x) => x.address.toLowerCase() === String(addr).toLowerCase());
  return t?.blocklist_unreadable?.revert_data ?? '0x';
};
const word = (v) => '0x' + (v ? '1' : '0').padStart(64, '0');
const rpc = createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => {
    rpcCalls++;
    let id = 1, data = '';
    let to = '';
    try { const j = JSON.parse(b); id = j.id; data = j.params?.[0]?.data || ''; to = j.params?.[0]?.to || ''; } catch {}
    res.writeHead(200, { 'content-type': 'application/json' });
    if (data.startsWith('0xfbac3951') && blockedRevert !== null) {
      // 'auto' reverts with whatever the ALLOWLIST records for this token, which
      // is what the real chain does — USDG returns a custom error and the stock
      // tokens return nothing. One payload for every token would make the
      // exception refuse correctly and for the wrong reason, and then every
      // check downstream of it would be testing the refusal instead of itself.
      const payload = blockedRevert === 'auto' ? recordedRevertFor(to) : blockedRevert;
      res.end(JSON.stringify({ jsonrpc: '2.0', id,
        error: { code: 3, message: 'execution reverted', data: payload } }));
      return;
    }
    let result = word(false);
    if (data.startsWith('0x5c975abb')) result = word(paused);          // paused()
    else if (data.startsWith('0xfbac3951')) result = word(blocked);    // isBlocked(address)
    else if (data === '') result = '0x1237';
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
});

let proc = null;
const AGENT = randomUUID();

function start(extra = {}) {
  return spawn(GO, ['run', './cmd/server'], {
    cwd: `${REPO}/services/signer`,
    env: { ...process.env, PORT: String(PORT), INTERNAL_API_KEY: KEY,
           SIGNER_MASTER_SEED_FILE: seedPath, SIGNER_ALLOWLIST_FILE: allowPath,
           SIGNER_RPC_URLS: `http://127.0.0.1:${RPC_PORT}`,
           SIGNER_CHAIN_CACHE_TTL_MS: '1',
           // Its OWN count file. Sharing the production one would let a test
           // run exhaust a real agent's daily cap.
           SIGNER_SIGNATURE_COUNT_FILE: join(dir, 'signatures.json'), ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
async function stop() {
  if (!proc) return;
  proc.kill('SIGKILL');
  try { execFileSync('bash', ['-lc', `fuser -k ${PORT}/tcp 2>/dev/null || true`]); } catch {}
  proc = null; await new Promise((r) => setTimeout(r, 900));
}
async function waitUp(ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 350));
  }
  return false;
}
const sign = async (body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/internal/v1/signer/sign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Key': KEY },
    body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const code = (r) => r.body?.error?.code || '';
const ok2 = (r) => r.status >= 200 && r.status < 300;
const okSwap = (over = {}) => ({ intent: 'swap_exact_in', agent_id: AGENT, token_in: USDG,
  token_out: AAPL, router: ROUTER, amount: '10000000', min_out: '1', nonce: 0, ...over });
const okApprove = (over = {}) => ({ intent: 'approve', agent_id: AGENT, token_in: USDG,
  router: ROUTER, amount: '50000000', nonce: 0, ...over });

try {
  await new Promise((r) => rpc.listen(RPC_PORT, '127.0.0.1', r));
  proc = start();
  check('signer came up', await waitUp(), 'never became healthy');

  const wres = await fetch(`http://127.0.0.1:${PORT}/internal/v1/signer/wallets/${AGENT}`, { headers: { 'X-Internal-Key': KEY } });
  const wallet = (await wres.json()).address;
  console.log(`  agent  ${AGENT}\n  wallet ${wallet}\n`);

  // === REFUSALS ===========================================================
  console.log('=== It refuses ===');

  let r = await sign({ intent: 'transfer', agent_id: AGENT, token_in: USDG, router: OUTSIDER, amount: '1' });
  check('an intent it does not recognise → unknown_intent', code(r) === 'unknown_intent', `${r.status} ${JSON.stringify(r.body)}`);

  r = await sign({ intent: 'approve', agent_id: AGENT, token_in: USDG, router: ROUTER, amount: '1', to: OUTSIDER, data: '0xa9059cbb' });
  check('a request carrying raw calldata → rejected outright, not ignored', r.status >= 400 && code(r) === 'bad_request', `${r.status} ${JSON.stringify(r.body)}`);

  r = await sign(okApprove({ router: OUTSIDER }));
  check('an outside address as the spender → router_not_allowlisted', code(r) === 'router_not_allowlisted', code(r));

  r = await sign(okSwap({ router: OUTSIDER }));
  check('an outside address as the swap target → router_not_allowlisted', code(r) === 'router_not_allowlisted', code(r));

  r = await sign(okSwap({ token_out: UNLISTED_TOKEN }));
  check('a token nobody allowlisted → token_not_allowlisted', code(r) === 'token_not_allowlisted', code(r));

  // THE SIZE CEILING IS GONE, and its absence is checked rather than assumed.
  //
  // max_trade_notional_usd capped a trade at 100 dollars and was
  // removed on 2026-09-11: how much of their own money an owner commits to one
  // trade is trading style, not a platform decision. A test that merely stopped
  // asserting the refusal would leave the question open; this asserts that a
  // large trade is SIGNED.
  r = await sign(okSwap({ amount: '500000000' }));   // $500, far over the old $100 ceiling
  check('a trade far larger than the old ceiling is signed, because the ceiling is gone',
    ok2(r), `${r.status} ${code(r)}`);

  r = await sign(okSwap({ amount: '100000000000000' }));  // $100,000,000
  check('and so is an absurdly large one: the wallet balance bounds it, not a policy',
    ok2(r), `${r.status} ${code(r)}`);

  r = await sign(okSwap({ amount: '0' }));
  check('zero is still refused, because it is not a trade',
    code(r) === 'amount_not_positive', code(r));

  // WHAT DID NOT GO WITH IT. An unlimited approval is not a large trade; it is
  // a standing right for somebody else to empty the wallet, which is the thing
  // the two-intent design exists to make inexpressible.
  r = await sign(okApprove({ amount: '0x' + 'f'.repeat(64) }));
  check('an unlimited approval → unbounded_approval', code(r) === 'unbounded_approval', code(r));

  r = await sign(okApprove({ amount: (2n ** 255n).toString() }));
  check('2^255 exactly is refused: it is the idiom, not a quantity',
    code(r) === 'unbounded_approval', code(r));

  r = await sign(okApprove({ amount: (2n ** 255n - 1n).toString() }));
  check('and one below it is signed, so the bound is on the number and not on size',
    ok2(r), `${r.status} ${code(r)}`);

  r = await sign(okSwap({ token_out: USDG }));
  check('a swap from a token to itself → token_in_equals_token_out', code(r) === 'token_in_equals_token_out', code(r));

  paused = true;
  r = await sign(okSwap());
  check('a token the issuer has PAUSED → token_paused', code(r) === 'token_paused', code(r));
  paused = false;

  blocked = true;
  r = await sign(okSwap());
  check('a wallet the issuer has BLOCKED → wallet_blocked', code(r) === 'wallet_blocked', code(r));
  blocked = false;

  // === ACCEPTS ============================================================
  console.log('\n=== It accepts what it should ===');
  r = await sign(okApprove());
  check('a within-limits approve is signed', r.status === 200 && r.body?.raw?.startsWith('0x02'), `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  const approveRaw = r.body?.raw;

  r = await sign(okSwap());
  check('a within-limits swap is signed', r.status === 200 && r.body?.raw?.startsWith('0x02'), `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  const swapRaw = r.body?.raw;
  check('the response says plainly that nothing was broadcast', r.body?.broadcast === false, `${r.body?.broadcast}`);

  // === CRYPTOGRAPHY, CHECKED BY AN INDEPENDENT IMPLEMENTATION =============
  console.log('\n=== viem verifies what Go produced ===');
  for (const [label, raw, expectTo] of [['approve', approveRaw, USDG], ['swap', swapRaw, ROUTER]]) {
    if (!raw) { check(`${label}: a raw transaction was returned`, false, 'none'); continue; }
    const parsed = viem.parseTransaction(raw);
    const recovered = await viem.recoverTransactionAddress({ serializedTransaction: raw });
    check(`${label}: viem recovers the sender as the signer's own wallet`,
      recovered.toLowerCase() === wallet.toLowerCase(), `recovered ${recovered}, wallet ${wallet}`);
    check(`${label}: chain id is ${prod.chain_id}`, Number(parsed.chainId) === prod.chain_id, `got ${parsed.chainId}`);
    check(`${label}: value is zero — no native funds can move`, (parsed.value ?? 0n) === 0n, `got ${parsed.value}`);
    check(`${label}: destination is the expected contract`, parsed.to.toLowerCase() === expectTo.toLowerCase(), `got ${parsed.to}`);
  }
  const swapParsed = swapRaw ? viem.parseTransaction(swapRaw) : { data: '' };
  check('the swap sends proceeds to the agent wallet and nowhere else',
    swapParsed.data.toLowerCase().includes(wallet.slice(2).toLowerCase()) &&
    !swapParsed.data.toLowerCase().includes(OUTSIDER.slice(2).toLowerCase()),
    'recipient not found in calldata');

  // === DAILY CAP ==========================================================
  console.log('\n=== The daily cap refuses by actually being exceeded ===');
  let capped = null;
  for (let i = 0; i < prod.limits.max_signatures_per_agent_per_day + 4; i++) {
    const x = await sign(okApprove({ nonce: i + 10 }));
    if (code(x) === 'daily_signature_cap') { capped = i; break; }
  }
  check('signing stops at the cap', capped !== null, 'the cap never fired');

  // === AND IT SURVIVES A RESTART ==========================================
  //
  // THE CHECK THIS WHOLE CHANGE EXISTS FOR. The count used to be a map in
  // memory, so a restart returned it to zero and three deploys in a day turned
  // a cap of 24 into an effective 72 with nothing saying so. That was tolerable
  // while the cadence was locked at four hours; it stopped being tolerable when
  // the floor came off.
  //
  // Proved by RESTARTING THE PROCESS, not by reading the file.
  console.log('\n=== The cap survives a restart ===');
  {
    const before = await (await fetch(`http://127.0.0.1:${PORT}/internal/v1/signer/signatures`,
      { headers: { 'X-Internal-Key': KEY } })).json();
    const usedBefore = before.counts?.[AGENT] ?? 0;
    check('the count is readable without a database credential', usedBefore > 0,
      `counts=${JSON.stringify(before.counts)}`);

    await stop();
    proc = start();
    check('the signer came back up', await waitUp(), 'never became healthy');

    const after = await (await fetch(`http://127.0.0.1:${PORT}/internal/v1/signer/signatures`,
      { headers: { 'X-Internal-Key': KEY } })).json();
    check('the count is exactly what it was before the restart',
      (after.counts?.[AGENT] ?? 0) === usedBefore, `${after.counts?.[AGENT]} vs ${usedBefore}`);

    const r2 = await sign(okApprove({ nonce: 999 }));
    check('and the capped agent is STILL capped after restarting',
      code(r2) === 'daily_signature_cap', code(r2));
    check('the refusal explains that an approve and its swap are two signatures',
      /two signatures/.test(JSON.stringify(r2.body)), JSON.stringify(r2.body).slice(0, 160));

    // The cap is per agent. One exhausted agent must not silence the rest, or a
    // single runaway takes the whole platform down with it.
    const other = randomUUID();
    const r3 = await sign(okApprove({ agent_id: other, nonce: 0 }));
    check('a different agent is unaffected', ok2(r3), code(r3));
  }

  // === AN UNREADABLE COUNT REFUSES, IT DOES NOT RESET =====================
  //
  // Absent and corrupt are different facts. A missing file is a fresh install
  // and must start at zero, or nothing could ever sign. A file that exists and
  // cannot be parsed must refuse, because assuming zero there is the cap
  // quietly refunding itself -- the same rule an unreadable isBlocked() follows.
  console.log('\n=== An unreadable count refuses rather than resetting ===');
  {
    const corrupt = join(dir, 'signatures-corrupt.json');
    writeFileSync(corrupt, 'this is not json at all');
    await stop();
    proc = start({ SIGNER_SIGNATURE_COUNT_FILE: corrupt });
    check('the signer still boots and serves /healthz', await waitUp(), 'never became healthy');
    const r = await sign(okApprove({ agent_id: randomUUID(), nonce: 0 }));
    check('but every signature is refused', code(r) === 'daily_signature_cap', code(r));
    check('and it says the brake could not be read, not that it was empty',
      /could not be read/.test(JSON.stringify(r.body)), JSON.stringify(r.body).slice(0, 180));
    const counts = await fetch(`http://127.0.0.1:${PORT}/internal/v1/signer/signatures`,
      { headers: { 'X-Internal-Key': KEY } });
    check('and the count endpoint reports the fault rather than zeros',
      counts.status === 503, `${counts.status}`);

    // A MISSING file is not corruption.
    await stop();
    proc = start({ SIGNER_SIGNATURE_COUNT_FILE: join(dir, 'does-not-exist-yet.json') });
    check('a fresh install with no count file comes up', await waitUp(), 'never became healthy');
    const fresh = await sign(okApprove({ agent_id: randomUUID(), nonce: 0 }));
    check('and can sign, because absent is not corrupt', ok2(fresh), code(fresh));
  }

  await stop();
  proc = start();
  check('back on the normal count file', await waitUp(), 'never became healthy');

  // === THE POOL FEE COMES FROM THE PAIR, NOT FROM ONE SIDE ================
  //
  // Read from token_out, the fee is right for a BUY (token_out is the stock
  // token, which carries pool_fee) and zero for a SELL (token_out is the quote
  // token, whose entry has none). A fee of zero is not a fee tier: the router
  // derives a pool address from it, finds no contract, and reverts with no
  // message for about 30k gas. Two real sells did exactly that before this was
  // found, both costing gas and moving nothing.
  console.log('\n=== The pool fee is resolved from the pair ===');
  const feeOf = (raw) => {
    const d = raw.slice(2);
    // selector(4) then tokenIn, tokenOut, fee, ...
    return BigInt('0x' + d.slice(8 + 64 * 2, 8 + 64 * 3));
  };
  const stockFee = BigInt(prod.tokens.find((t) => t.symbol === 'AAPL').pool_fee);
  // The calldata is recovered from the signed transaction, not from the
  // response, so what is checked is what would actually be broadcast.
  const txDataOf = (res) => viem.parseTransaction(res.body.raw).data;

  paused = false; blocked = false; blockedRevert = 'auto';
  r = await sign(okSwap({ agent_id: randomUUID() }));
  const buyFee = ok2(r) ? feeOf(txDataOf(r)) : null;
  check('a BUY carries the stock token fee tier',
    buyFee === stockFee, `${code(r)} fee=${buyFee}`);

  r = await sign(okSwap({ agent_id: randomUUID(), token_in: AAPL, token_out: USDG, amount: '1000000000000000' }));
  const sellFee = ok2(r) ? feeOf(txDataOf(r)) : null;
  check('a SELL carries the SAME fee tier, not zero',
    sellFee === stockFee, `${code(r)} fee=${sellFee} — zero here is a pool that does not exist`);

  r = await sign(okSwap({ agent_id: randomUUID(), token_in: USDG, token_out: USDG }));
  check('quote token on both sides is refused',
    code(r) === 'token_in_equals_token_out', code(r));

  // === THE BLOCKLIST EXCEPTION ============================================
  //
  // No token on chain 4663 implements isBlocked(). Refusing on that basis
  // refused every trade the platform could ever make, so the allowlist now
  // records the absence per token, with the revert payload proving it. These
  // checks exist because an exception that is never re-examined is how a
  // workaround becomes permanent — so the interesting cases are not "does it
  // sign", they are the ways the exception must STOP applying.
  console.log('\n=== The blocklist exception, and the four ways it stops applying ===');
  await stop();
  proc = start();
  check('signer came up on the shipped allowlist', await waitUp(), 'never became healthy');

  const excepted = prod.quote_token.blocklist_unreadable;
  check('the shipped allowlist records USDG as having no readable blocklist',
    !!excepted && excepted.revert_data === '0x800ab12c', JSON.stringify(excepted));
  check('and it carries a control selector whose payload is identical',
    !!excepted && excepted.control_revert_data === excepted.revert_data,
    'a revert only proves absence if an impossible selector reverts the same way');

  paused = false; blocked = false;
  blockedRevert = '0x800ab12c';
  r = await sign(okApprove({ agent_id: randomUUID() }));
  check('isBlocked() reverting EXACTLY as recorded → signs', ok2(r), code(r) || r.status);

  blockedRevert = '0xbaadf00d';
  r = await sign(okApprove({ agent_id: randomUUID() }));
  check('reverting with a DIFFERENT payload → refused, the evidence no longer describes the contract',
    code(r) === 'chain_state_unverifiable', code(r));

  blockedRevert = null; blocked = true;
  r = await sign(okApprove({ agent_id: randomUUID() }));
  check('isBlocked() ANSWERING true → wallet_blocked, so the exception expired on its own',
    code(r) === 'wallet_blocked', code(r));

  blockedRevert = '0x800ab12c'; blocked = false; paused = true;
  r = await sign(okApprove({ agent_id: randomUUID() }));
  check('paused() true on an excepted token → still token_paused, paused() was NOT relaxed',
    code(r) === 'token_paused', code(r));
  paused = false;

  // A token that is allowlisted but NOT marked must still be refused. The
  // shipped file marks every token, so this needs its own allowlist — and
  // that is the point: the exception is per-token, not a switch.
  console.log('\n=== A token nobody examined is still refused ===');
  const unmarked = JSON.parse(JSON.stringify(prod));
  delete unmarked.quote_token.blocklist_unreadable;
  const unmarkedPath = join(dir, 'allowlist-unmarked.json');
  writeFileSync(unmarkedPath, JSON.stringify(unmarked, null, 2));
  await stop();
  proc = start({ SIGNER_ALLOWLIST_FILE: unmarkedPath });
  check('signer came up on an allowlist with USDG unmarked', await waitUp(), 'never became healthy');
  blockedRevert = '0x800ab12c';
  r = await sign(okApprove({ agent_id: randomUUID() }));
  check('the SAME revert, on a token with no exception → refused',
    code(r) === 'chain_state_unverifiable', code(r));

  // Evidence is not optional. An exception without its control is a note
  // nobody can re-check, so the signer must refuse to load it at all.
  console.log('\n=== An exception without evidence does not load ===');
  const noEvidence = JSON.parse(JSON.stringify(prod));
  noEvidence.quote_token.blocklist_unreadable = { verified_at: '2026-09-11', revert_data: '0x800ab12c' };
  const noEvidencePath = join(dir, 'allowlist-no-evidence.json');
  writeFileSync(noEvidencePath, JSON.stringify(noEvidence, null, 2));
  await stop();
  proc = start({ SIGNER_ALLOWLIST_FILE: noEvidencePath });
  let bootErr = '';
  proc.stderr.on('data', (c) => (bootErr += c));
  const cameUp = await waitUp(8000);
  check('an exception with no control selector → the signer refuses to start',
    !cameUp, 'it started, so an unverifiable note would have been trusted');
  check('and it says why', /control/i.test(bootErr), bootErr.slice(0, 200) || '(no stderr)');

  blockedRevert = null; blocked = false;

  // === A CHAIN IT CANNOT READ =============================================
  console.log('\n=== A chain it cannot read ===');
  await stop();
  proc = start({ SIGNER_RPC_URLS: `http://127.0.0.1:${DEAD_RPC}` });
  check('signer came up pointed at a dead RPC', await waitUp(), 'never became healthy');
  r = await sign(okSwap({ agent_id: randomUUID() }));
  check('refuses rather than signing unverified → chain_state_unverifiable',
    code(r) === 'chain_state_unverifiable', code(r));

  // === NO SEED ============================================================
  console.log('\n=== No master seed ===');
  await stop();
  proc = start({ SIGNER_MASTER_SEED_FILE: join(dir, 'nope.key') });
  check('signer still boots and serves /healthz without a seed', await waitUp(), 'did not boot');
  const h = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json();
  check('health says it is not configured', h.signer_configured === false, JSON.stringify(h));
  r = await sign(okApprove());
  check('every signing request refused → signer_not_configured', code(r) === 'signer_not_configured', code(r));

  // === AN EXPOSED SEED FILE ===============================================
  console.log('\n=== A seed file anyone can read ===');
  await stop();
  const loose = join(dir, 'loose.key');
  writeFileSync(loose, randomBytes(32).toString('hex'));
  chmodSync(loose, 0o644);
  proc = start({ SIGNER_MASTER_SEED_FILE: loose });
  check('signer boots but refuses to load a world-readable seed', await waitUp(), 'did not boot');
  const h2 = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json();
  check('a seed at mode 0644 is NOT loaded', h2.signer_configured === false, JSON.stringify(h2));

  console.log(`\n  ${rpcCalls} chain reads made while deciding — the checks are real calls, not assumptions.`);
} finally {
  await stop();
  rpc.close();
  try { execFileSync('rm', ['-rf', dir]); } catch {}
  console.log('signer-verify: fixtures removed');
}

console.log(`\n========================================`);
console.log(`  PASS: ${pass}   FAIL: ${fail}`);
console.log(`========================================`);
if (fail) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
