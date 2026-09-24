/**
 * ARCANA RPC endpoint verification.
 *
 * WHY THIS EXISTS. Twice now, an endpoint that answers `eth_chainId` and refuses
 * `eth_call` has been listed as a fallback: `robinhood.drpc.org` and
 * `rpc.nodeflare.app`, two unrelated providers with the same defect. Listed that
 * way they satisfy the identity check and then fail every real read — redundancy
 * that makes one point of failure look like several, so nobody goes looking when
 * the one real provider has a bad hour.
 *
 * A list checked with `eth_chainId` proves nothing: anything answers that.
 *
 * So this reads the endpoint lists OUT OF THE SOURCE — not a copy kept here,
 * which would drift — and probes each one with the methods those components
 * actually call. A comment claiming the list was checked is not evidence; this
 * is.
 *
 * Usage:
 *   node infra/verify/rpc-endpoints-verify.mjs
 * Exits non-zero if any configured endpoint cannot serve its component's calls,
 * or if a component is left with fewer than two working endpoints.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

// A contract that certainly exists, so a failure means the endpoint and not the
// argument: USDG, the quote token every allowlisted pool trades against.
const PROBE_TO = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const EXPECT_CHAIN = '0x1237'; // 4663

// Read the lists from where they are actually configured.
function extractList(file, marker) {
  const src = readFileSync(file, 'utf8');
  const i = src.indexOf(marker);
  if (i < 0) throw new Error(`marker ${marker} not found in ${file}`);
  const m = src.slice(i).match(/'(https:\/\/[^']+)'/);
  if (!m) throw new Error(`no endpoint list found after ${marker} in ${file}`);
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}
function extractGoList(file, marker) {
  const src = readFileSync(file, 'utf8');
  const i = src.indexOf(marker);
  if (i < 0) throw new Error(`marker ${marker} not found in ${file}`);
  const m = src.slice(i).match(/"(https:\/\/[^"]+)"/);
  if (!m) throw new Error(`no endpoint list found after ${marker} in ${file}`);
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

const components = [
  {
    name: 'chain guard',
    urls: extractList(join(REPO, 'infra/alerting/arcana-chain-guard.mjs'), 'const RPCS = (process.env.CHAIN_RPC_URLS'),
    methods: ['eth_chainId', 'eth_call', 'eth_getStorageAt'],
  },
  {
    name: 'signer',
    urls: extractGoList(join(REPO, 'services/signer/cmd/server/main.go'), 'rpcs := strings.Split(envOr("SIGNER_RPC_URLS"'),
    methods: ['eth_call'],
  },
  {
    name: 'execution watchdog',
    urls: extractList(join(REPO, 'infra/alerting/arcana-execution-watchdog.sh'), "DEFAULT_RPC_URLS='"),
    methods: ['eth_getBalance', 'eth_getTransactionCount'],
  },
];

const params = {
  eth_chainId: [],
  eth_call: [{ to: PROBE_TO, data: '0x313ce567' }, 'latest'], // decimals()
  eth_getStorageAt: [PROBE_TO, '0x0', 'latest'],
  eth_getBalance: [PROBE_TO, 'latest'],
  eth_getTransactionCount: [PROBE_TO, 'latest'],
};

let pass = 0, fail = 0;
const failures = [];
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log(`    PASS  ${n}`); }
  else { fail++; failures.push(`${n} — ${d}`); console.log(`    FAIL  ${n} — ${d}`); }
};

async function probe(url, method) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params[method] }),
    });
    const j = await r.json();
    if (j.error) return { ok: false, why: `${j.error.message} (${j.error.code})` };
    return { ok: true, result: j.result };
  } catch (e) {
    return { ok: false, why: e.message };
  } finally {
    clearTimeout(timer);
  }
}

for (const c of components) {
  console.log(`\n=== ${c.name}: ${c.urls.length} endpoint(s), probed with ${c.methods.join(', ')} ===`);
  let working = 0;
  for (const url of c.urls) {
    let allOk = true;
    const missing = [];
    for (const m of c.methods) {
      const r = await probe(url, m);
      if (!r.ok) { allOk = false; missing.push(`${m} (${r.why})`); }
      else if (m === 'eth_chainId' && r.result !== EXPECT_CHAIN) {
        allOk = false; missing.push(`eth_chainId returned ${r.result}, expected ${EXPECT_CHAIN}`);
      }
    }
    check(`${url} serves every method this component calls`, allOk, missing.join('; '));
    if (allOk) working++;
  }
  // One working endpoint is not redundancy. The whole point of the list is that
  // a provider having a bad hour does not stop the component.
  check(`${c.name} has at least two working endpoints`, working >= 2, `only ${working} working`);
}

// --- the negative control ---------------------------------------------------
//
// THE TRAP THIS SUITE EXISTS FOR: an endpoint that answers eth_chainId happily
// and cannot serve eth_call. It looks alive to anything that checks liveness
// and is useless to anything that reads state.
//
// A control needs a subject that behaves that way. It used to name two real
// providers, and on 2026-09-12 one of them — robinhood.drpc.org — started
// answering eth_call as well. The control reported that it could no longer tell
// them apart, which was the honest answer and left the suite with nothing
// proving the probe works.
//
// A CONTROL WHOSE SUBJECT CAN HEAL ITSELF IS NOT A CONTROL. The trap is now
// built here, in a server this file starts and stops: it answers eth_chainId
// and refuses eth_call, exactly and forever, because that is what it is for.
// The real providers are still probed below — as EVIDENCE about the internet,
// which is worth having and is not the same thing as a control.
console.log('\n=== negative control: the trap must still be detectable ===');
{
  // A chain that answers liveness and nothing else.
  const trap = createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => (body += c));
    rq.on('end', () => {
      let method = '';
      try { method = JSON.parse(body).method ?? ''; } catch {}
      rs.setHeader('Content-Type', 'application/json');
      if (method === 'eth_chainId') {
        rs.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1237' }));
        return;
      }
      // The shape a real one of these returns: a JSON-RPC error, not a hang and
      // not an HTTP failure, which is precisely why liveness checks miss it.
      rs.end(JSON.stringify({
        jsonrpc: '2.0', id: 1,
        error: { code: -32601, message: 'the method eth_call does not exist/is not available' },
      }));
    });
  });
  await new Promise((r) => trap.listen(0, '127.0.0.1', r));
  const trapURL = `http://127.0.0.1:${trap.address().port}`;

  const chain = await probe(trapURL, 'eth_chainId');
  const call = await probe(trapURL, 'eth_call');
  check('a chainId-only endpoint is detected as such by the probe',
    chain.ok && !call.ok, `chainId=${chain.ok} call=${call.ok}`);

  // AND THE OTHER HALF. A control that only proves the probe can say "bad"
  // would pass just as well if the probe said "bad" to everything.
  const good = createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => (body += c));
    rq.on('end', () => {
      let method = '';
      try { method = JSON.parse(body).method ?? ''; } catch {}
      rs.setHeader('Content-Type', 'application/json');
      rs.end(JSON.stringify({
        jsonrpc: '2.0', id: 1,
        result: method === 'eth_chainId' ? '0x1237' : '0x' + '0'.repeat(64),
      }));
    });
  });
  await new Promise((r) => good.listen(0, '127.0.0.1', r));
  const goodURL = `http://127.0.0.1:${good.address().port}`;
  const gChain = await probe(goodURL, 'eth_chainId');
  const gCall = await probe(goodURL, 'eth_call');
  check('and an endpoint that serves both is NOT flagged',
    gChain.ok && gCall.ok, `chainId=${gChain.ok} call=${gCall.ok}`);

  trap.close();
  good.close();
}

// The real providers, as evidence rather than as a control. What they do today
// is worth recording — an endpoint that has started serving eth_call is a
// candidate for the list, and one that stops is a reason not to rely on it —
// but nothing here fails because a stranger changed their configuration.
console.log('\n=== the known-bad providers, as they behave today ===');
for (const bad of ['https://robinhood.drpc.org', 'https://rpc.nodeflare.app/robinhood/public']) {
  const chain = await probe(bad, 'eth_chainId');
  const call = await probe(bad, 'eth_call');
  const verdict = !chain.ok ? 'unreachable'
    : call.ok ? 'now serves BOTH — it could be considered for the endpoint list'
      : 'still chainId-only — the trap this suite was written for';
  console.log(`    NOTE  ${bad}: ${verdict}`);
}

console.log(`\n========================================`);
console.log(`  PASS: ${pass}   FAIL: ${fail}`);
console.log(`========================================`);
if (fail) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
console.log('rpc-endpoints-verify: every configured endpoint serves what its component calls.');
