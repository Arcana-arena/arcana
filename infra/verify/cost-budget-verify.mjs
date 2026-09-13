/**
 * cost-budget-verify.mjs — prove the transaction cost meter pauses, prove it
 * holds back when it should not, and prove the numbers in its refusal are the
 * right numbers rather than merely present.
 *
 * docs/on-chain-direction.md promised this meter from the beginning:
 * AGENT_COST_BUDGET_MONTHLY_PCT, a cost_budget_exceeded reason, an agent paused
 * when gas and fees cross a share of its capital. None of it existed. The only
 * thing that had ever stopped a runaway was the ETH balance running out, which
 * is a brake by coincidence, and a brake that works by coincidence is not one.
 *
 * WHAT MAKES THIS DIFFERENT FROM READING THE BRANCHES. Every case drives the
 * meter past a real threshold with real rows and watches what the engine
 * records. Three cases drive it ALMOST past and check that it says nothing —
 * those matter as much as the ones that fire, because a meter that paused on a
 * twenty-minute sample would be a coin toss for every new agent, and the first
 * person it stopped unfairly would ask for it to be switched off.
 *
 * THE REFUSAL'S ARITHMETIC IS RECOMPUTED HERE. The sustained case does not look
 * for the string "$7500". It pulls every figure out of the rationale and checks
 * that they agree with each other and with a number this file works out
 * independently. A refusal that quotes a capital figure nobody checked is a
 * refusal that can quote the wrong one for a year.
 *
 * ONE FRESH AGENT PER CASE, and that is not tidiness.
 *
 * The first version of this suite reused one agent and produced different
 * results between runs. The cause took three wrong guesses to find: EVERY CYCLE
 * WRITES A NEW SNAPSHOT and NAV is recomputed from cash and holdings on the way
 * out, so capital pinned before one case was silently restored by the next —
 * including by positions the agent had bought virtually in between. The meter
 * was reading exactly what it found each time. The suite was the unstable part.
 * A fresh agent removes the shared state instead of trying to reset it, which
 * is the difference between a test that is correct and one that is correct today.
 *
 * THE ROWS ARE SYNTHETIC AND SAY SO. Cost history cannot be accumulated inside
 * a test run — the SUSTAINED rule deliberately needs a day of it — so
 * executions are inserted with backdated timestamps, each carrying a note naming
 * this file, and deleted in `finally`. No agent here has a wallet, so nothing
 * it does can spend gas.
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { req, signInToken, bearer, ok2xx } from './lib/rate-aware.mjs';

const REPO = process.env.REPO || '/home/ubuntu/arcana';
const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const PORT = Number(process.env.TEST_COST_PORT || 8093);
const GO = process.env.GO_BIN || '/usr/local/go/bin/go';
const PG = process.env.PG_CONTAINER || 'arcana-postgres';
const DB = process.env.DATABASE_URL || 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';
const SEASON = process.env.SEASON_ID || '00000002-0000-4000-8000-000000000002';
const BUDGET_PCT = 2.0;
const CAPITAL = 100.0;                               // pinned so the arithmetic is legible
const MONTHLY_BUDGET = CAPITAL * BUDGET_PCT / 100;   // $2.00

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
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const psql = (s) => execFileSync('docker', ['exec', PG, 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc', s], { encoding: 'utf8' }).trim();

const MARK = 'cost-budget-verify synthetic row';
let engineLog = '';
let proc = null;
let exitCode = 0;

// THE ENGINE IS BUILT, NOT `go run`.
//
// `go run` is a parent that compiles and then execs the server as a CHILD. A
// SIGKILL to the parent leaves the child holding the port. Combined with the
// bug below that was enough to make this suite lie: a previous failing run left
// an orphan on 8093, the next run's health check found THAT engine and called
// it up, and every case afterwards was measured against a server configured by
// a run that had already ended. Eleven checks failed for a reason that had
// nothing to do with the meter.
//
// Building once and spawning the binary directly means the process we kill is
// the process that listens.
const BIN = `/tmp/cost-budget-verify-engine.${process.pid}`;

function build() {
  execFileSync(GO, ['build', '-o', BIN, './cmd/server'], {
    cwd: `${REPO}/services/decision-engine`, stdio: 'inherit',
  });
}

// A STRANGER ON THE PORT IS A FAILED RUN, NOT A PASSING ONE. If anything is
// already listening, this suite would otherwise verify that other process --
// the same shape of mistake as proving a watcher alive with a pgrep that
// matched the checking command itself.
async function assertPortFree() {
  try { execFileSync('bash', ['-lc', `fuser -k ${PORT}/tcp 2>/dev/null || true`]); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    if (r.ok) throw new Error(
      `something is already listening on ${PORT} and answering /healthz. This suite would have ` +
      `measured that process instead of the one it configures. Refusing to run.`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('something is already listening')) throw e;
    // Connection refused is the outcome we want.
  }
}

// THE ENGINE NO LONGER TAKES A BUDGET. The meter is per agent, from its own
// risk_profile, so there is nothing to configure here — which is itself part of
// what this suite checks: there must be no lever that hands a cost brake to an
// agent whose owner did not ask for one.
function start() {
  const pr = spawn(BIN, [], {
    cwd: `${REPO}/services/decision-engine`,
    env: {
      ...process.env, ...llmEnv,
      DATABASE_URL: DB, PORT: String(PORT),
      MARKET_DATA_URL: 'http://127.0.0.1:8083', INTERNAL_API_KEY: KEY,
      // The token meter must not interfere: this suite is about the other one.
      INFERENCE_TOKENS_PER_AGENT_PER_DAY: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pr.stdout.on('data', (c) => (engineLog += c));
  pr.stderr.on('data', (c) => (engineLog += c));
  return pr;
}
async function stop() {
  if (!proc) return;
  proc.kill('SIGKILL');
  try { execFileSync('bash', ['-lc', `fuser -k ${PORT}/tcp 2>/dev/null || true`]); } catch {}
  proc = null;
  await new Promise((r) => setTimeout(r, 1200));
}
async function up(ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // A DEAD CHILD IS NOT A SLOW ONE. Without this the loop would keep polling
    // until something else answered, which is exactly how the orphan above got
    // mistaken for the engine under test.
    if (proc && proc.exitCode !== null) {
      console.log(`  engine exited with code ${proc.exitCode}:\n${engineLog.slice(-600)}`);
      return false;
    }
    try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
/**
 * One tick, with the engine's own words kept when it refuses.
 *
 * THE BODY IS NOT DISCARDED, and that is why this comment is here. A failing
 * sweep reported `the tick still HAPPENED — 422` six times and the suite had
 * thrown away the only sentence that said what went wrong — the same defect
 * this repository keeps removing from its instruments, one layer down. The
 * engine answers 422 for every reason Execute can fail, from an unreadable
 * snapshot to a context deadline, and those need completely different fixes.
 *
 * `ms` is recorded too. A 422 that arrives after fifteen seconds is a timeout
 * wearing the same status code as a 422 that arrives instantly, and the
 * difference is the whole diagnosis.
 */
