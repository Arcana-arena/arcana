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
 * And entry closes at the FIRST TICK, not at the status change. A competition
 * that has started and not yet ticked has no history a newcomer is missing; once
 * one tick exists, an agent entering would be ranked beside agents whose record
 * covers a longer window, and the standings cannot say which is which.
 *
 * IT CREATES ONE PENDING COMPETITION AND REMOVES IT. There is no admin session
 * available to a verifier, and no competition on this machine is joinable — the
 * two old ones are completed and the live one has ticked. The fixture is removed
 * on the process exit event rather than in a finally, for the reason
 * lib/fixtures.mjs exists: process.exit() skips finally, and a suite exits that
 * way exactly when it has failed.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { req, signInToken, bearer } from './lib/rate-aware.mjs';
import { sweepOnExit } from './lib/fixtures.mjs';
import { suite } from './lib/sections.mjs';

const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const PG = process.env.PG_CONTAINER || 'arcana-postgres';
const psql = (s) => execFileSync('docker',
  ['exec', PG, 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc', s], { encoding: 'utf8' }).trim();

// Services throw { code }, controllers throw { error: { code } }. The suites read
// both through this, so a refusal is recognised wherever it was raised.
const errCode = (b) => b?.error?.code ?? b?.code ?? b?.message ?? JSON.stringify(b)?.slice(0, 90);
const errField = (b, k) => b?.error?.[k] ?? b?.[k];

const { check, section, nothingToCheck, report } = suite('competition-entry-verify');
sweepOnExit('competition-entry-verify');

// The one fixture this suite owns, removed however the run ends.
const FIXTURE = randomUUID();
process.on('exit', () => {
  try {
    psql(`DELETE FROM competitions WHERE id = '${FIXTURE}'`);
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

await section('Entry closes at the first tick, not at the status change', async () => {
  const started = psql(
    `SELECT c.id::text FROM competitions c
      WHERE EXISTS (SELECT 1 FROM competition_ticks t WHERE t.competition_id = c.id)
        AND c.status <> 'completed' ORDER BY c.id LIMIT 1`);
  if (!started) {
    nothingToCheck('no competition on this machine has ticked and is still open, ' +
      'so the rule has nothing real to refuse against');
    return;
  }
  const ticks = psql(`SELECT count(*) FROM competition_ticks WHERE competition_id = '${started}'`);
  const r = await req(`${AGENT}/v1/competitions/${started}/participants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(mine.token) },
    body: JSON.stringify({ agentId: mine.agentId }),
  });
  check('entering a competition that has already ticked is refused',
    r.status === 400 && errCode(r.body) === 'competition_already_started',
    `${r.status} ${errCode(r.body)}`);
  check('and the refusal says how many ticks it missed',
    errField(r.body, 'ticks_elapsed') === Number(ticks),
    `refusal says ${errField(r.body, 'ticks_elapsed')}, the competition has run ${ticks}`);
  console.log(`      ${started.slice(0, 8)} has run ${ticks} tick(s), so entry is closed`);
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
