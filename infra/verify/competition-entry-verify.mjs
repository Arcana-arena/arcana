/**
 * competition-entry-verify.mjs — the door an owner uses to enter a competition.
 *
 * WHAT THIS IS FOR. Entering a competition used to mean an operator writing to
 * `participant_ids` by hand: the controller had create and complete and nothing
 * else, so the only supported way in was a competition being created with you
 * already listed. This drives the endpoints that replaced that, against the real
 * service, with real sign-ins.
 *
 * THE TWO THINGS MOST WORTH PROVING are refusals.
 *
 * The gates must not be bypassable by the new door. COMPETE, and PREMIUM_ARENA
 * in a premium arena, are enforced in one `admit()` the create path shares — but
 * "they share a method" is a claim about code. What is checked here is that a
 * successful entry comes back carrying the `access` block naming the gates it
 * passed, the same block create() returns.
 *
 * ENTRY NO LONGER CLOSES AT THE FIRST TICK, and this suite now proves the
 * opposite of what it used to. The old rule refused entry once a competition had
 * ticked, so that standings never compared a three-hour record against a
 * three-day one. Under a continuous cadence that rule closed the arena four
 * hours into a three-month season and left every agent created afterwards
 * active, funded and never called — seven of them on this machine, one belonging
 * to a real owner. The comparison problem is now RECORDED instead:
 * competition_entries.joined_tick_index, carried into the standings.
 *
 * AND THE INVARIANT THAT REPLACES IT: an active agent holds a seat. That is the
 * check that would have caught the original fault, and it is asserted here
 * against this database rather than against a fixture, because the fault was in
 * production data and not in a branch.
 *
 * IT CREATES ITS OWN SEASON AND TWO COMPETITIONS AND REMOVES THEM. There is no
 * admin session available to a verifier. The fixtures are removed on the process
 * exit event rather than in a finally, for the reason lib/fixtures.mjs exists:
 * process.exit() skips finally, and a suite exits that way exactly when it has
 * failed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { req, signInToken, bearer } from './lib/rate-aware.mjs';
import { sweepOnExit } from './lib/fixtures.mjs';
import { suite } from './lib/sections.mjs';

const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const PG = process.env.PG_CONTAINER || 'arcana-postgres';
// Read from the file rather than from the environment: run-all sources .env.auth
// and a direct `node infra/verify/…` does not, and a suite that silently sends
// an empty key proves that the guard refuses an empty key.
const ENV_FILE = process.env.AUTH_ENV || '/home/ubuntu/arcana/.env.auth';
const INTERNAL_KEY = Object.fromEntries(
  readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
).INTERNAL_API_KEY;
if (!INTERNAL_KEY) {
  console.error('competition-entry-verify: INTERNAL_API_KEY missing from ' + ENV_FILE);
  process.exit(1);
}
const psql = (s) => execFileSync('docker',
  ['exec', PG, 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc', s], { encoding: 'utf8' }).trim();

// Services throw { code }, controllers throw { error: { code } }. The suites read
// both through this, so a refusal is recognised wherever it was raised.
const errCode = (b) => b?.error?.code ?? b?.code ?? b?.message ?? JSON.stringify(b)?.slice(0, 90);
const errField = (b, k) => b?.error?.[k] ?? b?.[k];

const { check, section, nothingToCheck, report } = suite('competition-entry-verify');
sweepOnExit('competition-entry-verify');

// The fixtures this suite owns, removed however the run ends. Competitions go
// before the season they hang from: season_id is a plain reference with no
// cascade, so the other order leaves the season behind and the next run finds a
// stranger's arena outranking the real one.
const FIXTURE = randomUUID();       // a pending competition: the door itself
const ARENA = randomUUID();         // a running one, to prove activation seats
const FIXTURE_SEASON = randomUUID();
// One row is marked `live` for a few seconds to drive the seating path, and the
// mark is undone here as well as inline. A suite that fails between the two
// would otherwise leave behind an active live agent the sweep cannot see — and
// the next run's own invariant check would fail on it, which is a flake this
// suite would have manufactured for itself.
let LIVE_MARKED = null;
process.on('exit', () => {
  try {
    if (LIVE_MARKED) {
      psql(`UPDATE agents SET provenance = 'verification', status = 'retired' WHERE id = '${LIVE_MARKED}'`);
    }
    psql(`DELETE FROM competitions WHERE id IN ('${FIXTURE}', '${ARENA}')`);
    psql(`DELETE FROM seasons WHERE id = '${FIXTURE_SEASON}'`);
  } catch { /* the summary matters more than this line */ }
});