async function cycle(agentId, ref) {
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${PORT}/internal/v1/decisions/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'X-Internal-Key': KEY,
      // The engine refuses to act on an agent that holds a wallet when this is
      // set. This suite's agents have none, and that is not the protection —
      // this header is.
      'X-Arcana-Verification': '1',
    },
    body: JSON.stringify({ agent_id: agentId, season_id: SEASON, market_snapshot_ref: ref }),
  });
  const body = await r.json().catch(() => null);
  const ms = Date.now() - t0;
  if (!ok2xx(r.status)) {
    const why = body?.error?.message ?? body?.message ?? JSON.stringify(body);
    console.log(`      engine refused a tick after ${ms}ms: ${r.status} ${why}`);
  }
  return { status: r.status, body, ms, why: body?.error?.message ?? body?.message ?? null };
}
const decision = (id) => {
  if (id === undefined || id === null) return { action: '', reason: '(no decision row)', rationale: '' };
  const r = psql(`SELECT coalesce(action,'') || '|' || coalesce(reason_code,'') || '|' || coalesce(rationale,'') FROM decisions WHERE id = ${id}`);
  const i = r.indexOf('|'), j = r.indexOf('|', i + 1);
  return { action: r.slice(0, i), reason: r.slice(i + 1, j), rationale: r.slice(j + 1) };
};

