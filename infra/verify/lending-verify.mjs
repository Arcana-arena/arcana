/**
 * lending-verify.mjs — the signer's three lending shapes, proved by execution.
 *
 * architecture.md §17.7 day 5: "each shape proven by execution against live
 * state before it is enabled, plus the reverting control from day 4 kept as a
 * regression test". So this does three things, in this order:
 *
 *   1. THE SHIPPED FILE REFUSES. A signer started on the allowlist that
 *      actually ships must refuse every lending intent with
 *      lending_not_enabled. That is day 5's exit — no signing path is live —
 *      checked against the running code rather than read off the file.
 *
 *   2. THE CAPS REFUSE, and name which cap. A signer started on a copy with
 *      `enabled` flipped (the only change) is asked for borrows over the
 *      per-transaction cap, over the per-agent debt cap, and with a debt it
 *      cannot read. The debt comes from a mock chain, so each case is exact.
 *
 *   3. WHAT IT SIGNS WORKS ON THE REAL CHAIN. The raw transactions it signed
 *      are parsed by viem — which recovers the sender, so the key derivation,
 *      RLP and signature are checked by an implementation that is not the one
 *      under test — and their calldata is executed with eth_simulateV1 against
 *      live Robinhood Chain state, from the derived wallet, funded with NVDA
 *      inside the simulation only. Day 4's four controls run beside it and
 *      must revert.
 *
 * NOTHING IS BROADCAST. The signer cannot broadcast, and eth_simulateV1 does not.
 *
 *   node infra/verify/lending-verify.mjs
 */
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';

const REPO = process.env.REPO || '/home/ubuntu/arcana';
const PORT = Number(process.env.TEST_SIGNER_PORT || 8098);
const RPC_PORT = Number(process.env.TEST_RPC_PORT || 8099);
const GO = process.env.GO_BIN || '/usr/local/go/bin/go';
const LIVE_RPC = process.env.LENDING_LIVE_RPC || 'https://rpc.mainnet.chain.robinhood.com';

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
const dir = mkdtempSync(join(tmpdir(), 'lending-verify-'));
const seedPath = join(dir, 'master.key');
writeFileSync(seedPath, randomBytes(32).toString('hex'));
chmodSync(seedPath, 0o400);

const shippedPath = `${REPO}/services/signer/allowlist/robinhood-mainnet.json`;
const shipped = JSON.parse(readFileSync(shippedPath, 'utf8'));
const L = shipped.lending;
if (!L?.markets?.length) {
  console.error('lending-verify: the shipped allowlist has no lending section');
  process.exit(1);
}
const M = L.markets[0];
const MORPHO = L.morpho;
const USDG = shipped.quote_token.address;
const NVDA = M.collateral_token;
const NVDA_POOL = shipped.tokens.find((t) => t.address.toLowerCase() === NVDA.toLowerCase()).pool;

// THE ONLY DIFFERENCE between the two files is this one boolean. Anything else
// changed here would mean part 2 proves a policy that does not ship.
const enabledPath = join(dir, 'allowlist-enabled.json');
writeFileSync(enabledPath, JSON.stringify({ ...shipped, lending: { ...L, enabled: true } }, null, 2));

// --- a chain that answers what the signer asks ------------------------------
// paused() false, isBlocked() reverting with the recorded payload (what the real
// tokens do), and Morpho's position()/market() arranged so the wallet's debt is
// exactly `debtBase` base units: totalBorrowShares = totalBorrowAssets * 1e6 makes
// assets = shares / 1e6 with no rounding.
let debtBase = 0n;
let morphoDown = false;
const TOTAL_ASSETS = 1_000_000_000_000n;
const w = (v) => BigInt(v).toString(16).padStart(64, '0');
const recordedRevertFor = (addr) => {
  const t = [shipped.quote_token, ...shipped.tokens].find((x) => x.address.toLowerCase() === String(addr).toLowerCase());
  return t?.blocklist_unreadable?.revert_data ?? '0x';
};
const rpc = createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => {
    let id = 1, data = '', to = '';
    try { const j = JSON.parse(b); id = j.id; data = j.params?.[0]?.data || ''; to = j.params?.[0]?.to || ''; } catch {}
    res.writeHead(200, { 'content-type': 'application/json' });
    const ok = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    if (data.startsWith('0xfbac3951')) {
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: recordedRevertFor(to) } }));
      return;
    }
    if (data.startsWith('0x93c52062') || data.startsWith('0x5c60e39a')) {
      if (morphoDown) { res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'upstream unavailable' } })); return; }
      if (data.startsWith('0x93c52062')) return ok('0x' + w(0) + w(debtBase * 1_000_000n) + w(0));
      return ok('0x' + w(0) + w(0) + w(TOTAL_ASSETS) + w(TOTAL_ASSETS * 1_000_000n) + w(0) + w(0));
    }
    if (data === '') return ok('0x1237');
    return ok('0x' + w(0)); // paused() -> false
  });
});

