// lpexec-verify.mjs — proves the LP execution planner's contract, not its money.
//
// The planner sends nothing, so what can be demanded of it is exactly what
// matters before arming: it reads the queue the arbitrage service owns, every
// proposal is accounted for, a plan carries intents or a refusal and never
// both, and a proposal whose position the chain cannot ground is REFUSED with
// a reason rather than turned into a plan built on invented state.
//
// The positive path — a real agent-owned position becoming four intents — cannot
// exist before the first funding; the Go unit tests pin the assembly field by
// field, and the funding checkpoint (docs/lp-execution.md) reruns this against
// a real proposal.
import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { suite } from './lib/sections.mjs';

const REPO = process.env.REPO || '/home/ubuntu/arcana';
const GO = process.env.GO_BIN || '/usr/local/go/bin/go';
const ARB = process.env.ARBITRAGE_URL || 'http://127.0.0.1:8084';
const DB = process.env.DATABASE_URL || 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';

const sql = (q) => execFileSync('psql', [DB, '-At', '-q', '-c', q], { encoding: 'utf8' }).trim();

const BIN = `/tmp/lpexec-verify.${process.pid}`;
execFileSync(GO, ['build', '-o', BIN, './cmd/lpexec'], {
  cwd: `${REPO}/services/decision-engine`, stdio: 'inherit',
});

// Built and spawned, not `go run`: the lesson every suite in this directory
// has already written down — a compiler supervising a child is not the
// process being measured.
const execute = () => {
  const r = spawnSync(BIN, [], {
    encoding: 'utf8',
    env: { ...process.env, ARBITRAGE_URL: ARB },
    timeout: 90000,
  });
  let summary = null;
  try {
    summary = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop());
  } catch { /* the checks below say so */ }
  return { status: r.status, summary, stdout: r.stdout || '', stderr: r.stderr || '' };
};

const run = suite('lpexec-verify');
const NPM = '0x73991a25c818bf1f1128deaab1492d45638de0d3';
const FAKE_ID = '999999999999';

await run.section('The planner runs and its summary accounts for every proposal', async () => {
  const r = execute();
  run.check('exits 0 on a healthy queue', r.status === 0, `exit ${r.status}: ${r.stderr.slice(-200)}`);
  const s = r.summary;
  run.check('prints one JSON summary on stdout', !!s, r.stdout.slice(0, 160));
  if (!s) return;
  run.check('reports the arbitrage base URL it used', s.arbitrage === ARB, String(s.arbitrage));
  run.check('reports the position manager it plans against', s.position_manager === NPM, String(s.position_manager));
  run.check('reports a future deadline for the mint/decrease intents',
    typeof s.deadline_unix === 'number' && s.deadline_unix > Date.now() / 1000,
    String(s.deadline_unix));
  run.check('every proposal appears in the plans',
    Array.isArray(s.plans) && s.plans.length === s.proposals,
    JSON.stringify({ proposals: s.proposals, plans: s.plans?.length }));
  run.check('planned + refused equals proposals',
    s.planned + s.refused === s.proposals,
    JSON.stringify({ proposals: s.proposals, planned: s.planned, refused: s.refused }));
  run.check('a plan carries intents or a refusal, never both',
    s.plans.every((p) => (p.refusal ? !p.intents || p.intents.length === 0 : (p.intents || []).length > 0)),
    JSON.stringify(s.plans.slice(0, 2)));
});

await run.section('A proposal the chain cannot ground is refused, not planned', async () => {
  const wallet = sql(`SELECT address FROM agent_wallets WHERE address <> '' ORDER BY agent_id LIMIT 1`);
  const agent = sql(`SELECT agent_id FROM agent_wallets WHERE address <> '' ORDER BY agent_id LIMIT 1`);
  if (!wallet || !agent) {
    run.nothingToCheck('no agent wallet exists to attribute a verification row to');
    return;
  }
  const sweep = () => sql(
    `DELETE FROM lp_position_actions WHERE token_id = '${FAKE_ID}' AND agent_id = '${agent}'; ` +
    `DELETE FROM lp_positions WHERE token_id = '${FAKE_ID}' AND agent_id = '${agent}'`);
  sweep(); // an earlier run that died mid-section leaves rows behind
  try {
    sql(`INSERT INTO lp_positions
          (position_manager, token_id, agent_id, wallet, pool, token0, token1, fee_tier,
           tick_lower, tick_upper, liquidity, tokens_owed0, tokens_owed1,
           current_tick, in_range, amount0, amount1, recommendation, status, provenance)
         VALUES ('${NPM}', '${FAKE_ID}', '${agent}', '${wallet}',
           '0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002',
           '0x0000000000000000000000000000000000000003', 500, -100, 100, '1000000', '0', '0',
           '0', false, '1000', '2000', 'rebalance', 'open', 'verification')`);
    sql(`INSERT INTO lp_position_actions (position_manager, token_id, agent_id, recommendation, detail)
         VALUES ('${NPM}', '${FAKE_ID}', '${agent}', 'rebalance',
           '{"plan":{"tick_lower":-600,"tick_upper":600,"amount0_desired":"1","amount1_desired":"1","amount0_min":"1","amount1_min":"1"},"slippage_bps":50}'::jsonb)`);

    const r = execute();
    run.check('the planner still exits 0', r.status === 0, `exit ${r.status}: ${r.stderr.slice(-160)}`);
    const plan = (r.summary?.plans || []).find((p) => p.token_id === FAKE_ID);
    run.check('it sees the synthetic proposal', !!plan, JSON.stringify(r.summary?.plans));
    run.check('and REFUSES it with a reason', !!plan?.refusal, JSON.stringify(plan));
    run.check('and emits no intents for it',
      !plan?.intents || plan.intents.length === 0, JSON.stringify(plan?.intents));
  } finally {
    sweep();
  }
  const left = sql(`SELECT count(*) FROM lp_position_actions WHERE token_id = '${FAKE_ID}'`);
  run.check('the verification rows are removed again', left === '0', left);
});

rmSync(BIN, { force: true });
process.exit(run.report());