// One synthetic execution: a cost, at a time, with a note that says what it is.
const insertCost = (agentId, usd, hoursAgo, { unpriced = false } = {}) => psql(
  `INSERT INTO executions
     (agent_id, ts, intent_action, symbol, token_in, token_out, amount_in,
      status, gas_used, gas_cost_wei, gas_cost_usd, note)
   VALUES ('${agentId}', now() - interval '${hoursAgo} hours', 'buy', 'AAPL',
      '0x0', '0x0', 1, 'mined', 150000, 18000000000000,
      ${unpriced ? 'NULL' : usd}, '${MARK}')`);

const made = [];
const handles = [];

/**
 * A fresh agent whose snapshot exists and whose capital is pinned at $100.
 *
 * The cycle in here is what CREATES the snapshot CapitalOf reads. Without it the
 * meter permits, correctly: an agent that has never been marked to market has no
 * capital to measure anything against.
 */
async function freshCase(label, ref, opts = {}) {
  const acct = privateKeyToAccount(generatePrivateKey());
  const tk = await signInToken(AGENT, acct);
  const h = `cost_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const c = await req(`${AGENT}/v1/creators`, { method: 'POST', headers: bearer(tk), body: JSON.stringify({ handle: h }) });
  if (!ok2xx(c.status)) throw new Error('creator: ' + JSON.stringify(c.body));
  handles.push(h);
  const a = await req(`${AGENT}/v1/agents`, {
    method: 'POST', headers: bearer(tk),
    body: JSON.stringify({
      name: `cost ${label} ${Date.now().toString(36)}`,
      assetUniverse: 'stock_tokens',
      mandate: 'Trade on any clear move.',
      // THE OWNER TURNS THE METER ON. Nothing else can: an agent created
      // without this line has no cost brake, which is the default and is
      // checked by the last case in this file.
      riskProfile: JSON.stringify(opts.noBudget
        ? { rebalance_band_pct: 0.00001 }
        : { rebalance_band_pct: 0.00001, cost_budget_monthly_pct: BUDGET_PCT }),
    }),
  });
  if (!ok2xx(a.status)) throw new Error('agent: ' + JSON.stringify(a.body));
  const id = a.body.id;
  made.push(id);
  const act = await req(`${AGENT}/v1/agents/${id}/activate`, { method: 'POST', headers: bearer(tk) });
  if (!ok2xx(act.status)) throw new Error('activate: ' + JSON.stringify(act.body));

  // THE FIRST TICK IS WHAT PINS THE CAPITAL, and its result used to be thrown
  // away. If it fails, the UPDATE below touches nothing, the agent has no
  // snapshot, and every case built on it reports a meter that did not fire —
  // which reads as a defect in the meter rather than a fixture that was never
  // built. A setup step that can fail silently is a setup step that will.
  const first = await cycle(id, ref);
  if (!ok2xx(first.status)) {
    throw new Error(
      `the first tick for ${label} failed (${first.status} after ${first.ms}ms: ${first.why ?? 'no message'}), ` +
      'so its capital was never pinned and nothing built on it would mean anything',
    );
  }
  const pinned = psql(`UPDATE portfolio_snapshots SET nav = ${CAPITAL}, cash = ${CAPITAL}, holdings = '{}'::jsonb
         WHERE portfolio_id IN (SELECT id FROM portfolios WHERE agent_id = '${id}')
         RETURNING 1`);
  if (!pinned) {
    throw new Error(`no portfolio snapshot exists for ${label} after its first tick, so capital could not be pinned`);
  }
  return id;
}

try {
  const ref = psql('SELECT ref FROM market_snapshots ORDER BY tick_time DESC LIMIT 1');
  console.log(`  snapshot: ${ref}`);
  console.log(`  budget: ${BUDGET_PCT}% of $${CAPITAL} capital = $${MONTHLY_BUDGET.toFixed(2)} a month\n`);

  await assertPortFree();
  build();
  proc = start();
  check('the engine came up', await up(), 'never became healthy');
  check('and it says the meter belongs to each agent',
    /per agent, from risk_profile.cost_budget_monthly_pct/.test(engineLog), engineLog.slice(-240));
  check('with no platform-wide budget anywhere in its boot',
    !/AGENT_COST_BUDGET_MONTHLY_PCT/.test(engineLog), 'the removed lever is still being read');

  // === NO HISTORY: PERMIT =================================================
  console.log('\n=== An agent that has spent nothing is not paused ===');
  {
    const id = await freshCase('virgin', ref);
    const r = await cycle(id, ref);
    const d = decision(r.body?.decision_id);
    check('it decides normally', d.reason !== 'cost_budget_exceeded', `reason=${d.reason}`);
  }

  // === RUNAWAY ============================================================
  console.log('\n=== RUNAWAY: a month of budget inside a day ===');
  {
    const id = await freshCase('runaway', ref);
    insertCost(id, 5.00, 2);              // $5 today against a $2 monthly budget
    const r = await cycle(id, ref);
    const d = decision(r.body?.decision_id);
    check('the tick still HAPPENED', ok2xx(r.status) && !!r.body?.decision_id, `${r.status}`);
    check('the agent was paused', d.reason === 'cost_budget_exceeded', `reason=${d.reason} action=${d.action}`);
    check('as a recorded hold, not an error', d.action === 'hold', `action=${d.action}`);
    check('and it needed no history to say so', /24h/.test(d.rationale), d.rationale.slice(0, 140));

    const m = /spent \$([\d.]+) in the last 24h against a monthly budget of \$([\d.]+) \(([\d.]+)% of \$([\d.]+) capital\)/.exec(d.rationale);
    check('the refusal states spend, budget, rate and capital', !!m, d.rationale.slice(0, 200));
    if (m) {
      const spent = Number(m[1]), budget = Number(m[2]), pct = Number(m[3]), capital = Number(m[4]);
      check('the spend it quotes is the spend that was inserted', near(spent, 5.0, 0.0001), `${spent}`);
      check('the capital it quotes is the capital on the snapshot', near(capital, CAPITAL, 0.01), `${capital}`);
      check('and the budget is that capital times that rate, recomputed here',
        near(budget, capital * pct / 100, 0.0001), `${budget} vs ${capital * pct / 100}`);
    }
    console.log(`      ${d.rationale.slice(0, 160)}`);
  }

  // === UNDER THE SAMPLE, IT HOLDS BACK ====================================
  //
  // The cases that stop this meter being a coin toss. Both put the projected
  // rate far over budget and both must stay silent, because projecting a month
  // from a sample this thin is what the design refuses to do.
  console.log('\n=== It refuses to project from too little ===');
  {
    const id = await freshCase('twoexec', ref);
    insertCost(id, 4.50, 48);
    insertCost(id, 5.50, 36);             // $10 over two days: enormous rate, two samples
    const r = await cycle(id, ref);
    const d = decision(r.body?.decision_id);
    check('two executions do not trigger the sustained rule',
      d.reason !== 'cost_budget_exceeded', `reason=${d.reason} — ${d.rationale.slice(0, 120)}`);
  }
  {
    const id = await freshCase('shortspan', ref);
    insertCost(id, 0.50, 2);
    insertCost(id, 0.50, 1.5);
    insertCost(id, 0.50, 1);              // three samples, two hours, $1.50 < $2 budget
    const r = await cycle(id, ref);
    const d = decision(r.body?.decision_id);
    check('three executions inside two hours do not either',
      d.reason !== 'cost_budget_exceeded', `reason=${d.reason} — ${d.rationale.slice(0, 120)}`);
    check('and $1.50 in a day stays under the $2.00 monthly budget, so runaway is quiet too',
      d.reason !== 'cost_budget_exceeded', `reason=${d.reason}`);
  }

  // === SUSTAINED ==========================================================
  console.log('\n=== SUSTAINED: a real sample, projected over budget ===');
  {
    const id = await freshCase('sustained', ref);
    // Three executions spanning 48 hours, ALL older than a day, so the runaway
    // rule sees nothing in its window and the sustained rule has to be the one
    // that fires. $10 over 2 days projects to $150 a month; against a 2% budget
    // that is a book of $7,500.
    insertCost(id, 4.50, 48);
    insertCost(id, 4.50, 36);
    insertCost(id, 1.00, 30);
    const r = await cycle(id, ref);
    const d = decision(r.body?.decision_id);
    check('the agent was paused', d.reason === 'cost_budget_exceeded', `reason=${d.reason} action=${d.action}`);
    check('by the sustained rule, not the runaway one', /projects to/.test(d.rationale), d.rationale.slice(0, 160));

    const m = /\$([\d.]+) of gas and pool fees over ([\d.]+) days projects to \$([\d.]+) a month, which is ([\d.]+)% of \$([\d.]+) capital against a budget of ([\d.]+)%/.exec(d.rationale);
    const n = /needs about \$(\d+) of capital/.exec(d.rationale);
    check('the refusal states the sample it projected from', !!m, d.rationale.slice(0, 260));
    check('and names the capital that would fit', !!n, d.rationale.slice(0, 260));
    if (m && n) {
      const spent = Number(m[1]), days = Number(m[2]), monthly = Number(m[3]);
      const rate = Number(m[4]), capital = Number(m[5]), pct = Number(m[6]);
      const needed = Number(n[1]);
      check('the spend it quotes is the $10.00 that was inserted', near(spent, 10.0, 0.0001), `${spent}`);
      check('the span it measured is the 48 hours that were inserted', near(days, 2.0, 0.02), `${days} days`);
      check('the monthly projection is the spend scaled by that span, recomputed here',
        near(monthly, spent * (30 / days), 0.01), `${monthly} vs ${spent * (30 / days)}`);
      check('the rate is that projection as a share of that capital',
        near(rate, monthly / capital * 100, 0.02), `${rate}% vs ${monthly / capital * 100}%`);
      // THE NUMBER, NOT ITS PRESENCE. The capital that would fit is the monthly
      // projection divided by the budget fraction. Recomputed from the figures
      // the refusal itself printed, and separately against $7,500 worked out on
      // paper from the inputs this case chose.
      check('the capital that would fit is the projection divided by the budget fraction',
        near(needed, monthly / (pct / 100), 1.0), `${needed} vs ${monthly / (pct / 100)}`);
      check('and that figure is $7,500 for a $150/month burn at 2%',
        near(needed, 7500, 40), `${needed}`);
    }
    console.log(`      ${d.rationale.slice(0, 240)}`);
  }

  // === PER AGENT ==========================================================
  console.log('\n=== The pause is per agent, not per engine ===');
  {
    const noisy = await freshCase('noisy', ref);
    insertCost(noisy, 5.00, 2);
    const neighbour = await freshCase('neighbour', ref);
    const rp = await cycle(noisy, ref);
    const rn = await cycle(neighbour, ref);
    const dp = decision(rp.body?.decision_id), dn = decision(rn.body?.decision_id);
    check('the noisy agent is paused', dp.reason === 'cost_budget_exceeded', `reason=${dp.reason}`);
    check('and its neighbour decides normally in the same engine',
      dn.reason !== 'cost_budget_exceeded', `reason=${dn.reason} — ${dn.rationale.slice(0, 120)}`);
  }

  // === UNREADABLE COST ====================================================
  console.log('\n=== An unpriced execution pauses rather than counting as free ===');
  {
    const id = await freshCase('unpriced', ref);
    insertCost(id, 0, 3, { unpriced: true });
    const r = await cycle(id, ref);
    const d = decision(r.body?.decision_id);
    check('the agent was paused', d.reason === 'cost_budget_exceeded', `reason=${d.reason} action=${d.action}`);
    check('and the reason is the missing price, not a breach',
      /no dollar cost recorded/.test(d.rationale), d.rationale.slice(0, 200));
    console.log(`      ${d.rationale.slice(0, 190)}`);
  }

  // === AN AGENT THAT ASKED FOR NOTHING IS UNMETERED ======================
  //
  // THE DEFAULT, and the whole point of the meter changing hands. This agent's
  // owner never set cost_budget_monthly_pct, so a cost that would pause the
  // agents above must do nothing at all here.
  console.log('\n=== An agent whose owner set no budget is unmetered ===');
  {
    const id = await freshCase('unmetered', ref, { noBudget: true });
    insertCost(id, 500, 2);               // wildly over any budget anyone would set
    const r = await cycle(id, ref);
    const d = decision(r.body?.decision_id);
    check('a huge cost passes when the owner never asked for a meter',
      d.reason !== 'cost_budget_exceeded', `reason=${d.reason}`);

    // THE CONTROL. The same cost, on an agent that DID ask, must still pause —
    // otherwise this case would pass just as happily if the meter had stopped
    // working altogether.
    const metered = await freshCase('control', ref);
    insertCost(metered, 500, 2);
    const rc = await cycle(metered, ref);
    check('and the identical cost still pauses an agent that did ask',
      decision(rc.body?.decision_id).reason === 'cost_budget_exceeded',
      decision(rc.body?.decision_id).reason);
  }

  // === THE PLATFORM CANNOT HAND OUT A BUDGET =============================
  console.log('\n=== There is no lever that imposes one ===');
  {
    // A MENTION IS NOT A READ. The code and the unit files say WHY the lever
    // was removed, and that history is worth keeping — the failure this project
    // keeps repeating is the opposite one, a note describing a lever that no
    // longer exists. So this looks for the shapes that would actually apply it:
    // an environment read, or a systemd Environment= line.
    const src = execFileSync('bash', ['-lc',
      `grep -rn "AGENT_COST_BUDGET_MONTHLY_PCT" ${REPO}/services ${REPO}/infra/systemd 2>/dev/null ` +
      `| grep -vE ':\\s*(//|#)' || true`],
      { encoding: 'utf8' }).trim();
    check('nothing in the services or the units still READS the removed env var',
      src === '', src.split('\n').slice(0, 3).join(' | '));

    // The mention has to survive, though: a removal nobody wrote down is one
    // somebody re-adds.
    const mentioned = execFileSync('bash', ['-lc',
      `grep -rl "AGENT_COST_BUDGET_MONTHLY_PCT" ${REPO}/services ${REPO}/docs 2>/dev/null || true`],
      { encoding: 'utf8' }).trim();
    check('and the removal is written down where somebody would look',
      mentioned !== '', 'nothing records that this lever was removed or why');
  }



  console.log('\n' + '='.repeat(40));
  console.log(`  PASS: ${pass}   FAIL: ${fail}`);
  console.log('='.repeat(40));
  if (fail > 0) {
    console.log('\nWhat the meter concluded, from the engine log:');
    for (const l of engineLog.split('\n')) if (/cost meter/i.test(l)) console.log('  ' + l);
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    // A FLAG, NOT process.exit(). Calling exit here skips the finally block, so
    // a failing run left its engines running and its fixture rows in the
    // database -- and the orphaned engine then held the port for the next run.
    exitCode = 1;
  } else {
    console.log('cost-budget-verify: the meter pauses for the owners who asked, and nobody else.');
  }
} finally {
  await stop();
  for (const id of made) {
    try { psql(`DELETE FROM executions WHERE agent_id = '${id}'`); } catch {}
    try { psql(`DELETE FROM decisions WHERE agent_id = '${id}'`); } catch {}
    try { psql(`DELETE FROM portfolio_snapshots WHERE portfolio_id IN (SELECT id FROM portfolios WHERE agent_id = '${id}')`); } catch {}
    try { psql(`DELETE FROM portfolios WHERE agent_id = '${id}'`); } catch {}
    try { psql(`DELETE FROM agents WHERE id = '${id}'`); } catch {}
  }
  for (const h of handles) { try { psql(`DELETE FROM creators WHERE handle = '${h}'`); } catch {} }
  // Belt and braces: nothing carrying this suite's mark may survive it.
  try { psql(`DELETE FROM executions WHERE note = '${MARK}'`); } catch {}
  try { execFileSync('rm', ['-f', BIN]); } catch {}
  console.log('cost-budget-verify: fixtures removed');
}
process.exit(exitCode);