// --- the signer, BUILT rather than `go run` (see signer-verify.mjs) ----------
const BIN = `/tmp/lending-verify-signer.${process.pid}`;
let proc = null;
const AGENT = randomUUID();
function start(allowPath) {
  const p = spawn(BIN, [], {
    cwd: `${REPO}/services/signer`,
    env: { ...process.env, PORT: String(PORT), INTERNAL_API_KEY: KEY,
           SIGNER_MASTER_SEED_FILE: seedPath, SIGNER_ALLOWLIST_FILE: allowPath,
           SIGNER_RPC_URLS: `http://127.0.0.1:${RPC_PORT}`, SIGNER_CHAIN_CACHE_TTL_MS: '1',
           SIGNER_SIGNATURE_COUNT_FILE: join(dir, 'signatures.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Drained, or a full pipe blocks the signer's log writes mid-request; see
  // the note on start() in signer-verify.mjs.
  p.stdout.resume();
  p.stderr.on('data', () => {});
  return p;
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
    try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) return (await r.json()); } catch {}
    await new Promise((r) => setTimeout(r, 350));
  }
  return null;
}
async function assertPortFree() {
  try { execFileSync('bash', ['-lc', `fuser -k ${PORT}/tcp 2>/dev/null || true`]); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  let answered = false;
  try { answered = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok; } catch {}
  if (answered) throw new Error(`something already answers on ${PORT}; this suite would measure it instead`);
}
const sign = async (body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/internal/v1/signer/sign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Key': KEY },
    body: JSON.stringify({ agent_id: AGENT, nonce: 0, gas: 400000, ...body }) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const code = (r) => r.body?.error?.code || '';
const usdg = (whole) => String(BigInt(whole) * 1_000_000n);

process.on('exit', () => { try { proc?.kill('SIGKILL'); } catch {} });

try {
  await new Promise((r) => rpc.listen(RPC_PORT, '127.0.0.1', r));
  await assertPortFree();
  execFileSync(GO, ['build', '-o', BIN, './cmd/server'], { cwd: `${REPO}/services/signer`, stdio: 'inherit' });

  // === 1 ====================================================================
  console.log('\n=== 1. The shipped allowlist refuses every lending intent ===');
  proc = start(shippedPath);
  const h1 = await waitUp();
  check('the signer came up on the shipped allowlist', h1 !== null, 'never became healthy');
  check('and reports lending disabled on /healthz', h1?.lending_enabled === false, JSON.stringify(h1));
  for (const [intent, extra] of [
    ['lending_approve', { token_in: USDG, amount: usdg(10) }],
    ['lending_supply', { amount: String(10n ** 18n) }],
    ['lending_borrow', { amount: usdg(10) }],
    ['lending_repay', { amount: usdg(10) }],
  ]) {
    const r = await sign({ intent, market_id: M.id, ...extra });
    check(`${intent} -> lending_not_enabled`, r.status === 403 && code(r) === 'lending_not_enabled',
      `${r.status} ${JSON.stringify(r.body)}`);
  }
  await stop();

  // === 2 ====================================================================
  console.log('\n=== 2. With lending enabled, every cap refuses and names itself ===');
  proc = start(enabledPath);
  const h2 = await waitUp();
  check('the signer came up with lending enabled', h2?.lending_enabled === true, JSON.stringify(h2));
  const wallet = (await (await fetch(`http://127.0.0.1:${PORT}/internal/v1/signer/wallets/${AGENT}`,
    { headers: { 'X-Internal-Key': KEY } })).json()).address;
  console.log(`  wallet ${wallet}`);

  const cap = BigInt(L.limits.max_borrow_per_tx_usdg);
  const debtCap = BigInt(L.limits.max_debt_per_agent_usdg);
  debtBase = 0n;
  let r = await sign({ intent: 'lending_borrow', market_id: M.id, amount: String(cap * 1_000_000n + 1n) });
  check(`one base unit over the ${cap} USDG per-transaction cap -> borrow_over_tx_cap`,
    code(r) === 'borrow_over_tx_cap', `${r.status} ${JSON.stringify(r.body)}`);
  r = await sign({ intent: 'lending_borrow', market_id: M.id, amount: String(cap * 1_000_000n * 1_000_000_000_000n) });
  check('the same cap read as 18 decimals (10^12 too many) -> borrow_over_tx_cap, not a pass',
    code(r) === 'borrow_over_tx_cap', `${r.status} ${JSON.stringify(r.body)}`);
  debtBase = (debtCap - cap) * 1_000_000n + 1n;
  r = await sign({ intent: 'lending_borrow', market_id: M.id, amount: usdg(cap) });
  check(`existing debt one base unit past ${debtCap - cap} USDG + ${cap} -> debt_over_agent_cap`,
    code(r) === 'debt_over_agent_cap', `${r.status} ${JSON.stringify(r.body)}`);
  debtBase = (debtCap - cap) * 1_000_000n;
  r = await sign({ intent: 'lending_borrow', market_id: M.id, amount: usdg(cap) });
  check(`and exactly at the ${debtCap} USDG cap it signs`, r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
  morphoDown = true;
  r = await sign({ intent: 'lending_borrow', market_id: M.id, amount: usdg(1) });
  check('a debt the chain will not answer -> chain_state_unverifiable', code(r) === 'chain_state_unverifiable',
    `${r.status} ${JSON.stringify(r.body)}`);
  morphoDown = false;
  r = await sign({ intent: 'lending_borrow', market_id: '0x' + 'ab'.repeat(32), amount: usdg(1) });
  check('a market that is not allowlisted -> market_not_allowlisted', code(r) === 'market_not_allowlisted',
    `${r.status} ${JSON.stringify(r.body)}`);
  r = await sign({ intent: 'lending_approve', market_id: M.id, token_in: shipped.tokens[0].address, amount: '1' });
  check('an approval for a token the market does not use -> lending_token_not_in_market',
    code(r) === 'lending_token_not_in_market', `${r.status} ${JSON.stringify(r.body)}`);
  r = await sign({ intent: 'lending_approve', market_id: M.id, token_in: USDG, amount: String(2n ** 256n - 1n) });
  check('an unlimited approval to Morpho -> unbounded_approval', code(r) === 'unbounded_approval',
    `${r.status} ${JSON.stringify(r.body)}`);
  r = await sign({ intent: 'lending_borrow', market_id: M.id, amount: usdg(1), receiver: '0xdEAD00000000000000000000000000000000BEEF' });
  check('a request naming a receiver is refused — there is no such field', r.status === 403 && code(r) === 'bad_request',
    `${r.status} ${JSON.stringify(r.body)}`);

  // === 3 ====================================================================
  console.log('\n=== 3. What it signs works against live state, and the controls revert ===');
  debtBase = 0n;
  const signed = {};
  for (const [k, body] of Object.entries({
    approveNvda: { intent: 'lending_approve', token_in: NVDA, amount: String(10n ** 18n) },
    supply: { intent: 'lending_supply', amount: String(10n ** 18n) },
    borrow: { intent: 'lending_borrow', amount: usdg(50) },
    approveUsdg: { intent: 'lending_approve', token_in: USDG, amount: usdg(50) },
    repay: { intent: 'lending_repay', amount: usdg(50) },
    // Control A's pair: 0.5 NVDA (~$111, borrowable ~70 at 62.5%) and a 100 USDG
    // borrow, which is inside the signer's cap and over the market's LLTV. On a
    // whole NVDA the same borrow is healthy, so the control needs the half.
    supplyHalf: { intent: 'lending_supply', amount: String(10n ** 18n / 2n) },
    borrowOver: { intent: 'lending_borrow', amount: usdg(100) },
  })) {
    const s = await sign({ market_id: M.id, ...body });
    if (s.status !== 200) { check(`${k} signed`, false, `${s.status} ${JSON.stringify(s.body)}`); continue; }
    const t = viem.parseTransaction(s.body.raw);
    const from = await viem.recoverTransactionAddress({ serializedTransaction: s.body.raw });
    signed[k] = { to: t.to, data: t.data, from };
  }
  check('every shape was signed', Object.keys(signed).length === 7, Object.keys(signed).join(','));
  check('viem recovers the derived wallet as the sender of every one',
    Object.values(signed).every((x) => x.from.toLowerCase() === wallet.toLowerCase()),
    Object.values(signed).map((x) => x.from).join(','));
  check('supply, borrow and repay are addressed to Morpho',
    ['supply', 'borrow', 'repay'].every((k) => signed[k]?.to?.toLowerCase() === MORPHO.toLowerCase()));
  check('the approvals are addressed to the token and name Morpho as spender',
    signed.approveNvda?.to?.toLowerCase() === NVDA.toLowerCase() &&
    signed.approveNvda?.data?.toLowerCase().includes(MORPHO.slice(2).toLowerCase()));
  const selfWord = wallet.slice(2).toLowerCase().padStart(64, '0');
  check('borrow names the agent wallet as both onBehalf and receiver',
    (signed.borrow?.data?.toLowerCase().match(new RegExp(selfWord, 'g')) ?? []).length === 2);

  const live = viem.createPublicClient({ transport: viem.http(LIVE_RPC, { timeout: 60_000 }) });
  const fund = { from: NVDA_POOL, to: NVDA,
    data: viem.encodeFunctionData({ abi: viem.parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: [wallet, 10n ** 18n] }) };
  const asCall = (k) => ({ from: wallet, to: signed[k].to, data: signed[k].data });
  const liquidator = '0x000000000000000000000000000000000000dEaD';
  const liquidate = { from: liquidator, to: MORPHO, data: viem.encodeFunctionData({
    abi: viem.parseAbi(['function liquidate((address,address,address,address,uint256),address,uint256,uint256,bytes)']),
    functionName: 'liquidate',
    args: [[M.loan_token, M.collateral_token, M.oracle, M.irm, BigInt(M.lltv)], wallet, 10n ** 17n, 0n, '0x'] }) };
  const simulate = async (calls) => {
    await new Promise((r2) => setTimeout(r2, 3000)); // the public RPC answers 429 to a burst
    const res = await live.request({ method: 'eth_simulateV1',
      params: [{ blockStateCalls: [{ calls: calls.map((c) => ({ ...c, gas: '0x1c9c380' })) }], validation: false }, 'latest'] });
    return res[0].calls.map((c) => ({ ok: c.status === '0x1', why: c.error?.message ?? '' }));
  };

  if (Object.keys(signed).length === 7) {
    const path = await simulate([fund, asCall('approveNvda'), asCall('supply'), asCall('borrow'), asCall('approveUsdg'), asCall('repay')]);
    check('the signed path executes on live state: approve, supply 1 NVDA, borrow 50, approve, repay 50',
      path.every((s) => s.ok), JSON.stringify(path));
    const a = await simulate([fund, asCall('approveNvda'), asCall('supplyHalf'), asCall('borrowOver')]);
    check('control A: a signed 100 USDG borrow on ~$111 of NVDA (inside the signer cap) reverts on LLTV',
      a[3] && !a[3].ok && /insufficient collateral/.test(a[3].why), JSON.stringify(a[3]));
    const b = await simulate([asCall('borrow')]);
    check('control B: the signed borrow with no collateral reverts',
      b[0] && !b[0].ok && /insufficient collateral/.test(b[0].why), JSON.stringify(b[0]));
    const c = await simulate([fund, asCall('approveNvda'), asCall('supply'), asCall('borrow'), liquidate]);
    check('control C: a stranger cannot liquidate the healthy position',
      c[4] && !c[4].ok && /position is healthy/.test(c[4].why), JSON.stringify(c[4]));
    const d = await simulate([fund, asCall('supply')]);
    check('control D: the signed supply without its approval reverts',
      d[1] && !d[1].ok && /transferFrom reverted/.test(d[1].why), JSON.stringify(d[1]));
  }
} catch (e) {
  check('the suite ran to completion', false, e?.message ?? String(e));
} finally {
  await stop();
  rpc.close();
  try { execFileSync('rm', ['-f', BIN]); } catch {}
}

console.log(`\n========================================`);
console.log(`  PASS: ${pass}   FAIL: ${fail}`);
console.log(`========================================`);
if (fail) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail === 0 ? 0 : 1);
