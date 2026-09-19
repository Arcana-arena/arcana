/**
 * pace-verify.mjs — each agent decides on its owner's cadence, and the platform
 * no longer has an opinion about how often that should be.
 *
 * WHAT CHANGED, AND WHY IT NEEDS ITS OWN SUITE. Deciding used to be a
 * per-competition act: one interval in a systemd unit, every participant called
 * against it. An owner could not ask for a different pace, and a new agent's
 * first decision waited for the competition's next boundary — sixteen hours, in
 * the case that prompted this. Cadence is now `agents.cadence_seconds` and
 * cmd/pace drives it.
 *
 * THE THING MOST WORTH PROVING IS THE SELECTION. "Who is due" is four joins and
 * five exclusions, and every one of them is a way for an agent to silently never
 * decide — which is exactly the fault this change exists to end. So the due list
 * is driven against the real service with real rows: an agent whose cadence has
 * elapsed appears, one whose has not is absent, and each exclusion is checked by
 * making a row that should be excluded and watching it stay out.
 *
 * WHAT THIS SUITE WILL NOT DO IS RUN THE PACER FOR REAL. Pacing asks the engine
 * to decide for every due agent, which can broadcast transactions and spend real
 * funds — the same reason phase10-verify never opens a tick. The binary refuses
 * under ARCANA_VERIFICATION, and that refusal is driven here; everything else is
 * the endpoint and the validators.
 *
 * Usage (on the VPS, from the repo root):
 *   node infra/verify/pace-verify.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { req, signInToken, bearer } from './lib/rate-aware.mjs';
import { sweepOnExit } from './lib/fixtures.mjs';
import { suite } from './lib/sections.mjs';

const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const PG = process.env.PG_CONTAINER || 'arcana-postgres';
const BIN = process.env.PACE_BIN || 'scheduler-bin/pace';
const ENV_FILE = process.env.AUTH_ENV || '/home/ubuntu/arcana/.env.auth';

const psql = (s) => execFileSync('docker',
  ['exec', PG, 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc', s], { encoding: 'utf8' }).trim();

const INTERNAL_KEY = Object.fromEntries(
  readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
).INTERNAL_API_KEY;
if (!INTERNAL_KEY) {
  console.error('pace-verify: INTERNAL_API_KEY missing from ' + ENV_FILE);
  process.exit(1);
}
const key = { 'X-Internal-Key': INTERNAL_KEY };

const errCode = (b) => b?.error?.code ?? b?.code ?? b?.message ?? JSON.stringify(b)?.slice(0, 90);

const { check, section, nothingToCheck, report } = suite('pace-verify');

// The fixtures this suite owns: its own season and running competition, so the
// agents it seats are never entered into a real arena, and the rows it marks
// LIVE, which the provenance sweep cannot see. All removed however the run ends.
const ARENA = randomUUID();
const SEASON = randomUUID();
const LIVE_ROWS = [];
// REGISTERED BEFORE THE SWEEP, because exit handlers run in the order they were
// added and the order decides the outcome. The first run of this suite left a
// fixture behind: the sweep ran first, found the agent holding a seat in THIS
// suite's own arena, and kept it — correctly, by its own rule about rows holding
// something real — and the arena was then deleted a moment later, leaving an
// agent the sweep had already decided to spare. The seats go first now, so the
// sweep sees what is actually true.
process.on('exit', () => {
  try {
    psql(`DELETE FROM competitions WHERE id = '${ARENA}'`);
    psql(`DELETE FROM seasons WHERE id = '${SEASON}'`);
    for (const r of LIVE_ROWS) {
      // Portfolios first: a portfolio references the agent, and the engine
      // creates one the moment an agent decides. The first run's cleanup died on
      // that foreign key and left the row behind.
      psql(`DELETE FROM portfolio_snapshots WHERE portfolio_id IN
              (SELECT id FROM portfolios WHERE agent_id = '${r.agentId}')`);
      psql(`DELETE FROM portfolios WHERE agent_id = '${r.agentId}'`);
      psql(`DELETE FROM decisions WHERE agent_id = '${r.agentId}'`);
      psql(`DELETE FROM agents WHERE id = '${r.agentId}'`);
      if (r.creatorId) psql(`DELETE FROM creators WHERE id = '${r.creatorId}'`);
    }
  } catch { /* the summary matters more than this line */ }
});

// The shared fixture sweep goes LAST, so every seat this suite made is already
// handed back when it looks.
sweepOnExit('pace-verify');

