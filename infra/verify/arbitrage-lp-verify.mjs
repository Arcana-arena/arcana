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
  run.check('zero lp_* signings in the signer journal', hits.length === 0, hits.slice(0, 3).join(' | '));
});

process.exit(run.report());
