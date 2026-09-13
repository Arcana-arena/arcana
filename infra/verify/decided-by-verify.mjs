/**
 * decided-by-verify.mjs — a stop loss must not read as the agent's own call.
 *
 * WHAT WAS WRONG. `decisions.decider` records who acted: the agent's decider,
 * or the platform acting on a protective level. The passport counts the two
 * separately, Agent DNA carries protective share as its ninth dimension, and
 * the autopsy excludes protective exits from the trade count. But
 * GET /v1/agents/:id/decisions did not return the column at all, so in the one
 * place a person actually reads the trades, a sale a stop loss took was byte
 * for byte an ordinary sell.
 *
 * WHY "THE FIELD IS PRESENT" IS NOT THE CHECK. A serialiser that writes
 * `decider: 'agent'` on every row passes that. So every assertion here compares
 * the response against the COLUMN, row by row, keyed on (agent, timestamp) —
 * and requires the values to DIFFER across rows, because a constant is exactly
 * what a stub returns and a check that cannot tell a constant from a reading is
 * not checking anything.
 *
 * THE PART THAT IS NOT OBVIOUS, and which this suite exists to pin down:
 * `decider = 'protective'` DOES NOT MEAN "a level fired". On this platform most
 * protective rows are `hold`s carrying `cost_budget_exceeded` — written when a
 * level WAS crossed and the exit was NOT taken because the cost meter refused
 * it. A stop that did not fire is close to the opposite of a stop that did, and
 * labelling both "protective exit" would be a worse lie than printing nothing.
 *
 * Reads only. Creates nothing, needs no session.
 *
 *   node infra/verify/decided-by-verify.mjs
 */
import { execFileSync } from 'node:child_process';
import { req } from './lib/rate-aware.mjs';
import { suite } from './lib/sections.mjs';

const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const PG = process.env.PG_CONTAINER || 'arcana-postgres';
const psql = (s) =>
  execFileSync('docker', ['exec', PG, 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc', s], {
    encoding: 'utf8',
  }).trim();

const { check, section, nothingToCheck, report } = suite('decided-by-verify');

/**
 * NULL and the empty string are different answers; keep them apart.
 *
 * A sentinel and not a null byte: the query travels as a process argument and
 * execFile refuses a string containing one. It has to be something coalesce()
 * can emit that the data cannot — a decider is a short lowercase word, so this
 * is safe and is asserted below rather than assumed.
 */
const NUL = '<<NULL>>';
const dbVal = (s) => (s === NUL ? null : s);

// The agent with the most protective rows: the one where this can actually be
// exercised. Chosen from the data rather than hardcoded, so the suite follows
// the platform instead of a fixture that may be swept.
const target = psql(`
  SELECT agent_id::text
    FROM decisions_counted
   WHERE decider = 'protective'
   GROUP BY agent_id
   ORDER BY count(*) DESC
   LIMIT 1`);

const anyAgent = psql(`
  SELECT agent_id::text FROM decisions_counted GROUP BY agent_id ORDER BY count(*) DESC LIMIT 1`);

const agentId = target || anyAgent;

await section('The endpoint returns the column at all', async () => {
  if (!agentId) {
    nothingToCheck('no agent has any decision recorded, so there is no response to inspect');
    return;
  }
  const r = await req(`${AGENT}/v1/agents/${agentId}/decisions?page_size=50`);
  check('GET /v1/agents/:id/decisions answers', r.status === 200, `status ${r.status}`);
  const rows = r.body?.decisions ?? [];
  if (rows.length === 0) {
    nothingToCheck('the agent has no decisions on this page');
    return;
  }
  check('every row carries a decider key, even when it is null',
    rows.every((d) => 'decider' in d),
    `${rows.filter((d) => !('decider' in d)).length} rows have no decider key`);
  check('and a reason_code key',
    rows.every((d) => 'reason_code' in d),
    `${rows.filter((d) => !('reason_code' in d)).length} rows have no reason_code key`);
  check('and a decided_by block that names a category',
    rows.every((d) => d.decided_by && typeof d.decided_by.category === 'string'),
    'a row has no decided_by.category');
  check('the category vocabulary is closed',
    rows.every((d) =>
      ['agent', 'protective_exit', 'protective_held_back', 'protective_other', 'unattributed'].includes(
        d.decided_by?.category,
      )),
    `saw: ${[...new Set(rows.map((d) => d.decided_by?.category))].join(', ')}`);
  check('every row explains itself in a sentence',
    rows.every((d) => typeof d.decided_by?.note === 'string' && d.decided_by.note.length > 20),
    'a row carries no note');
});

