#!/usr/bin/env node
// arcana-chain-guard.mjs — watch the things the token issuer controls.
//
// THE CASE THIS EXISTS FOR. Every Robinhood Stock Token is a beacon proxy, and
// all nine tokens ARCANA can trade point at the SAME beacon and the SAME
// implementation (verified across all nine, 2026-09-10). One upgrade
// transaction therefore rewrites the transfer rules for every Stock Token at
// once — and the permission this entire direction rests on, that an
// ARCANA-created wallet may hold and trade them, could be revoked with no
// notice and no announcement.
//
// Today the token carries a BLOCKLIST: permissive by default, deny named
// addresses. An upgrade could make it an ALLOWLIST: deny by default. Nothing
// about that change would be visible from inside ARCANA until an agent's trade
// started reverting and its owner asked why.
//
// So: read the values the issuer controls, compare them to a baseline a human
// reviewed and committed, and shout when they move.
//
// WHY THE BASELINE IS IN GIT AND NOT IN THE DATABASE. A monitor that stores
// what it last saw will, on its first run after a change, quietly adopt the new
// value as normal — and the one moment it existed to report is the one moment
// it stays silent. A committed baseline means a change requires a person to
// look at it, date it, and say so. Same reasoning as the market universe living
// in git rather than in .env: this is a rule, not a setting.
//
// WHAT THIS DOES NOT DO. It does not decide whether a change is bad. It reports
// that the ground moved. Judging it is a person's job, and the alert says so.
//
// Exit codes, matching arcana-tick-watchdog.sh:
//   0 = the check ran (healthy, or drift found and alerted)
//   1 = the check itself could not run — OnFailure= turns that into its own
//       alert, because "could not find out" and "nothing changed" are different
//       answers and must never be collapsed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = process.env.CHAIN_BASELINE || join(HERE, 'chain-baseline.json');
const NOTIFY = process.env.ARCANA_NOTIFY || join(HERE, 'arcana-notify.sh');
// The signer's allowlist, read directly. See check 7.
const ALLOWLIST = process.env.SIGNER_ALLOWLIST_FILE ||
  join(HERE, '..', '..', 'services', 'signer', 'allowlist', 'robinhood-mainnet.json');
// Any address works for an isBlocked() probe whose purpose is to observe HOW
// the call fails rather than what it answers. A constant is used so the guard
// never needs to know a real wallet to run this check.
const PROBE_WALLET = process.env.CHAIN_GUARD_PROBE_WALLET || '0x0000000000000000000000000000000000000001';
const DRY_RUN = process.env.CHAIN_GUARD_DRY_RUN === '1';
const TIMEOUT_MS = Number(process.env.CHAIN_GUARD_TIMEOUT_MS || 15000);

// Several endpoints, because one provider having a bad afternoon must not read
// as "the issuer changed something". They are probed at startup (see preflight)
// and any that cannot serve this workload is dropped rather than counted.
//
// TWO ENDPOINTS ARE DELIBERATELY ABSENT, and both for the same reason.
// robinhood.drpc.org and rpc.nodeflare.app each answer eth_chainId and REFUSE
// eth_call. Listed as fallbacks they would satisfy the identity check and then
// fail every real read: redundancy that makes one point of failure look like
// several. Two independent providers with the same defect is why the preflight
// below is a permanent mechanism rather than a one-off fix.
//
// The four here were each probed with the methods this guard actually calls,
// and all four answered. See infra/verify/rpc-endpoints-verify.mjs, which
// re-checks that claim rather than trusting this comment.
const RPCS = (process.env.CHAIN_RPC_URLS ||
  'https://rpc.mainnet.chain.robinhood.com,https://robinhood-rpc.publicnode.com,https://robinhood.api.pocket.network,https://rpc-robinhood.blockmachine.io'
).split(',').map(s => s.trim()).filter(Boolean);