/**
 * `live: true` sends the verification header EMPTY, so the row is born live the
 * way a browser's is. It has to be born that way: provenance is immutable by
 * trigger (0042), and the pacer excludes verification rows — a suite that
 * flipped the column afterwards would be testing nothing and could not.
 */
const mkAgent = async (label, { live = false, cadenceSeconds } = {}) => {
  const acct = privateKeyToAccount(generatePrivateKey());
  const token = await signInToken(AGENT, acct);
  const asOwner = live ? { 'X-Arcana-Verification': '' } : {};
  const creator = await req(`${AGENT}/v1/creators`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(token), ...asOwner },
    body: JSON.stringify({ handle: `pace_${label}_${Date.now().toString(36)}` }),
  });
  const body = { name: `pace_agent_${label}`, assetUniverse: 'us_equity' };
  if (cadenceSeconds !== undefined) body.cadenceSeconds = cadenceSeconds;
  const agent = await req(`${AGENT}/v1/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(token), ...asOwner },
    body: JSON.stringify(body),
  });
  if (live && agent.body?.id) LIVE_ROWS.push({ agentId: agent.body.id, creatorId: creator.body?.id });
  return { token, creatorId: creator.body?.id, agentId: agent.body?.id, created: agent };
};

/**
 * ASKED ABOUT A PINNED INSTANT, not about now, and the first run of this suite is
 * why. Its fixtures are live, active and seated, which is exactly what the
 * PRODUCTION pacer looks for — so within a minute it decided for them, their
 * last decision became now, and the due list this suite then asked for was
 * empty. Four exclusion checks passed against nothing, and only the control
 * ("the list is not simply empty") noticed.
 *
 * as_of fixes the question rather than racing the answer: each agent's last
 * decision is bounded to that instant, so a decision the pacer writes a moment
 * later cannot change what this suite is asserting about.
 */
const AS_OF = new Date().toISOString();
const dueList = async (asOf = AS_OF) => {
  const r = await req(`${AGENT}/internal/v1/agents/due?as_of=${encodeURIComponent(asOf)}`, { headers: key });
  return { status: r.status, body: r.body, ids: (r.body?.agents ?? []).map((a) => a.agent_id) };
};

// A seat, written directly: joinParticipant would charge the $ARCA gates and
// this suite is not testing entry. The arena is its own, so nothing real moves.
const seat = (agentId) => {
  psql(`UPDATE competitions SET participant_ids = array_append(coalesce(participant_ids,'{}'::uuid[]), '${agentId}'::uuid)
         WHERE id = '${ARENA}' AND NOT ('${agentId}'::uuid = ANY(coalesce(participant_ids,'{}'::uuid[])))`);
  psql(`INSERT INTO competition_entries (competition_id, agent_id, joined_tick_index)
        VALUES ('${ARENA}', '${agentId}'::uuid, 0) ON CONFLICT DO NOTHING`);
};

// A decision at a chosen age, so "due" and "not due" are both reachable without
// waiting. It needs a real snapshot ref: decisions.market_snapshot_ref is a
// foreign key, and inventing one would fail the insert rather than the check.
const SNAPSHOT = psql(`SELECT ref FROM market_snapshots ORDER BY tick_time DESC LIMIT 1`);
const decideAgo = (agentId, seconds) => {
  // Dated from AS_OF rather than now(), so the age this suite asserts on is the
  // age the endpoint measures.
  psql(`INSERT INTO decisions (agent_id, season_id, ts, market_snapshot_ref, action, rationale)
        VALUES ('${agentId}'::uuid, '${SEASON}'::uuid,
                '${AS_OF}'::timestamptz - interval '${seconds} seconds',
                '${SNAPSHOT}', 'hold', 'pace-verify fixture')`);
};

psql(`INSERT INTO seasons (id, name, universe, start_at, end_at, ruleset)
      VALUES ('${SEASON}', 'pace verify season', 'us_equities',
              now() - interval '1 hour', now() + interval '1 day', '{}'::jsonb)`);
psql(`INSERT INTO competitions (id, season_id, type, participant_ids, status)
      VALUES ('${ARENA}', '${SEASON}', 'ai_vs_ai', '{}'::uuid[], 'running')`);

await section('An owner sets the cadence, and the bounds are the data model', async () => {
  const fast = await mkAgent('fast', { cadenceSeconds: 60 });
  check('sixty seconds is accepted at creation',
    fast.created.status === 201 && fast.created.body?.cadenceSeconds === 60,
    `${fast.created.status} cadenceSeconds=${JSON.stringify(fast.created.body?.cadenceSeconds)}`);

  // THE DEFAULT IS THE FLOOR, not a waiting period. It was four hours for one
  // hour on 2026-09-20, inherited from the interval that used to live in a unit
  // file — and a funded agent created in the afternoon still sat idle until the
  // platform's clock came round, which is the fault the whole change is about.
  const dflt = await mkAgent('default');
  check('an owner who says nothing gets the floor, not a wait',
    dflt.created.body?.cadenceSeconds === 60,
    `cadenceSeconds=${JSON.stringify(dflt.created.body?.cadenceSeconds)}`);

  // BELOW THE FLOOR IS REFUSED, and the floor is the snapshot ref's minute
  // resolution rather than a view about fees. 59 is the interesting number:
  // one second below, so the check cannot pass by the value being nonsense.
  const tooFast = await mkAgent('toofast', { cadenceSeconds: 59 });
  check('fifty-nine seconds is refused', tooFast.created.status === 400,
    `${tooFast.created.status} ${errCode(tooFast.created.body)}`);

  const tooSlow = await mkAgent('tooslow', { cadenceSeconds: 2592001 });
  check('more than a month is refused', tooSlow.created.status === 400,
    `${tooSlow.created.status} ${errCode(tooSlow.created.body)}`);

  // CHANGEABLE ON A RUNNING AGENT, unlike the mandate. An owner who had to
  // create a new version to change pace would leave it at a pace they do not
  // want.
  const patched = await req(`${AGENT}/v1/agents/${dflt.agentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...bearer(dflt.token) },
    body: JSON.stringify({ cadenceSeconds: 900 }),
  });
  check('the owner can change it later', patched.status === 200,
    `${patched.status} ${errCode(patched.body)}`);
  check('and the row holds the new number',
    psql(`SELECT cadence_seconds FROM agents WHERE id='${dflt.agentId}'`) === '900',
    'the column did not change');

  // THE SCHEMA REFUSES IT TOO. The validator and the CHECK constraint are two
  // enforcement points for one fact, and a fact enforced in only the layer a
  // future writer happens to use is not enforced.
  let raised = false;
  try {
    psql(`UPDATE agents SET cadence_seconds = 30 WHERE id='${dflt.agentId}'`);
  } catch { raised = true; }
  check('and SQL that writes thirty seconds is refused by the constraint, not just the DTO',
    raised, 'the CHECK constraint allowed a sub-minute cadence');
});