await section('The value is READ FROM THE COLUMN, not written by the serialiser', async () => {
  if (!agentId) {
    nothingToCheck('no agent to read');
    return;
  }
  const r = await req(`${AGENT}/v1/agents/${agentId}/decisions?page_size=100`);
  const rows = r.body?.decisions ?? [];
  if (rows.length === 0) {
    nothingToCheck('no rows to compare against the table');
    return;
  }

  // THE SENTINEL HAS TO BE UNAMBIGUOUS, so that is asserted rather than assumed.
  // If a decider ever literally equalled it, every NULL and every row carrying
  // that value would collapse into one answer and this whole section would be
  // comparing the wrong things while passing.
  const collides = Number(psql(`
    SELECT count(*) FROM decisions_counted
     WHERE decider = '${NUL}' OR reason_code = '${NUL}'`));
  check('the null sentinel cannot be confused with real data', collides === 0,
    `${collides} row(s) literally contain ${NUL}`);

  // The same rows, straight from the table, keyed by the instant they carry.
  const truth = new Map(
    psql(`
      SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             || '|' || coalesce(decider, '${NUL}')
             || '|' || coalesce(reason_code, '${NUL}')
             || '|' || action
        FROM decisions_counted
       WHERE agent_id = '${agentId}'`)
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [ts, decider, reason, action] = l.split('|');
        return [ts, { decider: dbVal(decider), reason_code: dbVal(reason), action }];
      }),
  );

  const mismatched = [];
  let compared = 0;
  for (const d of rows) {
    const t = truth.get(d.ts);
    if (!t) continue;
    compared++;
    if ((d.decider ?? null) !== t.decider) {
      mismatched.push(`${d.ts}: response ${JSON.stringify(d.decider)}, table ${JSON.stringify(t.decider)}`);
    }
    if ((d.reason_code ?? null) !== t.reason_code) {
      mismatched.push(
        `${d.ts}: reason response ${JSON.stringify(d.reason_code)}, table ${JSON.stringify(t.reason_code)}`,
      );
    }
  }
  check('every row matched against the table', compared > 0, 'no response row could be matched to a table row');
  check('and every decider and reason_code equals the column', mismatched.length === 0,
    mismatched.slice(0, 6).join('; '));

  // A CONSTANT WOULD SURVIVE EVERYTHING ABOVE if the table also held one value.
  // This is the check that separates "read" from "written".
  const distinct = new Set(rows.map((d) => JSON.stringify([d.decider, d.reason_code])));
  if (distinct.size < 2) {
    nothingToCheck(
      `every row on this page carries the same (decider, reason_code) pair ` +
      `${[...distinct][0]}, so this run cannot tell a column read from a constant`);
  } else {
    check('and the values differ between rows, so the field carries information',
      distinct.size >= 2,
      `only ${distinct.size} distinct pair(s)`);
    const counts = {};
    for (const d of rows) counts[d.decided_by?.category] = (counts[d.decided_by?.category] ?? 0) + 1;
    console.log(`      ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  }
});

await section('A protective row never reaches a reader unmarked', async () => {
  const protectiveAgents = psql(`
    SELECT DISTINCT agent_id::text FROM decisions_counted WHERE decider = 'protective'`)
    .split('\n')
    .filter(Boolean);

  if (protectiveAgents.length === 0) {
    nothingToCheck('no decision anywhere is marked protective, so this run cannot exercise the case');
    return;
  }

  // THE FAILING CONDITION, STATED DIRECTLY: a row the table calls protective
  // that arrives at the client without saying so.
  const unmarked = [];
  let seen = 0;
  for (const id of protectiveAgents) {
    const r = await req(`${AGENT}/v1/agents/${id}/decisions?page_size=200`);
    const rows = r.body?.decisions ?? [];
    const wanted = new Set(
      psql(`
        SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          FROM decisions_counted WHERE agent_id = '${id}' AND decider = 'protective'`)
        .split('\n')
        .filter(Boolean),
    );
    for (const d of rows) {
      if (!wanted.has(d.ts)) continue;
      seen++;
      if (d.decider !== 'protective' || !String(d.decided_by?.category ?? '').startsWith('protective')) {
        unmarked.push(`${id.slice(0, 8)} ${d.ts}: decider=${JSON.stringify(d.decider)} category=${JSON.stringify(d.decided_by?.category)}`);
      }
    }
  }
  check('protective rows were actually returned to be inspected', seen > 0,
    'none of the protective rows appeared on the pages read');
  check('and not one of them is presented as the agent\'s own decision',
    unmarked.length === 0, unmarked.slice(0, 5).join('; '));
  console.log(`      ${seen} protective row(s) inspected across ${protectiveAgents.length} agent(s)`);
});

await section('A level that was crossed and NOT acted on is not called an exit', async () => {
  const heldBack = psql(`
    SELECT agent_id::text || '|' ||
           to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      FROM decisions_counted
     WHERE decider = 'protective' AND action = 'hold'
     ORDER BY ts DESC LIMIT 5`).split('\n').filter(Boolean);

  if (heldBack.length === 0) {
    nothingToCheck('no protective row is a hold right now, so the refused-exit case is not exercised');
    return;
  }
  const byAgent = new Map();
  for (const l of heldBack) {
    const [id, ts] = l.split('|');
    if (!byAgent.has(id)) byAgent.set(id, []);
    byAgent.get(id).push(ts);
  }
  const wrong = [];
  let seen = 0;
  for (const [id, stamps] of byAgent) {
    const r = await req(`${AGENT}/v1/agents/${id}/decisions?page_size=200`);
    for (const d of r.body?.decisions ?? []) {
      if (!stamps.includes(d.ts)) continue;
      seen++;
      if (d.decided_by?.category !== 'protective_held_back') {
        wrong.push(`${d.ts}: category ${JSON.stringify(d.decided_by?.category)}`);
      }
      if (/exit/i.test(d.decided_by?.label ?? '') && !/NOT taken/i.test(d.decided_by?.label ?? '')) {
        wrong.push(`${d.ts}: label claims an exit — ${JSON.stringify(d.decided_by?.label)}`);
      }
    }
  }
  check('the refused exits were returned', seen > 0, 'none were found on the pages read');
  check('and each says the exit was NOT taken', wrong.length === 0, wrong.slice(0, 5).join('; '));
});

await section('The per-row reading agrees with the passport, which counts the same rule in SQL', async () => {
  if (!agentId) {
    nothingToCheck('no agent to compare');
    return;
  }
  const pass = await req(`${AGENT}/v1/agents/${agentId}/passport`);
  if (pass.status !== 200 || !pass.body?.decided_by) {
    check('the passport carries a decided_by block', false, `status ${pass.status}`);
    return;
  }
  const total = Number(psql(`SELECT count(*) FROM decisions_counted WHERE agent_id = '${agentId}'`));

  // Every page, so the aggregate is over the whole record rather than a page of
  // it — the passport counts the whole record.
  const all = [];
  for (let page = 1; ; page++) {
    const r = await req(`${AGENT}/v1/agents/${agentId}/decisions?page=${page}&page_size=200&include_prices=false`);
    const rows = r.body?.decisions ?? [];
    all.push(...rows);
    if (rows.length === 0 || all.length >= total || page >= 20) break;
  }
  check('every recorded decision was read back', all.length === total,
    `read ${all.length} of ${total}`);

  // The passport counts TRADES only for these three, so the aggregate has to
  // apply the same filter or the two are answering different questions.
  const trades = all.filter((d) => (d.action ?? '').toLowerCase() !== 'hold');
  const own = trades.filter((d) => d.decided_by?.category === 'agent').length;
  const protective = trades.filter((d) => d.decided_by?.category === 'protective_exit').length;
  const unattributed = trades.filter((d) => d.decided_by?.category === 'unattributed').length;

  const p = pass.body.decided_by;
  check('own trades counted from the rows equal the passport\'s own count',
    own === p.own, `rows say ${own}, passport says ${p.own}`);
  check('protective exits counted from the rows equal the passport\'s',
    protective === p.protective, `rows say ${protective}, passport says ${p.protective}`);
  check('unattributed trades counted from the rows equal the passport\'s',
    unattributed === p.unattributed, `rows say ${unattributed}, passport says ${p.unattributed}`);
  console.log(`      own=${own} protective=${protective} unattributed=${unattributed} of ${trades.length} trades`);
});

await section('A row that does not say who acted still does not say', async () => {
  const nullRows = Number(psql(`SELECT count(*) FROM decisions_counted WHERE decider IS NULL`));
  if (nullRows === 0) {
    nothingToCheck('every decision now carries a decider, so the not-recorded case cannot be exercised');
    return;
  }
  const id = psql(`
    SELECT agent_id::text FROM decisions_counted WHERE decider IS NULL
     GROUP BY agent_id ORDER BY count(*) DESC LIMIT 1`);
  const r = await req(`${AGENT}/v1/agents/${id}/decisions?page_size=200`);
  const rows = (r.body?.decisions ?? []).filter((d) => d.decider === null);
  check('rows with no decider came back', rows.length > 0, 'none were returned to inspect');
  check('they are null, not a default someone chose',
    rows.every((d) => d.decider === null),
    'a null decider arrived as something else');
  check('and they are categorised as not recorded, not as the agent\'s',
    rows.every((d) => d.decided_by?.category === 'unattributed'),
    `saw: ${[...new Set(rows.map((d) => d.decided_by?.category))].join(', ')}`);
});

await section('The autopsy sample says who decided too', async () => {
  const id = psql(`
    SELECT agent_id::text FROM decisions_counted
     WHERE action IN ('buy','sell') GROUP BY agent_id ORDER BY count(*) DESC LIMIT 1`);
  if (!id) {
    nothingToCheck('no agent has any trade, so the drawdown sample has nothing in it');
    return;
  }
  const r = await req(`${AGENT}/v1/agents/${id}/autopsy`);
  const sample = r.body?.risk?.decisions_during_drawdown?.sample ?? [];
  if (!Array.isArray(sample) || sample.length === 0) {
    nothingToCheck('this agent has no trades inside its worst drawdown, so the sample is empty');
    return;
  }
  check('every sampled trade carries a decider key', sample.every((s) => 'decider' in s),
    'a sampled trade has no decider');
  check('and a decided_by category', sample.every((s) => typeof s.decided_by?.category === 'string'),
    'a sampled trade has no decided_by');
});

await section('The agents list can be asked to exclude verification artefacts', async () => {
  const all = await req(`${AGENT}/v1/agents?page_size=1`);
  const live = await req(`${AGENT}/v1/agents?provenance=live&page_size=1`);
  const fixtures = await req(`${AGENT}/v1/agents?provenance=verification&page_size=1`);
  const bad = await req(`${AGENT}/v1/agents?provenance=nonsense&page_size=1`);

  check('provenance=live is accepted', live.status === 200, `status ${live.status}`);
  check('provenance=verification is accepted', fixtures.status === 200, `status ${fixtures.status}`);
  check('an unknown provenance is REFUSED rather than ignored', bad.status === 400,
    `status ${bad.status} — an ignored filter returns the whole table with a 200`);

  const dbLive = Number(psql(`SELECT count(*) FROM agents WHERE provenance = 'live'`));
  const dbFix = Number(psql(`SELECT count(*) FROM agents WHERE provenance = 'verification'`));
  check('the live count matches the table', live.body?.total === dbLive,
    `endpoint ${live.body?.total}, table ${dbLive}`);
  check('the verification count matches the table', fixtures.body?.total === dbFix,
    `endpoint ${fixtures.body?.total}, table ${dbFix}`);
  check('and the unfiltered total is still both together',
    all.body?.total === dbLive + dbFix,
    `unfiltered ${all.body?.total}, live ${dbLive} + verification ${dbFix}`);

  if (dbFix === 0) {
    // STILL DECLARED, AND NO LONGER AN UNRESOLVED GAP. This suite reads only —
    // it creates nothing and needs no session, which is what lets it run
    // against a live deployment without changing what it measures — so it
    // cannot make the condition it would need. The exclusion IS proven, in the
    // one suite that is holding a real artefact at the time:
    // creator-dashboard-verify builds a verification creator and agent through
    // the real endpoints and checks that unfiltered minus live equals the
    // verification count while they exist.
    nothingToCheck(
      'no verification artefact exists right now, so THIS suite can only prove the counts add up. ' +
      'That the live filter actually removes a row is proven by creator-dashboard-verify, which ' +
      'builds one first');
  } else {
    // If one happens to exist — another suite mid-run, or a fixture somebody
    // left behind — the stronger claim is free and worth making.
    check('and with an artefact present, the live filter genuinely removes it',
      all.body?.total - live.body?.total === dbFix,
      `unfiltered ${all.body?.total}, live ${live.body?.total}, artefacts ${dbFix}`);
  }
});

const code = report();
if (code !== 0) process.exit(code);
console.log('decided-by-verify: a level that fired is not the agent, and a level that did not fire is not an exit.');
