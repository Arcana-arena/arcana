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
];

const params = {
  eth_chainId: [],
  eth_call: [{ to: PROBE_TO, data: '0x313ce567' }, 'latest'], // decimals()
  eth_getStorageAt: [PROBE_TO, '0x0', 'latest'],
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

// And the negative control: the two known-bad providers must STILL be bad, so
// that a passing run means the probe distinguishes them rather than passing
// everything.
console.log('\n=== negative control: the trap must still be detectable ===');
for (const bad of ['https://robinhood.drpc.org', 'https://rpc.nodeflare.app/robinhood/public']) {
  const chain = await probe(bad, 'eth_chainId');
  const call = await probe(bad, 'eth_call');
  if (!chain.ok) {
    console.log(`    SKIP  ${bad} is unreachable entirely; nothing to distinguish`);
  } else {
    check(`${bad} answers eth_chainId but NOT eth_call — the probe can tell them apart`,
      chain.ok && !call.ok, `chainId=${chain.ok} call=${call.ok}`);
  }
}

console.log(`\n========================================`);
console.log(`  PASS: ${pass}   FAIL: ${fail}`);
console.log(`========================================`);
if (fail) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
console.log('rpc-endpoints-verify: every configured endpoint serves what its component calls.');