await section('Who is due is measured from the record, per agent', async () => {
  if (!SNAPSHOT) {
    nothingToCheck('there is no market snapshot on this machine to reference a fixture decision to');
    return;
  }
  const due = await mkAgent('due', { live: true, cadenceSeconds: 300 });
  const notDue = await mkAgent('notdue', { live: true, cadenceSeconds: 86400 });
  if (!due.agentId || !notDue.agentId) {
    check('both fixtures were created', false, `${due.agentId} / ${notDue.agentId}`);
    return;
  }
  psql(`UPDATE agents SET status = 'active' WHERE id IN ('${due.agentId}', '${notDue.agentId}')`);
  seat(due.agentId);
  seat(notDue.agentId);

  // Both decided ten minutes ago. One's cadence is five minutes, the other's is
  // a day, so the SAME history puts one in the list and the other out — which is
  // the whole point of the change.
  decideAgo(due.agentId, 600);
  decideAgo(notDue.agentId, 600);

  const list = await dueList();
  check('the due endpoint answers to the internal key', list.status === 200,
    `${list.status} ${errCode(list.body)}`);
  check('an agent past its own cadence is due',
    list.ids.includes(due.agentId), `due list: ${list.ids.length} agent(s)`);
  check('and one inside its own cadence is not, on the same history',
    !list.ids.includes(notDue.agentId), 'an agent 10 minutes into a 24-hour cadence was listed');

  const row = (list.body?.agents ?? []).find((a) => a.agent_id === due.agentId);
  check('the answer carries the cadence it was measured against',
    row?.cadence_seconds === 300, `row: ${JSON.stringify(row)}`);
  check('and the age it measured, so the decision is auditable rather than asserted',
    typeof row?.age_seconds === 'number' && row.age_seconds >= 600,
    `age_seconds=${JSON.stringify(row?.age_seconds)}`);
  check('and the season of the seat it holds, not the newest season',
    row?.season_id === SEASON, `season_id=${row?.season_id} fixture=${SEASON}`);

  // AN AGENT THAT HAS NEVER DECIDED IS DUE IMMEDIATELY. This is the case the
  // sixteen-hour wait was: a funded agent whose first decision had nothing to
  // measure against, so nothing ever asked it.
  const fresh = await mkAgent('fresh', { live: true, cadenceSeconds: 86400 });
  psql(`UPDATE agents SET status = 'active' WHERE id = '${fresh.agentId}'`);
  seat(fresh.agentId);
  const withFresh = await dueList();
  check('an agent that has never decided is due at once, whatever its cadence',
    withFresh.ids.includes(fresh.agentId),
    'a new agent with a 24h cadence and no decisions was not listed');
});