const mkAgent = async (label) => {
  const key = generatePrivateKey();
  const acct = privateKeyToAccount(key);
  const token = await signInToken(AGENT, acct);
  const creator = await req(`${AGENT}/v1/creators`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(token) },
    body: JSON.stringify({ handle: `entry_${label}_${Date.now().toString(36)}` }),
  });
  const agent = await req(`${AGENT}/v1/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(token) },
    body: JSON.stringify({ name: `entry_agent_${label}`, assetUniverse: 'us_equity' }),
  });
  return { token, creatorId: creator.body?.id, agentId: agent.body?.id, address: acct.address };
};

const mine = await mkAgent('owner');
const other = await mkAgent('stranger');

await section('An owner enters their own agent, and the gates are named in the answer', async () => {
  if (!mine.agentId) {
    check('the fixture agent was created', false, JSON.stringify(mine).slice(0, 200));
    return;
  }
  const season = psql(`SELECT id FROM seasons ORDER BY start_at DESC NULLS LAST LIMIT 1`);
  if (!season) {
    nothingToCheck('there is no season to hang a competition from');
    return;
  }
  psql(`INSERT INTO competitions (id, season_id, type, participant_ids, status)
        VALUES ('${FIXTURE}', '${season}', 'ai_only', '{}'::uuid[], 'pending')`);

  const r = await req(`${AGENT}/v1/competitions/${FIXTURE}/participants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(mine.token) },
    body: JSON.stringify({ agentId: mine.agentId }),
  });
  check('the owner is admitted', r.status === 201 || r.status === 200,
    `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  check('and the agent is in participant_ids afterwards',
    psql(`SELECT '${mine.agentId}'::uuid = ANY(participant_ids) FROM competitions WHERE id='${FIXTURE}'`) === 't',
    'the array does not contain the agent that was just admitted');

  // THE GATES. Not "the code calls admit()" — the answer says which gates ran.
  const gates = r.body?.access?.gates_applied;
  check('the answer names the gates that were applied',
    Array.isArray(gates) && gates.includes('compete'),
    `access.gates_applied = ${JSON.stringify(gates)}`);
  check('and says whether a balance was actually read',
    typeof r.body?.access?.balance_checked === 'boolean',
    `access.balance_checked = ${JSON.stringify(r.body?.access?.balance_checked)}`);

  const again = await req(`${AGENT}/v1/competitions/${FIXTURE}/participants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(mine.token) },
    body: JSON.stringify({ agentId: mine.agentId }),
  });
  check('entering twice is refused', again.status === 400 &&
    errCode(again.body) === 'already_a_participant', `${again.status} ${errCode(again.body)}`);
});

await section('Only the owner may enter an agent, and ownership is checked first', async () => {
  if (!mine.agentId || !other.token) {
    nothingToCheck('the two fixtures were not both created');
    return;
  }
  const r = await req(`${AGENT}/v1/competitions/${FIXTURE}/participants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(other.token) },
    body: JSON.stringify({ agentId: mine.agentId }),
  });
  check('a stranger entering somebody else\'s agent is refused', r.status === 403,
    `${r.status} ${errCode(r.body)}`);

  const anon = await req(`${AGENT}/v1/competitions/${FIXTURE}/participants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: mine.agentId }),
  });
  check('and an anonymous caller is refused before anything else', anon.status === 401,
    `${anon.status} ${errCode(anon.body)}`);
});