// Test hooks. Used by the verification rig to prove each branch alarms; never
// set in the installed unit.
const FORCE_IMPL = process.env.CHAIN_GUARD_FORCE_IMPL || '';
const FORCE_PAUSED = process.env.CHAIN_GUARD_FORCE_PAUSED || '';
// SYMBOL:0xpayload — pretends isBlocked() returned that payload for one token,
// so the drift branch can be proven to alarm instead of assumed to.
const FORCE_BLOCKDATA = (() => {
  const raw = process.env.CHAIN_GUARD_FORCE_BLOCKDATA || '';
  const i = raw.indexOf(':');
  return i > 0 ? { symbol: raw.slice(0, i), data: raw.slice(i + 1) } : null;
})();

const log = (...a) => console.log('chain-guard:', ...a);
const verdict = (v, why) => console.log(`chain-guard: VERDICT=${v} REASON=${why}`);

// --- transport --------------------------------------------------------------

let rpcId = 0;
let liveRpc = null;
let endpoints = RPCS.slice();

const RETRIES = Number(process.env.CHAIN_GUARD_RETRIES || 3);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// One raw attempt against one endpoint.
async function rpcOnce(url, method, params) {
  // The timeout is cleared explicitly rather than left to AbortSignal.timeout.
  // A pending timer keeps the event loop alive, and exiting on top of one
  // trips a libuv assertion that replaces the intended exit code.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    const j = await res.json();
    if (j.error) {
      const e = new Error(`${j.error.message} (${j.error.code})`);
      // The revert PAYLOAD, kept rather than flattened. The signer excepts a
      // token from the isBlocked() check by recording exactly what that call
      // returns, so this guard can only notice the exception going stale if
      // it can see the same thing the signer sees.
      e.revertData = typeof j.error.data === 'string' ? j.error.data : null;
      // -32601 is "method not supported": a permanent property of the endpoint,
      // not a transient fault. Retrying it wastes the budget.
      e.methodUnsupported = j.error.code === -32601;
      e.rpcError = true;
      throw e;
    }
    return j.result;
  } finally {
    clearTimeout(timer);
  }
}

// PREFLIGHT — keep only endpoints that can serve the calls this guard makes.
//
// This exists because of a specific trap. `robinhood.drpc.org` answers
// eth_chainId happily and REFUSES eth_call and eth_getStorageAt on its free
// tier. Listed as a fallback it looked like redundancy and provided none: it
// satisfied the chain-id check, then failed every real read. A fallback that
// cannot serve the workload is worse than no fallback, because it makes a
// single point of failure look like two.
//
// So the list is probed with the actual methods, and whatever cannot serve them
// is dropped loudly rather than kept as decoration.
async function preflight() {
  const probes = [
    ['eth_chainId', []],
    ['eth_call', [{ to: '0x0000000000000000000000000000000000000000', data: '0x' }, 'latest']],
    ['eth_getStorageAt', ['0x0000000000000000000000000000000000000000', '0x0', 'latest']],
  ];
  const usable = [];
  for (const url of RPCS) {
    let ok = true, why = '', transportFails = 0;
    for (const [m, p] of probes) {
      try { await rpcOnce(url, m, p); }
      catch (e) {
        if (e.methodUnsupported) { ok = false; why = `does not serve ${m}`; break; }
        // A transient failure on ONE probe is not grounds to drop an endpoint —
        // keep it and let the retry logic decide. Failing EVERY probe is
        // different: the endpoint is unreachable from this host, and keeping it
        // only spends the retry budget on something that will not answer.
        // (This is how the official RPC behaves from a network whose ISP
        // intercepts robinhood.com — it works fine from the VPS.)
        transportFails++;
      }
    }
    if (ok && transportFails === probes.length) { ok = false; why = 'unreachable from this host'; }
    if (ok) usable.push(url); else log(`endpoint dropped: ${url} — ${why}`);
  }
  endpoints = usable;
}

async function rpc(method, params = []) {
  const errors = [];
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    for (const url of endpoints) {
      try {
        const r = await rpcOnce(url, method, params);
        liveRpc = url;
        return r;
      } catch (e) {
        if (e.methodUnsupported) continue;
        errors.push(`${url}: ${e.message}`);
      }
    }
    // Public endpoints hiccup. A monitor that treats one dropped connection as
    // "the issuer changed something" — or as a monitor fault — trains whoever
    // reads the alerts to ignore them, which is the failure this whole
    // alerting layer exists to avoid.
    if (attempt < RETRIES) await sleep(250 * attempt);
  }
  const err = new Error(`all RPC endpoints failed after ${RETRIES} attempts — ${[...new Set(errors)].slice(0, 4).join(' | ')}`);
  err.unreachable = true;
  throw err;
}