await section('The exclusions keep out exactly what the engine would refuse', async () => {
  if (!SNAPSHOT) {
    nothingToCheck('no snapshot to hang fixture decisions from');
    return;
  }
  // A DRAFT. The engine answers "agent is not active", so listing one would put
  // a guaranteed failure into every run for as long as the row existed.
  const draft = await mkAgent('draft', { live: true, cadenceSeconds: 60 });
  seat(draft.agentId);
  // A VERIFICATION FIXTURE, refused by the engine by design.
  const fixture = await mkAgent('fixture', { cadenceSeconds: 60 });
  psql(`UPDATE agents SET status = 'active' WHERE id = '${fixture.agentId}'`);
  seat(fixture.agentId);
  // A HUMAN-MANAGED AGENT. A person is not paced by a clock; the manual endpoint
  // is theirs and still works.
  const human = await mkAgent('human', { live: true, cadenceSeconds: 60 });
  psql(`UPDATE agents SET status = 'active', strategy_type = 'human' WHERE id = '${human.agentId}'`);
  seat(human.agentId);
  // ACTIVE, PACED, AND HOLDING NO SEAT — nothing to record a decision against.
  const unseated = await mkAgent('unseated', { live: true, cadenceSeconds: 60 });
  psql(`UPDATE agents SET status = 'active' WHERE id = '${unseated.agentId}'`);
  psql(`UPDATE competitions SET participant_ids = array_remove(participant_ids, '${unseated.agentId}'::uuid)`);

  const list = await dueList();
  check('a draft is not paced', !list.ids.includes(draft.agentId),
    'a draft agent was listed as due');
  check('a verification fixture is not paced', !list.ids.includes(fixture.agentId),
    'a verification fixture was listed as due');
  check('a human-managed agent is not paced', !list.ids.includes(human.agentId),
    'a human-managed agent was listed as due');
  check('an agent with no seat anywhere is not paced', !list.ids.includes(unseated.agentId),
    'an agent with no seat was listed, and its decision would have no season');

  // THE CONTROL. Every check above passes if the endpoint returns an empty list,
  // so one agent that SHOULD be there proves the filter is a filter.
  check('and the list is not simply empty', list.ids.length > 0,
    'nothing at all was due, so the four exclusions above prove nothing');
});

await section('The due list is machine tier, and the pacer refuses a verification', async () => {
  const anon = await req(`${AGENT}/internal/v1/agents/due`, {});
  check('a caller with no internal key is refused',
    anon.status === 403 && anon.body?.error?.code === 'forbidden_internal',
    `${anon.status} ${errCode(anon.body)}`);

  // THE REFUSAL IN THE BINARY, driven rather than read. A suite that drove the
  // cadence past a retired floor once opened a real tick and bought $5.96 of
  // MSFT; the protection has to live in the program, and the only way to know it
  // does is to run it.
  let out = '';
  let code = 0;
  let spawnErr = null;
  try {
    out = execFileSync(resolve(BIN), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ARCANA_VERIFICATION: '1', INTERNAL_API_KEY },
    });
  } catch (e) {
    code = e.status ?? 1;
    // ENOENT, EACCES and a timeout all land here with NO output, and the first
    // version of this check read "exited non-zero" as "refused" — so a missing
    // binary passed it. That is the same shape as a suite reporting success
    // because it found no data, which this repository has written down twice.
    spawnErr = e.code ?? e.message?.slice(0, 80) ?? null;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const said = out.trim() !== '';
  check('the pacer ran, and refused', code !== 0 && said,
    `exit=${code} spawn=${spawnErr} bin=${resolve(BIN)} out=${JSON.stringify(out.slice(0, 200))}`);
  check('and says what it was protecting rather than just refusing',
    /spend real funds|broadcast transactions/i.test(out), out.slice(0, 200));
  check('and nothing was asked to decide before it refused',
    said && !/agent\(s\) due|decided/i.test(out),
    `it printed nothing, so this proves nothing: ${JSON.stringify(out.slice(0, 120))}`);
});

const code = report();
if (code !== 0) process.exit(code);
console.log('pace-verify: every agent runs on its owner\'s clock, and the exclusions hold.');