await section('Entry stays open after the first tick, and the lateness is recorded', async () => {
  if (!other.agentId) {
    nothingToCheck('there is no second fixture agent to enter late');
    return;
  }
  // One tick on the fixture, which is what used to slam the door. Written
  // directly because opening a real tick makes every participant DECIDE, and a
  // verifier may not do that — the cadence binary refuses it for the same reason.
  psql(`INSERT INTO competition_ticks (competition_id, tick_index, phase, market_snapshot_ref, window_end)
        VALUES ('${FIXTURE}', 0, 'closed', 'verify/entry/tick-0', now())`);

  const r = await req(`${AGENT}/v1/competitions/${FIXTURE}/participants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(other.token) },
    body: JSON.stringify({ agentId: other.agentId }),
  });
  check('entering a competition that has already ticked is ADMITTED',
    r.status === 201 || r.status === 200, `${r.status} ${errCode(r.body)}`);
  check('and the answer says which tick this record starts at',
    r.body?.entry?.joined_tick_index === 1,
    `entry = ${JSON.stringify(r.body?.entry)}`);
  check('the entry is on the record, not just in the answer',
    psql(`SELECT joined_tick_index FROM competition_entries
           WHERE competition_id='${FIXTURE}' AND agent_id='${other.agentId}'`) === '1',
    'competition_entries has no row for an agent that was just admitted');

  // THE MARK HAS TO REACH THE PLACE THE COMPARISON IS MADE. Recording lateness
  // and then ranking without it would be the same unfairness with a paper trail.
  const st = await req(`${AGENT}/v1/competitions/${FIXTURE}/standings`, {});
  const row = (st.body?.standings ?? []).find((s) => s.agent_id === other.agentId);
  check('and the standings carry it', row?.joined_tick_index === 1,
    `standings row = ${JSON.stringify(row)?.slice(0, 200)}`);
  check('and say so in words, next to the agent that joined late',
    typeof row?.note === 'string' && row.note.includes('shorter window'),
    `note = ${JSON.stringify(row?.note)}`);
});

await section('Activating an agent takes a seat, in the same call', async () => {
  const third = await mkAgent('seated');
  if (!third.agentId) {
    check('the fixture agent was created', false, JSON.stringify(third).slice(0, 200));
    return;
  }

  // AN ARENA THIS SUITE OWNS. Activation seats into whatever is live — running,
  // in a season containing now, AI-vs-AI first — so the fixture season starts
  // later than any real one and its competition wins that ordering for the few
  // seconds this section lasts. Nothing real is entered into it, and a real
  // activation landing here while it exists is recovered by the per-tick
  // reconciler, which is why that reconciler is not optional.
  psql(`INSERT INTO seasons (id, name, universe, start_at, end_at, ruleset)
        VALUES ('${FIXTURE_SEASON}', 'verify entry season', 'us_equities',
                now(), now() + interval '1 day', '{}'::jsonb)`);
  psql(`INSERT INTO competitions (id, season_id, type, participant_ids, status)
        VALUES ('${ARENA}', '${FIXTURE_SEASON}', 'ai_vs_ai', '{}'::uuid[], 'running')`);

  // A VERIFICATION ROW IS NOT SEATED, and that exception is the point of this
  // pair of checks. The engine refuses a verification agent by design, so a seat
  // would buy it a failure in every tick until the sweep removed it.
  const asFixture = await req(`${AGENT}/v1/agents/${third.agentId}/activate`, {
    method: 'POST', headers: bearer(third.token),
  });
  check('a verification fixture still activates', asFixture.status === 200 || asFixture.status === 201,
    `${asFixture.status} ${errCode(asFixture.body)}`);
  check('and is NOT seated anywhere, because the engine refuses it anyway',
    psql(`SELECT count(*) FROM competitions
           WHERE '${third.agentId}'::uuid = ANY(coalesce(participant_ids,'{}'::uuid[]))`) === '0',
    'a verification fixture was entered into a competition');

  // Now the live path. The row is flipped in place rather than created without
  // the header: a live row this suite cannot sweep is exactly what provenance
  // exists to prevent, and it is put back before the section ends.
  const live = await mkAgent('live');
  LIVE_MARKED = live.agentId;
  psql(`UPDATE agents SET provenance = 'live' WHERE id = '${live.agentId}'`);
  const activated = await req(`${AGENT}/v1/agents/${live.agentId}/activate`, {
    method: 'POST', headers: bearer(live.token),
  });
  check('a live agent activates', activated.status === 200 || activated.status === 201,
    `${activated.status} ${errCode(activated.body)}`);
  check('and holds a seat the moment it is active — no second call',
    psql(`SELECT '${live.agentId}'::uuid = ANY(coalesce(participant_ids,'{}'::uuid[]))
            FROM competitions WHERE id='${ARENA}'`) === 't',
    'an agent was activated and entered nothing: the fault this suite exists for');
  check('and its entry says it was there from the first tick',
    psql(`SELECT joined_tick_index FROM competition_entries
           WHERE competition_id='${ARENA}' AND agent_id='${live.agentId}'`) === '0',
    'no entry row for an agent seated at activation');
  psql(`UPDATE agents SET provenance = 'verification', status = 'retired' WHERE id = '${live.agentId}'`);
  psql(`UPDATE competitions SET participant_ids = array_remove(participant_ids, '${live.agentId}'::uuid)
         WHERE id = '${ARENA}'`);
  LIVE_MARKED = null;
});

await section('On this database, every active agent holds a seat', async () => {
  // THE CHECK THAT WOULD HAVE CAUGHT IT. Not a fixture: the fault was seven real
  // rows, and a suite that only ever asks its own fixtures would have reported
  // green through all sixteen hours of it.
  const stranded = psql(
    `SELECT count(*) FROM agents a
      WHERE a.status = 'active' AND a.provenance <> 'verification'
        AND NOT EXISTS (SELECT 1 FROM competitions c
                         WHERE c.status <> 'completed'
                           AND a.id = ANY(coalesce(c.participant_ids, '{}'::uuid[])))`);
  check('no active agent is waiting outside a competition', stranded === '0',
    `${stranded} active agent(s) hold no seat, so nothing will ever call them`);

  // The door the cadence uses before every tick. Asserted here because an
  // activation that seats is only half the guarantee: rows arrive by migration,
  // by restore, and while no competition is running.
  const key = { 'X-Internal-Key': INTERNAL_KEY };
  const r = await req(`${AGENT}/internal/v1/competitions/${FIXTURE}/participants/reconcile`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...key },
    body: '{}',
  });
  check('the cadence can ask a competition to seat whoever is missing',
    r.status === 200 || r.status === 201, `${r.status} ${errCode(r.body)}`);
  check('and with the invariant holding it seats nobody',
    Array.isArray(r.body?.seated) && r.body.seated.length === 0,
    `seated = ${JSON.stringify(r.body?.seated)}`);

  const anon = await req(`${AGENT}/internal/v1/competitions/${FIXTURE}/participants/reconcile`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  check('a caller with no internal key cannot move the field', anon.status === 401,
    `${anon.status} ${errCode(anon.body)}`);
});

await section('Leaving is its own door, and does not retire the agent', async () => {
  if (!mine.agentId) {
    nothingToCheck('there is no fixture agent to withdraw');
    return;
  }
  const r = await req(`${AGENT}/v1/competitions/${FIXTURE}/participants/${mine.agentId}`, {
    method: 'DELETE', headers: bearer(mine.token),
  });
  check('the owner can withdraw', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  check('the seat is handed back',
    psql(`SELECT '${mine.agentId}'::uuid = ANY(coalesce(participant_ids,'{}'::uuid[])) FROM competitions WHERE id='${FIXTURE}'`) === 'f',
    'the agent is still in participant_ids after withdrawing');

  // THE POINT OF A SEPARATE DOOR. retire() also hands back the seat — and stands
  // the agent down everywhere. Withdrawing must not.
  check('and the agent is still alive, not retired',
    psql(`SELECT status FROM agents WHERE id='${mine.agentId}'`) !== 'retired',
    'withdrawing from a competition retired the agent, which is what having two doors was for');

  const twice = await req(`${AGENT}/v1/competitions/${FIXTURE}/participants/${mine.agentId}`, {
    method: 'DELETE', headers: bearer(mine.token),
  });
  check('withdrawing an agent that is not entered is refused',
    twice.status === 400 && errCode(twice.body) === 'not_a_participant',
    `${twice.status} ${errCode(twice.body)}`);
});

const code = report();
if (code !== 0) process.exit(code);
console.log('competition-entry-verify: an owner can enter and leave, and the gates are on the door.');