// eth_call that reports a revert as a value rather than throwing, because a
// reverting view function is a fact about the contract, not a transport fault.
async function ethCall(to, data) {
  try {
    const r = await rpc('eth_call', [{ to, data }, 'latest']);
    return { ok: true, result: r };
  } catch (e) {
    if (e.unreachable) throw e;
    return { ok: false, error: e.message, revertData: e.revertData ?? null };
  }
}

const addrFrom = (word) => (word && /[1-9a-f]/i.test(word.slice(2)) ? '0x' + word.slice(-40).toLowerCase() : null);
const same = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase();

// --- alerting ---------------------------------------------------------------

function raise(priority, title, body) {
  if (DRY_RUN) {
    log(`[dry-run] WOULD ALERT (${priority}): ${title}`);
    body.split('\n').forEach(l => console.log('  ' + l));
    return;
  }
  const r = spawnSync('bash', [NOTIFY, 'alert', priority, title], { input: body, encoding: 'utf8' });
  if (r.status !== 0) {
    // The notifier failing is itself worth seeing in the journal. It does not
    // make the check a failure — the finding is already printed above.
    log(`ERROR: arcana-notify.sh exited ${r.status}: ${(r.stderr || '').trim().slice(0, 200)}`);
  }
}

// --- checks -----------------------------------------------------------------

const SEL = {
  implementation: '0x5c60da1b',   // UpgradeableBeacon.implementation()
  paused:         '0x5c975abb',   // paused()
  liquidity:      '0x1a686502',   // UniswapV3Pool.liquidity()
  isBlocked:      '0xfbac3951',   // isBlocked(address)
};
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

