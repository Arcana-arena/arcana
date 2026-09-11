/**
 * cost-meter-verify.mjs — prove the inference meter can actually pause an agent.
 *
 * WHY THIS SUITE EXISTS AT ALL. There was a comment in the decision engine
 * reading "Usage, for the cost meter", and token counts parsed from every
 * provider response. There was no cost meter: no table, no threshold, nothing
 * that could pause anything. The numbers were read and dropped. Everyone
 * downstream — including a later instruction to rely on it — believed it was
 * there, which is what a comment describing an intention costs.
 *
 * The meter is now real, and this is what makes that a claim rather than a
 * second comment. It is proved by EXHAUSTING A BUDGET and watching an agent
 * stand down, not by reading the branch.
 *
 * It matters more than it used to. The four-hour cadence floor was bounding two
 * different things by accident: trading fees, which it was designed for, and
 * inference spend, which nobody noticed. The floor is gone, so this is the only
 * thing standing between one agent and 1,440 model calls a day.
 *
 * Each case spawns its OWN engine on its own port with its own budget, because
 * the budget is read at boot. Nothing here touches the running production
 * engine, and no agent here has a wallet, so no gas is spent.
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { req, signInToken, bearer, ok2xx } from './lib/rate-aware.mjs';

const REPO = process.env.REPO || '/home/ubuntu/arcana';
const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const PORT = Number(process.env.TEST_METER_PORT || 8092);
const GO = process.env.GO_BIN || '/usr/local/go/bin/go';
const PG = process.env.PG_CONTAINER || 'arcana-postgres';
const DB = process.env.DATABASE_URL || 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';
const SEASON = process.env.SEASON_ID || '00000002-0000-4000-8000-000000000002';

const env = Object.fromEntries(
  readFileSync(`${REPO}/.env.auth`, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const KEY = env.INTERNAL_API_KEY;
const llmEnv = Object.fromEntries(
  execFileSync('sudo', ['cat', '/home/ubuntu/arcana/.env.llm'], { encoding: 'utf8' })
    .split('\n').filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

let pass = 0, fail = 0;
const failures = [];
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; failures.push(`${n} — ${d}`); console.log(`  FAIL  ${n} — ${d}`); }
};
const psql = (s) => execFileSync('docker', ['exec', PG, 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc', s], { encoding: 'utf8' }).trim();

let proc = null;
function start(budget) {
  return spawn(GO, ['run', './cmd/server'], {
    cwd: `${REPO}/services/decision-engine`,
    env: {
      ...process.env, ...llmEnv,
      DATABASE_URL: DB, PORT: String(PORT),
      MARKET_DATA_URL: 'http://127.0.0.1:8083', INTERNAL_API_KEY: KEY,
      INFERENCE_TOKENS_PER_AGENT_PER_DAY: String(budget),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
async function stop() {
  if (!proc) return;
  proc.kill('SIGKILL');
  try { execFileSync('bash', ['-lc', `fuser -k ${PORT}/tcp 2>/dev/null || true`]); } catch {}
  proc = null;
  await new Promise((r) => setTimeout(r, 1200));
}
async function up(ms = 40000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
async function cycle(agentId, ref) {
  const r = await fetch(`http://127.0.0.1:${PORT}/internal/v1/decisions/execute`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Key': KEY, 'X-Arcana-Verification': '1' },
    body: JSON.stringify({ agent_id: agentId, season_id: SEASON, market_snapshot_ref: ref }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const row = (id) => {
  const r = psql(`SELECT coalesce(action,'') || '|' || coalesce(reason_code,'') || '|' || coalesce(prompt_tokens::text,'NULL') || '|' || coalesce(completion_tokens::text,'NULL') || '|' || coalesce(response_hash,'NULL') FROM decisions WHERE id = ${id}`);
  const [action, reason, prompt, completion, response] = r.split('|');
  return { action, reason, prompt, completion, response };
};

const made = [];
const handles = [];
async function agentWithTightBand(label) {
  const acct = privateKeyToAccount(generatePrivateKey());
  const tk = await signInToken(AGENT, acct, { chainId: 4663, domain: 'arcana.local', uri: 'https://arcana.local' });
  const h = `meter_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const c = await req(`${AGENT}/v1/creators`, { method: 'POST', headers: bearer(tk), body: JSON.stringify({ handle: h }) });
  if (!ok2xx(c.status)) throw new Error('creator: ' + JSON.stringify(c.body));
  handles.push(h);
  const a = await req(`${AGENT}/v1/agents`, {
    method: 'POST', headers: bearer(tk),
    body: JSON.stringify({
      name: `meter ${label} ${Date.now().toString(36)}`,
      assetUniverse: 'stock_tokens',
      mandate: 'Trade on any clear move. Explain briefly.',
      // A tiny band so the model is genuinely consulted; otherwise the tick is
      // short-circuited before a single token is bought and the meter would be
      // measuring nothing.
      riskProfile: JSON.stringify({ rebalance_band_pct: 0.00001, trade_size_pct: 0.2, max_position_pct: 0.5, cash_floor_pct: 0.05 }),
    }),
  });
  if (!ok2xx(a.status)) throw new Error('agent: ' + JSON.stringify(a.body));
  made.push(a.body.id);
  const act = await req(`${AGENT}/v1/agents/${a.body.id}/activate`, { method: 'POST', headers: bearer(tk) });
  if (!ok2xx(act.status)) throw new Error('activate: ' + JSON.stringify(act.body));
  return a.body.id;
}

try {
  const ref = psql('SELECT ref FROM market_snapshots ORDER BY tick_time DESC LIMIT 1');
  console.log(`  snapshot: ${ref}\n`);

  // === 1. THE METER MEASURES ==============================================
  console.log('=== 1. a decision records what it cost ===');
  const a1 = await agentWithTightBand('measure');
  proc = start(200000);
  check('an engine with a budget came up', await up(), 'never became healthy');
  {
    const r = await cycle(a1, ref);
    check('the cycle ran', ok2xx(r.status) && !!r.body?.decision_id, `${r.status}`);
    const d = row(r.body.decision_id);
    check('prompt tokens were recorded, not dropped', d.prompt !== 'NULL' && Number(d.prompt) > 0, `prompt_tokens=${d.prompt}`);
    check('completion tokens too', d.completion !== 'NULL' && Number(d.completion) > 0, `completion_tokens=${d.completion}`);
    console.log(`      cost: ${d.prompt} prompt + ${d.completion} completion tokens`);
    const used = psql(`SELECT coalesce(sum(coalesce(prompt_tokens,0)+coalesce(completion_tokens,0)),0) FROM decisions WHERE agent_id = '${a1}'`);
    check('and the day\'s total is readable, which is what the meter reads', Number(used) > 0, `sum=${used}`);
  }

  // === 2. AN EXHAUSTED BUDGET STANDS THE AGENT DOWN =======================
  //
  // THE CHECK THAT MATTERS. The agent above has now spent real tokens, so an
  // engine booted with a budget of 1 must refuse it before calling anybody.
  console.log('\n=== 2. an exhausted budget pauses the agent ===');
  await stop();
  proc = start(1);
  check('an engine with a 1-token budget came up', await up(), 'never became healthy');
  {
    const r = await cycle(a1, ref);
    check('the tick still HAPPENED', ok2xx(r.status) && !!r.body?.decision_id, `${r.status}`);
    const d = row(r.body.decision_id);
    check('it stood down rather than spending', d.reason === 'inference_budget_exhausted', `reason=${d.reason}`);
    check('and did so as a recorded HOLD, not an error', d.action === 'hold', `action=${d.action}`);
    check('no model was called, so no answer was stored', d.response === 'NULL', `response_hash=${d.response}`);
    check('and nothing was charged for the refusal', d.prompt === 'NULL', `prompt_tokens=${d.prompt}`);
    console.log(`      recorded: action=${d.action} reason=${d.reason}`);
  }

  // === 3. IT IS PER AGENT, NOT PER PLATFORM ===============================
  //
  // One exhausted agent must not silence the others, or a single runaway would
  // take the whole field down with it.
  console.log('\n=== 3. the pause is per agent ===');
  const a2 = await agentWithTightBand('neighbour');
  {
    const r = await cycle(a2, ref);
    check('a fresh agent still decides under the same 1-token budget',
      ok2xx(r.status) && !!r.body?.decision_id, `${r.status}`);
    const d = row(r.body.decision_id);
    check('and it was NOT stood down', d.reason !== 'inference_budget_exhausted', `reason=${d.reason}`);
    console.log(`      recorded: action=${d.action} reason=${d.reason || '-'} tokens=${d.prompt}`);
  }

  // === 4. ZERO MEANS UNMETERED, AND SAYS SO ===============================
  console.log('\n=== 4. an unset budget is unmetered, loudly ===');
  await stop();
  proc = start(0);
  check('an engine with no budget came up', await up(), 'never became healthy');
  {
    let out = '';
    proc.stdout.on('data', (c) => (out += c));
    proc.stderr.on('data', (c) => (out += c));
    const r = await cycle(a1, ref);
    check('the exhausted agent decides again when nothing is metering it',
      ok2xx(r.status) && row(r.body.decision_id).reason !== 'inference_budget_exhausted',
      row(r.body?.decision_id ?? 0).reason);
    await new Promise((s) => setTimeout(s, 300));
    check('and the log warns rather than staying silent about it',
      /inference meter INACTIVE/.test(out), out.slice(-200) || '(no output captured)');
  }

  console.log('\n========================================');
  console.log(`  PASS: ${pass}   FAIL: ${fail}`);
  console.log('========================================');
  if (fail > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    console.log('\nThe cadence floor must NOT be lifted while this fails.');
    process.exit(1);
  }
  console.log('cost-meter-verify: the meter measures, and it pauses. It has been exhausted on purpose.');
} finally {
  await stop();
  for (const id of made) {
    try { psql(`DELETE FROM decisions WHERE agent_id = '${id}'`); } catch {}
    try { psql(`DELETE FROM portfolio_snapshots WHERE portfolio_id IN (SELECT id FROM portfolios WHERE agent_id = '${id}')`); } catch {}
    try { psql(`DELETE FROM portfolios WHERE agent_id = '${id}'`); } catch {}
    try { psql(`DELETE FROM agents WHERE id = '${id}'`); } catch {}
  }
  for (const h of handles) { try { psql(`DELETE FROM creators WHERE handle = '${h}'`); } catch {} }
  console.log('cost-meter-verify: fixtures removed');
}
