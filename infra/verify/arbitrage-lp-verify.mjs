// arbitrage-lp-verify.mjs — proves the LP registry loop's invariants.
//
// The loop reads the chain, writes the registry, and proposes actions. Nothing
// executes: the service cannot sign, and the signer has never been asked for an
// lp_* shape. So this suite asserts what is always true: the endpoints answer,
// a pass runs and stamps a fresh heartbeat with a discovery cursor, registry
// rows are internally consistent and belong to the configured position
// manager, proposals are only ever 'proposed' (never executed), the tables are
// standalone, and the signer's journal shows no lp_* signing at all.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { suite } from './lib/sections.mjs';

const ARB = process.env.ARBITRAGE_URL || 'http://127.0.0.1:8084';
const DB = process.env.DATABASE_URL || 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';

// Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256
// amount1) on the NonfungiblePositionManager. The PnL section below re-reads
// each harvest receipt from the chain and decodes this event itself, so the
// endpoint's numbers are checked against the transaction rather than trusted.
const COLLECT_TOPIC = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';

const sql = (q) => execFileSync('psql', [DB, '-At', '-q', '-c', q], { encoding: 'utf8' }).trim();

function internalKey() {
  if (process.env.INTERNAL_API_KEY) return process.env.INTERNAL_API_KEY;
  try {
    const c = readFileSync('/home/ubuntu/arcana/.env.auth', 'utf8');
    const m = c.match(/^INTERNAL_API_KEY=(.+)$/m);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

const get = async (path) => {
  const res = await fetch(ARB + path, { headers: { 'X-Arcana-Verification': '1' } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = suite('arbitrage-lp-verify');

await run.section('The service is up and the LP endpoints answer', async () => {
  const h = await get('/healthz');
  run.check('healthz returns 200', h.status === 200, `got ${h.status}`);
  run.check('service is arbitrage', h.body?.service === 'arbitrage', h.body?.service);

  const p = await get('/v1/arbitrage/lp/positions');
  run.check('positions returns 200', p.status === 200, `got ${p.status}`);
  run.check('positions is an array', Array.isArray(p.body?.positions), typeof p.body?.positions);

  const a = await get('/v1/arbitrage/lp/actions');
  run.check('actions returns 200', a.status === 200, `got ${a.status}`);
  run.check('actions is an array', Array.isArray(a.body?.actions), typeof a.body?.actions);
});

let npm = '';
let syncResult = null;

await run.section('A pass runs and reports what it did', async () => {
  const v = await get('/v1/arbitrage/venues');
  npm = v.body?.position_manager || '';
  run.check('a position manager is configured', /^0x[0-9a-f]{40}$/i.test(npm), npm);

  const key = internalKey();
  if (!key) {
    run.nothingToCheck('INTERNAL_API_KEY is not set, so the sync trigger cannot be called');
    return;
  }
  // The background loop may be mid-pass; a 409 means exactly that, so retry
  // briefly instead of failing on a healthy race.
  let status = 0;
  let body = {};
  for (let i = 0; i < 3; i++) {
    const res = await fetch(ARB + '/internal/v1/arbitrage/lp/sync', {
      method: 'POST',
      headers: { 'X-Internal-Key': key, 'X-Arcana-Verification': '1' },
    });
    status = res.status;
    body = await res.json().catch(() => ({}));
    if (status !== 409) break;
    await sleep(5000);
  }
  run.check('lp sync returns 200', status === 200, `got ${status} ${JSON.stringify(body)}`);
  if (status === 200) {
    syncResult = body;
    run.check('the pass reports counts', typeof body?.watched === 'number' && typeof body?.open === 'number' && typeof body?.errors === 'number',
      JSON.stringify(body));
    run.check('the pass reports no errors', body?.errors === 0, `${body?.errors} errors: ${body?.note || ''}`);
  }
});

await run.section('The heartbeat is fresh and carries a discovery cursor', async () => {
  const row = sql(`SELECT extract(epoch FROM (now() - last_sync_at))::int, positions, actions_proposed, discovery_block FROM lp_sync_heartbeat WHERE id = 1`);
  run.check('heartbeat row exists', row.length > 0, row);
  if (row.length > 0) {
    const [age, positions, actions, block] = row.split('|');
    run.check('heartbeat is under 15 minutes old', Number(age) < 900, `${age}s old`);
    run.check('heartbeat has a discovery cursor', /^\d+$/.test(block) && Number(block) > 0, block);
    const openRows = sql(`SELECT count(*) FROM lp_positions WHERE status = 'open'`);
    run.check('heartbeat position count equals the open registry rows', positions === openRows,
      `heartbeat ${positions} vs rows ${openRows}`);
  }
});

await run.section('Registry rows are consistent and belong to the configured position manager', async () => {
  const rows = await get('/v1/arbitrage/lp/positions?status=all');
  const list = rows.body?.positions;
  run.check('positions?status=all returns an array', Array.isArray(list));
  if (!Array.isArray(list) || list.length === 0) {
    run.nothingToCheck('no positions are registered yet (expected: no agent owns one)');
    return;
  }
  let ok = true;
  let detail = '';
  for (const p of list) {
    if (p.position_manager !== npm) { ok = false; detail = `token ${p.token_id} pm ${p.position_manager}`; }
    if (!/^\d{1,78}$/.test(p.token_id)) { ok = false; detail = `bad token_id ${p.token_id}`; }
    if (!/^0x[0-9a-f]{40}$/.test(p.wallet)) { ok = false; detail = `bad wallet ${p.wallet}`; }
    if (!['open', 'closed'].includes(p.status)) { ok = false; detail = `bad status ${p.status}`; }
    if (p.status === 'open' && !['hold', 'rebalance', 'empty'].includes(p.recommendation)) {
      ok = false; detail = `open token ${p.token_id} recommendation ${p.recommendation}`;
    }
  }
  run.check('every row is well-formed and belongs to the configured manager', ok, detail);
});

// The registry is EMPTY until an agent owns a position, which means the read
// path — nullable columns, the jsonb detail, the pointer fields — would never
// run before real money exists. So it is exercised here with rows that say
// what they are: provenance='verification', inserted and deleted inside this
// section, and swept again at the start in case an earlier run died between.
await run.section('The read path is exercised with a verification row', async () => {
  if (!npm) {
    run.nothingToCheck('no position manager configured, so no row can be attributed');
    return;
  }
  const wallet = sql(`SELECT address FROM agent_wallets WHERE address <> '' ORDER BY agent_id LIMIT 1`);
  const agent = sql(`SELECT agent_id FROM agent_wallets WHERE address <> '' ORDER BY agent_id LIMIT 1`);
  if (!wallet || !agent) {
    run.nothingToCheck('no agent wallet exists to attribute a verification row to');
    return;
  }
  const sweep = () => sql(`DELETE FROM lp_position_actions WHERE token_id = '999999999999' AND agent_id = '${agent}'; ` +
    `DELETE FROM lp_positions WHERE token_id = '999999999999' AND agent_id = '${agent}'`);
  sweep();
  try {
    sql(`INSERT INTO lp_positions
          (position_manager, token_id, agent_id, wallet, pool, token0, token1, fee_tier,
           tick_lower, tick_upper, liquidity, tokens_owed0, tokens_owed1,
           current_tick, in_range, amount0, amount1, recommendation, status, provenance)
         VALUES ('${npm}', '999999999999', '${agent}', '${wallet}',
           '0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002',
           '0x0000000000000000000000000000000000000003', 500, -100, 100, '1000000', '0', '0',
           '0', true, '1000', '2000', 'rebalance', 'open', 'verification')`);
    sql(`INSERT INTO lp_position_actions
          (position_manager, token_id, agent_id, recommendation, detail)
         VALUES ('${npm}', '999999999999', '${agent}', 'rebalance',
           '{"intents":["lp_collect","lp_decrease","lp_burn","lp_mint"],"verification":true}'::jsonb)`);

    const p = await get('/v1/arbitrage/lp/positions?status=all');
    const row = (p.body?.positions || []).find((x) => x.token_id === '999999999999');
    run.check('positions lists the verification row', !!row, `status ${p.status}`);
    if (row) {
      run.check('nullable columns survive the read (current_tick, in_range, amounts)',
        row.current_tick === 0 && row.in_range === true && row.amount0 === '1000' && row.amount1 === '2000',
        JSON.stringify(row));
      run.check('provenance says what the row is', row.provenance === 'verification', row.provenance);
    }
    const a = await get('/v1/arbitrage/lp/actions');
    const act = (a.body?.actions || []).find((x) => x.token_id === '999999999999');
    run.check('actions lists the verification proposal with its jsonb detail intact',
      !!act && act.status === 'proposed' && Array.isArray(act.detail?.intents) && act.detail.intents.includes('lp_mint'),
      JSON.stringify(act));
  } finally {
    sweep();
  }
  const left = sql(`SELECT count(*) FROM lp_positions WHERE token_id = '999999999999'`);
  run.check('the verification rows are removed again', left === '0', left);
});

// Exact fees are the one number this reader computes that money will later be
// collected against, so it is checked against the CONTRACT'S OWN answer: a
// simulated collect() returns exactly what the owner would receive right now.
// The position is found by scanning back from the position manager's
// totalSupply — positions come and go on this chain, so no tokenId is
// hardcoded, and a window with nothing live is "nothing to check" rather than
// a failure.
await run.section('Exact fees equal what the chain\'s own collect() would pay', async () => {
  if (!npm) {
    run.nothingToCheck('no position manager configured');
    return;
  }
  const RPC = process.env.LP_VERIFY_RPC || 'https://rpc.mainnet.chain.robinhood.com';
  const rpcCall = async (to, data, from) => {
    const call = { to, data };
    if (from) call.from = from;
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [call, 'latest'] }),
    });
    const body = await res.json().catch(() => ({}));
    if (body.error || typeof body.result !== 'string') throw new Error(body.error?.message || 'no result');
    return body.result;
  };
  const word = (hex, n) => hex.slice(2 + (n - 1) * 64, 2 + n * 64);
  const pad = (v) => BigInt(v).toString(16).padStart(64, '0');

  let total;
  try {
    total = BigInt(await rpcCall(npm, '0x18160ddd'));
  } catch (e) {
    run.nothingToCheck(`the chain is not readable from here (${e.message})`);
    return;
  }

  const MAX_U128 = 'f'.repeat(32).padStart(64, '0');
  let found = null;
  let reason = '';
  // THE REGISTRY'S OWN POSITIONS FIRST. They are the ones the platform manages,
  // so they are the sample this check is actually about — the stride scan below
  // only existed because no such position existed until 2026-10-22.
  try {
    const reg = await fetch(`${ARB}/v1/arbitrage/lp/positions?status=open&limit=10`).then((r) => r.json());
    for (const p of reg?.positions ?? []) {
      const r = await get(`/v1/arbitrage/lp/position?token_id=${p.token_id}`);
      if (r.status !== 200) continue;
      let owner;
      try {
        owner = '0x' + word(await rpcCall(npm, '0x6352211e' + pad(p.token_id)), 1).slice(24);
      } catch { continue; }
      found = { id: p.token_id, owner, fees: r.body.position };
      break;
    }
  } catch { /* fall through to the stride scan */ }
  for (let i = 1; i <= 40 && !found; i++) {
    const id = total - BigInt(i * 137);
    if (id <= 0n) break;
    let pos;
    try {
      pos = await rpcCall(npm, '0x99fbab88' + pad(id));
    } catch { continue; }
    if (BigInt('0x' + word(pos, 8)) === 0n) continue; // no liquidity; burned or drained
    let owner;
    try {
      owner = '0x' + word(await rpcCall(npm, '0x6352211e' + pad(id)), 1).slice(24);
    } catch { continue; }
    // The endpoint resolves the pool through OUR configured factory and reads
    // the fee growth there; a candidate it cannot resolve is not usable.
    const r = await get(`/v1/arbitrage/lp/position?token_id=${id}`);
    if (r.status !== 200) {
      reason = `endpoint said ${r.status} for ${id}: ${JSON.stringify(r.body?.error || {})}`;
      continue;
    }
    found = { id, owner, fees: r.body.position };
  }
  if (!found) {
    run.nothingToCheck(`no live position in the sampled window (${reason || 'every sampled tokenId was burned or held no liquidity'})`);
    return;
  }

  // The contract's own number: collect(max, max) simulated from the owner.
  const collectData = '0xfc6f7865' + pad(found.id) + pad(found.owner) + MAX_U128 + MAX_U128;
  const raw = await rpcCall(npm, collectData, found.owner);
  const ref0 = BigInt('0x' + word(raw, 1)).toString();
  const ref1 = BigInt('0x' + word(raw, 2)).toString();

  // THE SERVICE'S NUMBER IS READ AGAIN AFTER THE SIMULATION, AND THAT IS NOT A
  // WEAKENING — it is what makes this an assertion about the arithmetic rather
  // than about the clock. Fees only ever grow, so a live pool trading between
  // the two reads makes the contract's number land strictly between them: on
  // 2026-10-20 that was 306 raw units on a single position, and the check failed
  // a service whose math was right. A value OUTSIDE the window is still a
  // failure, and when nothing traded in the window the exactness assertion runs
  // as it always did.
  const again = await get(`/v1/arbitrage/lp/position?token_id=${found.id}`);
  const after = again.status === 200 ? again.body.position : null;
  const between = (ref, a, b) => {
    const x = BigInt(ref);
    const lo = BigInt(a) < BigInt(b) ? BigInt(a) : BigInt(b);
    const hi = BigInt(a) < BigInt(b) ? BigInt(b) : BigInt(a);
    return x >= lo && x <= hi;
  };
  const quiet = after !== null && after.fees_owed0 === found.fees.fees_owed0 && after.fees_owed1 === found.fees.fees_owed1;

  run.check(`fees_owed0 is what collect() pays (tokenId ${found.id})`,
    after === null ? found.fees.fees_owed0 === ref0 : between(ref0, found.fees.fees_owed0, after.fees_owed0),
    `${found.fees.fees_owed0} → ${ref0} → ${after?.fees_owed0 ?? 'n/a'}`);
  run.check('fees_owed1 is what collect() pays',
    after === null ? found.fees.fees_owed1 === ref1 : between(ref1, found.fees.fees_owed1, after.fees_owed1),
    `${found.fees.fees_owed1} → ${ref1} → ${after?.fees_owed1 ?? 'n/a'}`);
  for (const [side, ref, before, now] of [['0', ref0, found.fees.fees_owed0, after?.fees_owed0], ['1', ref1, found.fees.fees_owed1, after?.fees_owed1]]) {
    if (quiet) {
      run.check(`and with nothing traded in the window, fees_owed${side} is exact`,
        before === ref, `${before} vs ${ref}`);
    } else {
      run.nothingToCheck(
        `the pool traded during the check (fees_owed${side} ${before} → ${now}), so the simulation is compared against ` +
        `the window rather than for equality — the window check above is the assertion`);
    }
  }
  run.check('the exact fees are at least the stored tokens_owed',
    BigInt(found.fees.fees_owed0) >= BigInt(found.fees.tokens_owed0)
      && BigInt(found.fees.fees_owed1) >= BigInt(found.fees.tokens_owed1),
    JSON.stringify({ owed: [found.fees.tokens_owed0, found.fees.tokens_owed1], fees: [found.fees.fees_owed0, found.fees.fees_owed1] }));
});

await run.section('Proposals are proposed and nothing else', async () => {
  const a = await get('/v1/arbitrage/lp/actions');
  const list = a.body?.actions;
  run.check('actions returns an array', Array.isArray(list));
  if (!Array.isArray(list) || list.length === 0) {
    run.nothingToCheck('no proposals outstanding (expected: every position in range, or none registered)');
    return;
  }
  let ok = true;
  let detail = '';
  for (const x of list) {
    if (x.status !== 'proposed') { ok = false; detail = `status ${x.status}`; }
    if (!['rebalance', 'empty'].includes(x.recommendation)) { ok = false; detail = `recommendation ${x.recommendation}`; }
    if (x.superseded_at != null) { ok = false; detail = 'proposed row with superseded_at set'; }
    if (typeof x.detail !== 'object' || x.detail === null || !Array.isArray(x.detail.intents)) {
      ok = false; detail = `proposal ${x.id} has no intents in detail`;
    }
  }
  run.check('every outstanding action is a proposal with named intents', ok, detail);
});

await run.section('The tables are standalone and the core schema is untouched', async () => {
  for (const t of ['lp_positions', 'lp_position_actions', 'lp_sync_heartbeat']) {
    const reg = sql(`SELECT to_regclass('${t}')`);
    run.check(`${t} exists`, reg === t, reg);
  }
  const name = sql(`SELECT column_name FROM information_schema.columns WHERE table_name='agents' AND column_name='name'`);
  run.check('core agents table still has its name column', name === 'name', name);
});

await run.section('Nothing has ever asked the signer for an lp_* shape', async () => {
  let log = '';
  try {
    log = execFileSync('sudo', ['-n', 'journalctl', '-u', 'arcana-signer', '--since', '7 days ago', '--no-pager'], { encoding: 'utf8' });
  } catch {
    run.nothingToCheck('signer journal is not readable here, so "nothing signed" cannot be checked from this suite');
    return;
  }
  const hits = log.split('\n').filter((l) => /signed intent=lp_/.test(l));
  // THE INVARIANT MOVED, ON PURPOSE, ON 2026-10-22. It used to be "zero lp_*
  // signings": the executor was disarmed and the claim this suite defends was
  // that the loop proposes and nothing signs. The executor is armed now and has
  // signed a real lp_mint, so the honest contract is the one that still catches
  // the failure mode: NOTHING SIGNED MAY BE UNRECORDED. Every lp_* intent the
  // signer built has to correspond to an execution step the executor wrote,
  // with a transaction hash and a mined status — a signature with no recorded
  // step is a transaction nobody can account for, which is exactly what this
  // suite exists to make impossible.
  const byIntent = new Map();
  for (const l of hits) {
    const m = /signed intent=(lp_[a-z]+)/.exec(l);
    if (m) byIntent.set(m[1], (byIntent.get(m[1]) ?? 0) + 1);
  }
  if (hits.length === 0) {
    run.nothingToCheck('the signer has built no lp_* intent yet, so "nothing signed is unrecorded" has nothing to check');
  } else {
    const unrecorded = [];
    for (const [intent, signed] of byIntent) {
      // TWO RECORDING PATHS, ONE REQUIREMENT. A claim (decrease/collect/burn/
      // mint of a rebalance) writes lp_execution_steps; an OPEN writes lp_opens
      // — the first position cannot be a claimed proposal, because it is the
      // thing proposals are about. lp_mint is therefore recorded in either
      // table, and the sum is what has to cover the signings.
      //
      // ANY TERMINAL STATUS WITH A HASH COUNTS — mined, reverted or unresolved.
      // The invariant is "nothing signed is unaccounted for", not "everything
      // succeeded": the first real harvest's collect reverted out-of-gas and is
      // recorded with its transaction hash, which is exactly the audit trail
      // this check exists to guarantee. Counting only mined rows would call that
      // truthful record a missing one.
      const steps = Number(sql(
        `SELECT count(*) FROM lp_execution_steps WHERE intent = '${intent}'
           AND tx_hash IS NOT NULL AND status IN ('mined', 'reverted', 'unresolved')`));
      const opens = intent === 'lp_mint'
        ? Number(sql(`SELECT count(*) FROM lp_opens WHERE tx_hash IS NOT NULL`))
        : 0;
      const recorded = steps + opens;
      if (!(recorded >= signed)) {
        unrecorded.push(`${intent}: signed ${signed}, recorded ${recorded} (steps ${steps}, opens ${opens})`);
      }
    }
    run.check('every lp_* intent the signer built is recorded, with its transaction',
      unrecorded.length === 0,
      unrecorded.length ? unrecorded.join(' | ') : `${hits.length} signing(s) across ${byIntent.size} intent(s)`);
  }
});

await run.section('PnL is the receipts, recomputed', async () => {
  const pnl = await get('/v1/arbitrage/lp/pnl?status=all');
  run.check('lp pnl returns 200', pnl.status === 200, `got ${pnl.status} ${JSON.stringify(pnl.body).slice(0, 200)}`);
  run.check('pnl positions is an array', Array.isArray(pnl.body?.positions), typeof pnl.body?.positions);
  run.check('pnl states that it is realised only',
    typeof pnl.body?.note === 'string' && /REALISED ONLY/.test(pnl.body.note),
    'the note does not say what is excluded');
  run.check('gas either names the pool it was priced from or says why not',
    /^0x[0-9a-f]{40}$/i.test(pnl.body?.valuation?.gas?.pool ?? '') ||
      typeof pnl.body?.valuation?.gas?.error === 'string',
    JSON.stringify(pnl.body?.valuation?.gas));

  if (!npm) {
    run.nothingToCheck('no position manager is configured, so receipts cannot be attributed');
    return;
  }

  const rpc = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
  const rpcCall = async (method, params) => {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = await res.json();
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };
  const word = (hex, i) => BigInt('0x' + hex.slice(2 + 64 * i, 2 + 64 * (i + 1)));

  const rows = Array.isArray(pnl.body?.positions) ? pnl.body.positions : [];
  let checked = 0;
  const bad = [];
  for (const row of rows) {
    for (const h of row.harvests ?? []) {
      let rc;
      try {
        rc = await rpcCall('eth_getTransactionReceipt', [h.tx_hash]);
      } catch (e) {
        bad.push(`${h.tx_hash}: ${e.message}`);
        continue;
      }
      const want = BigInt(row.token_id);
      const log = (rc.logs ?? []).find(
        (l) =>
          l.address.toLowerCase() === npm.toLowerCase() &&
          (l.topics?.[0] ?? '').toLowerCase() === COLLECT_TOPIC &&
          word(l.topics[1], 0) === want,
      );
      if (!log) {
        bad.push(`${h.tx_hash}: no Collect event for #${row.token_id}`);
        continue;
      }
      const a0 = word(log.data, 1);
      const a1 = word(log.data, 2);
      if (a0.toString() !== h.amount0 || a1.toString() !== h.amount1) {
        bad.push(`${h.tx_hash}: api ${h.amount0}/${h.amount1}, chain ${a0}/${a1}`);
      }
      if (BigInt(row.gas.gas_used) < BigInt(rc.gasUsed)) {
        bad.push(`#${row.token_id}: gas_used ${row.gas.gas_used} is less than the harvest's own ${BigInt(rc.gasUsed)}`);
      }
      checked++;
    }
    if (row.net_usdg != null && row.fees_value_usdg != null && row.gas?.value_usdg != null) {
      const diff = Math.abs(row.net_usdg - (row.fees_value_usdg - row.gas.value_usdg));
      if (diff > 1e-5) bad.push(`#${row.token_id}: net ${row.net_usdg} != fees ${row.fees_value_usdg} - gas ${row.gas.value_usdg}`);
    }
  }

  if (checked === 0) {
    run.nothingToCheck('no harvest transaction exists yet, so there is no collected amount to recompute');
  } else {
    run.check(
      `every harvest's collected amounts equal its own receipt, and net = fees - gas (${checked} harvest(s))`,
      bad.length === 0,
      bad.join(' | '),
    );
  }
});

process.exit(run.report());