async function main() {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch (e) {
    log(`ERROR: cannot read the baseline at ${BASELINE}: ${e.message}`);
    log('ERROR: without a reviewed baseline there is nothing to compare against.');
    return 1;
  }
  log(`baseline reviewed ${baseline.reviewed_at}, ${baseline.tokens.length} tokens`);

  // 1. Which endpoints can actually serve this workload?
  await preflight();
  if (endpoints.length === 0) {
    log('ERROR: no configured RPC endpoint serves the calls this guard makes.');
    return 1;
  }
  log(`usable endpoints: ${endpoints.length}/${RPCS.length}`);

  // 2. Is this the chain we think it is? A wrong chain id means every
  //    comparison below is meaningless, so it is a check failure, not a finding.
  let chainId;
  try {
    chainId = Number(BigInt(await rpc('eth_chainId')));
  } catch (e) {
    log(`ERROR: ${e.message}`);
    log('ERROR: the chain could not be read at all — this is a monitor fault, not a finding.');
    return 1;
  }
  if (chainId !== baseline.chain_id) {
    log(`ERROR: connected to chain ${chainId}, baseline is for ${baseline.chain_id}`);
    return 1;
  }
  log(`chain ${chainId} via ${liveRpc}`);

  const findings = [];
  let checked = 0;

  for (const t of baseline.tokens) {
    // 2. The beacon pointer on the token itself.
    let beaconNow;
    try {
      beaconNow = addrFrom(await rpc('eth_getStorageAt', [t.address, BEACON_SLOT, 'latest']));
    } catch (e) {
      log(`ERROR: ${t.symbol}: could not read the beacon slot: ${e.message}`);
      return 1;
    }
    if (t.beacon && !same(beaconNow, t.beacon)) {
      findings.push({ sev: 'critical', symbol: t.symbol,
        what: 'the token now points at a DIFFERENT BEACON',
        was: t.beacon, now: beaconNow || '(none)' });
    }

    // 3. The implementation behind the beacon. THE one that matters.
    if (beaconNow) {
      const r = await ethCall(beaconNow, SEL.implementation);
      let implNow = r.ok ? addrFrom(r.result) : null;
      if (FORCE_IMPL) implNow = FORCE_IMPL;             // test hook
      if (!implNow) {
        // Could not read it. That is NOT "unchanged" — refuse to guess.
        log(`ERROR: ${t.symbol}: beacon ${beaconNow} did not return an implementation`);
        log('ERROR: refusing to treat an unreadable implementation as unchanged.');
        return 1;
      }
      if (!same(implNow, t.implementation)) {
        findings.push({ sev: 'critical', symbol: t.symbol,
          what: 'the token IMPLEMENTATION CHANGED — transfer rules may have changed with it',
          was: t.implementation, now: implNow });
      }
    }

    // 4. Is the token paused? An issuer pause stops every transfer.
    const p = await ethCall(t.address, SEL.paused);
    let pausedNow = p.ok && p.result !== '0x' ? BigInt(p.result) !== 0n : null;
    if (FORCE_PAUSED === t.symbol) pausedNow = true;    // test hook
    if (pausedNow === null) {
      findings.push({ sev: 'warning', symbol: t.symbol,
        what: 'paused() could not be read — state unknown, not assumed healthy',
        was: String(t.paused_expected), now: 'unreadable' });
    } else if (pausedNow !== t.paused_expected) {
      findings.push({ sev: 'critical', symbol: t.symbol,
        what: pausedNow ? 'the token is PAUSED by the issuer — no transfer will settle'
                        : 'the token is no longer paused',
        was: String(t.paused_expected), now: String(pausedNow) });
    }

    // 5. Coarse liveness on the pool ARCANA would route through.
    if (t.pool) {
      const l = await ethCall(t.pool, SEL.liquidity);
      const liq = l.ok && l.result !== '0x' ? BigInt(l.result) : null;
      if (liq === null) {
        findings.push({ sev: 'warning', symbol: t.symbol,
          what: 'pool liquidity() unreadable', was: 'readable', now: 'unreadable' });
      } else if (liq === 0n) {
        findings.push({ sev: 'warning', symbol: t.symbol,
          what: 'the pool has NO ACTIVE LIQUIDITY — a swap here would fail or fill terribly',
          was: '> 0', now: '0' });
      }
    }
    checked++;
  }

  // 6. Are any ARCANA wallets blocked? Wired in phase 8, when wallets exist.
  //
  // NOTE from the go/no-go test: isBlocked() reverts on these tokens today,
  // most likely delegating to a registry that is not set. A revert is recorded
  // as UNKNOWN, never as "not blocked" — the distinction between "checked and
  // clear" and "could not check" is the one this codebase keeps relearning.
  const wallets = (process.env.CHAIN_GUARD_WALLETS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (wallets.length === 0) {
    log('no ARCANA wallets configured yet (CHAIN_GUARD_WALLETS) — block check skipped, expected until phase 8');
  } else {
    for (const w of wallets) {
      for (const t of baseline.tokens) {
        const r = await ethCall(t.address, SEL.isBlocked + w.replace(/^0x/, '').toLowerCase().padStart(64, '0'));
        if (!r.ok) { log(`  isBlocked(${w}) on ${t.symbol}: UNKNOWN (reverted) — not read as "clear"`); continue; }
        if (r.result !== '0x' && BigInt(r.result) !== 0n) {
          findings.push({ sev: 'critical', symbol: t.symbol,
            what: `ARCANA wallet ${w} is BLOCKED by the issuer`, was: 'not blocked', now: 'blocked' });
        }
      }
    }
  }

  // 7. Do the signer's blocklist exceptions still describe reality?
  //
  // No token on this chain implements isBlocked(), so the signer allowlist
  // records that per token, with the revert payload that proves it. The signer
  // re-checks that payload on every signature and refuses when it changes, so
  // trading is already safe without this check. What this adds is NOTICE: a
  // silent change would otherwise first surface as a refused trade at the worst
  // possible moment, and an exception that quietly stopped matching is exactly
  // how a temporary workaround becomes a permanent one nobody revisits.
  //
  // It reads the SIGNER'S OWN allowlist, not a copy. A second copy of the
  // evidence would drift from the first, and then this check would be
  // faithfully monitoring the copy.
  let allow = null;
  try {
    allow = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  } catch (e) {
    log(`blocklist-exception check SKIPPED: cannot read ${ALLOWLIST}: ${e.message}`);
  }
  if (allow) {
    const excepted = [allow.quote_token, ...(allow.tokens || [])]
      .filter((t) => t && t.blocklist_unreadable);
    log(`${excepted.length} token(s) carry a blocklist exception; re-checking the evidence`);
    for (const t of excepted) {
      const ex = t.blocklist_unreadable;
      const arg = PROBE_WALLET.replace(/^0x/, '').toLowerCase().padStart(64, '0');
      const r = await ethCall(t.address, SEL.isBlocked + arg);
      let observed = r.ok
        ? '(it answered)'
        : (r.revertData ?? '(revert with no payload)');
      if (FORCE_BLOCKDATA && FORCE_BLOCKDATA.symbol === t.symbol) observed = FORCE_BLOCKDATA.data;
      if (observed === '(it answered)') {
        findings.push({
          sev: 'warning', symbol: t.symbol,
          what: 'isBlocked() now ANSWERS. The exception recorded for this token has expired and the '
              + 'full check applies again — remove it from the signer allowlist',
          was: `reverts with ${ex.revert_data}`,
          now: 'answers',
        });
      } else if (observed.toLowerCase() !== String(ex.revert_data).toLowerCase()) {
        findings.push({
          sev: 'critical', symbol: t.symbol,
          what: 'isBlocked() reverts DIFFERENTLY than the recorded evidence. The signer will refuse '
              + 'to sign for this token until the allowlist is re-verified',
          was: `${ex.revert_data} (verified ${ex.verified_at})`,
          now: observed,
        });
      }
    }
  }
  // --- report ---------------------------------------------------------------

  if (findings.length === 0) {
    verdict('healthy', `${checked} tokens match the baseline reviewed ${baseline.reviewed_at}`);
    return 0;
  }

  const critical = findings.filter(f => f.sev === 'critical');
  const body = [
    'The chain state ARCANA depends on no longer matches the reviewed baseline.',
    '',
    `baseline reviewed : ${baseline.reviewed_at}`,
    `chain             : ${chainId} via ${liveRpc}`,
    '',
    ...findings.map(f =>
      `[${f.sev.toUpperCase()}] ${f.symbol}: ${f.what}\n     was: ${f.was}\n     now: ${f.now}`),
    '',
    'All Stock Tokens share one beacon and one implementation, so an',
    'implementation change affects every one of them at once.',
    '',
    'next:',
    '  1. STOP funding new agent wallets until this is understood.',
    '  2. Re-run the permission test in docs/go-no-go-stock-tokens.md —',
    '     specifically T2: does a fresh wallet still fail with',
    '     ERC20InsufficientBalance, or with a compliance error now?',
    '  3. If the permission still holds, update infra/alerting/chain-baseline.json',
    '     deliberately, with the date and what changed. Do not let the monitor',
    '     adopt it silently.',
  ].join('\n');

  for (const f of findings) log(`${f.sev.toUpperCase()} ${f.symbol}: ${f.what} (was ${f.was}, now ${f.now})`);

  raise(critical.length ? 'high' : 'default',
    critical.length ? '🔴 ARCANA: Stock Token contract state CHANGED'
                    : '🟠 ARCANA: chain guard found drift',
    body);

  verdict('alarm', `${findings.length} finding(s), ${critical.length} critical`);
  return 0;
}

// Set the exit code and let the loop drain, rather than calling process.exit().
// Exiting on top of a live keep-alive socket trips a libuv assertion that
// replaces the exit code with 127 — observed on Windows, and the exit code here
// is load-bearing: systemd's OnFailure= reads it, and this monitor's whole
// discipline is that "could not check" (1) and "checked" (0) never blur.
// Draining costs a few seconds at most, which a timer-driven check can afford.
function finish(code) {
  process.exitCode = code;
  // Close idle keep-alive sockets so the process ends promptly instead of
  // waiting out the pool's idle timeout.
  const d = globalThis[Symbol.for('undici.globalDispatcher.1')];
  if (d && typeof d.close === 'function') d.close().catch(() => {});
}

main().then(finish).catch(e => {
  log(`ERROR: unhandled: ${e.stack || e.message}`);
  log('ERROR: the check did not complete — treating as a monitor fault, not as "no change".');
  finish(1);
});
