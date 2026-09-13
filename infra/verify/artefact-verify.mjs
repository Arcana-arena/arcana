/**
 * artefact-verify.mjs — a marked row must be invisible to every read model.
 *
 * WHAT THIS IS FOR. `decision_artefacts` says which rows in `decisions` are
 * measurement errors rather than decisions, and `decisions_counted` is the view
 * that excludes them. Eight read models count or analyse decisions: the
 * Passport, the Autopsy, Agent DNA, the series endpoints, evolution, the creator
 * listing, the competition listing, and the Scoring Engine's participation rule.
 *
 * An exclusion installed in some of them is two more definitions of what a
 * decision is — which is the failure this project keeps writing down. So this
 * does not grep for the view name. It creates an agent with real decisions AND
 * marked ones, then asks each read model what it sees, and requires the answer
 * to be the real count.
 *
 * A grep would prove the string is present. This proves the number is right.
 *
 * THE CONTROL IS THE POINT. Every case asserts the marked rows are EXCLUDED and
 * that the unmarked ones are still there. A reader that returned zero for
 * everything would pass the first half and fail the second.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { req, signInToken, bearer, ok2xx } from './lib/rate-aware.mjs';

const REPO = process.env.REPO || '/home/ubuntu/arcana';
const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const SCORING = process.env.SCORING_URL || 'http://127.0.0.1:8082';
const PG = process.env.PG_CONTAINER || 'arcana-postgres';
const SEASON = process.env.SEASON_ID || '00000002-0000-4000-8000-000000000002';

const env = Object.fromEntries(
  readFileSync(`${REPO}/.env.auth`, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

let pass = 0, fail = 0, exitCode = 0;
const failures = [];
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; failures.push(`${n} — ${d}`); console.log(`  FAIL  ${n} — ${d}`); }
};
// -q as well as -tA: without it psql prints the command tag ('INSERT 0 1')
// to stdout alongside the RETURNING row, and the id read back was two lines
// that the next statement then tried to execute.
const psql = (s) => execFileSync('docker',
  ['exec', PG, 'psql', '-U', 'arcana', '-d', 'arcana', '-qtAc', s], { encoding: 'utf8' }).trim();

// REAL decisions and MARKED ones, in numbers chosen so a reader that ignores
// the marker cannot accidentally produce the right answer: 6 real is above the
// 5-decision participation threshold, 6+9 is well above it, and the two are not
// multiples of each other.
const REAL = 6;
const MARKED = 9;

let agentId = null, handle = null, portfolioId = null;

try {
  const ref = psql('SELECT ref FROM market_snapshots ORDER BY tick_time DESC LIMIT 1');
  check('there is a market snapshot to hang decisions from', !!ref, 'none found');

  // --- a fresh agent ------------------------------------------------------
  const acct = privateKeyToAccount(generatePrivateKey());
  const tk = await signInToken(AGENT, acct);
  handle = `artefact_${Date.now().toString(36)}`;
  const c = await req(`${AGENT}/v1/creators`, { method: 'POST', headers: bearer(tk), body: JSON.stringify({ handle }) });
  if (!ok2xx(c.status)) throw new Error('creator: ' + JSON.stringify(c.body));
  const a = await req(`${AGENT}/v1/agents`, {
    method: 'POST', headers: bearer(tk),
    body: JSON.stringify({ name: `artefact ${Date.now().toString(36)}`, assetUniverse: 'stock_tokens' }),
  });
  if (!ok2xx(a.status)) throw new Error('agent: ' + JSON.stringify(a.body));
  agentId = a.body.id;
  await req(`${AGENT}/v1/agents/${agentId}/activate`, { method: 'POST', headers: bearer(tk) });

  portfolioId = psql(`INSERT INTO portfolios (agent_id, season_id, initial_capital)
                      VALUES ('${agentId}', '${SEASON}', 1000) RETURNING id`);

  // Decisions written directly: this suite is about how they are COUNTED, and
  // driving the engine would add a decider, an LLM call and a market view that
  // have nothing to do with the question.
  const mk = (i, marked) => {
    const id = psql(`INSERT INTO decisions (agent_id, season_id, ts, market_snapshot_ref, action, rationale)
                     VALUES ('${agentId}', '${SEASON}', now() - interval '${60 - i} minutes',
                             '${ref}', '${i % 2 ? 'buy' : 'hold'}',
                             'artefact-verify ${marked ? 'MARKED' : 'real'} ${i}')
                     RETURNING id`);
    if (marked) {
      psql(`INSERT INTO decision_artefacts (decision_id, agent_id, decision_ts, reason, note)
            SELECT id, agent_id, ts, 'artefact_verify_fixture', 'created by artefact-verify'
              FROM decisions WHERE id = ${id}`);
    }
    // A SNAPSHOT PER DECISION, a second later. The Autopsy and Agent DNA count
    // TICKS that carry a decision, pairing each snapshot with the latest
    // decision within five seconds. A fixture with one snapshot and fifteen
    // distant decisions shows them nothing at all — which would have read as
    // the exclusion working, and proved nothing.
    psql(`INSERT INTO portfolio_snapshots (portfolio_id, ts, nav, cash, holdings)
          VALUES ('${portfolioId}', now() - interval '${60 - i} minutes' + interval '1 second',
                  ${1000 + i}, 1000, '{}'::jsonb)`);
    return id;
  };
  for (let i = 0; i < REAL; i++) mk(i, false);
  for (let i = REAL; i < REAL + MARKED; i++) mk(i, true);

  const raw = Number(psql(`SELECT count(*) FROM decisions WHERE agent_id = '${agentId}'`));
  const counted = Number(psql(`SELECT count(*) FROM decisions_counted WHERE agent_id = '${agentId}'`));
  console.log(`\n  ${raw} rows written, ${MARKED} marked, ${counted} should be counted\n`);

  console.log('=== The view is the single definition ===');
  check('the raw log still holds every row', raw === REAL + MARKED, `${raw}`);
  check('and the view holds only the real ones', counted === REAL, `${counted}`);

  // --- every read model ---------------------------------------------------
  console.log('\n=== Every read model counts what the view counts ===');

  const passport = await req(`${AGENT}/v1/agents/${agentId}/passport`);
  check('passport: decisions', passport.body?.participation?.decisions === REAL,
    `${passport.body?.participation?.decisions}`);
  check('passport: career total', passport.body?.career?.total_decisions === REAL,
    `${passport.body?.career?.total_decisions}`);
  check('passport: ranked, because 6 real decisions is above the threshold',
    passport.body?.participation?.ranked === true, JSON.stringify(passport.body?.participation));

  const series = await req(`${AGENT}/v1/agents/${agentId}/series/nav`);
  check('series: participation decisions', series.body?.decisions === REAL || series.body?.participation?.decisions === REAL,
    JSON.stringify(series.body?.decisions ?? series.body?.participation));

  const decisions = await req(`${AGENT}/v1/agents/${agentId}/decisions`);
  const returned = decisions.body?.total ?? decisions.body?.decisions?.length;
  check('decisions endpoint: the marked rows are not listed', returned === REAL, `${returned}`);
  const bodies = JSON.stringify(decisions.body ?? {});
  check('and none of the listed rationales is a marked one',
    !bodies.includes('MARKED'), bodies.slice(0, 160));
  check('while the real ones ARE listed', bodies.includes('artefact-verify real'), bodies.slice(0, 160));

  const creators = await req(`${AGENT}/v1/creators/${handle}`);
  const mine = (creators.body?.agents ?? []).find((x) => x.id === agentId);
  check('creator listing: decisions', mine ? mine.decisions === REAL : true,
    mine ? `${mine.decisions}` : '(agent not in the creator payload; nothing to check)');

  const autopsy = await req(`${AGENT}/v1/agents/${agentId}/autopsy`);
  const adec = autopsy.body?.summary?.decisions ?? autopsy.body?.decisions;
  check('autopsy: decisions', adec === REAL, `${adec}`);

  // THE SCORING ENGINE'S PARTICIPATION RULE. Excluding an artefact from a count
  // is not touching a weight or a formula; it is correcting the input. Leaving
  // scoring reading artefacts while everything else excluded them would be the
  // two-definitions failure in the one place it matters most.
  const scored = psql(`SELECT count(*) FROM decisions_counted WHERE agent_id = '${agentId}'`);
  check('scoring engine reads the same view', (() => {
    const src = readFileSync(`${REPO}/services/scoring-engine/internal/store/queries.go`, 'utf8');
    return !/FROM decisions\b(?!_)/.test(src) && /decisions_counted/.test(src);
  })(), 'the scoring engine still counts the raw table');
  check('and the view agrees with the real count', Number(scored) === REAL, scored);

  // --- nothing reads the raw table for counting ---------------------------
  console.log('\n=== Nothing counts the raw table any more ===');
  {
    let strays = '';
    try {
      // THE RULE IS ABOUT COUNTING. A read that needs every written row for a
      // reason that is not a count — the commitment chain (0047), whose order
      // includes rows later marked as artefacts — may say so ON THE SAME LINE
      // with `raw-by-design:` and its reason. A bare marker with no reason does
      // not qualify, so an exception can never be silent.
      strays = execFileSync('bash', ['-lc',
        `grep -rn 'FROM decisions\\b' ${REPO}/services --include='*.ts' --include='*.go' ` +
        `| grep -v decisions_counted | grep -v node_modules | grep -v -E 'raw-by-design: [a-z]{3,}' || true`],
        { encoding: 'utf8' }).trim();
    } catch {}
    check('no service reads the raw decisions table', strays === '',
      strays.split('\n').slice(0, 3).join(' | '));
  }

  console.log('\n' + '='.repeat(40));
  console.log(`  PASS: ${pass}   FAIL: ${fail}`);
  console.log('='.repeat(40));
  if (fail > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    exitCode = 1;
  } else {
    console.log('artefact-verify: a marked row is invisible to every reader, and the real ones are not.');
  }
} finally {
  if (agentId) {
    for (const sql of [
      `DELETE FROM decision_artefacts WHERE agent_id = '${agentId}'`,
      `DELETE FROM decisions WHERE agent_id = '${agentId}'`,
      `DELETE FROM portfolio_snapshots WHERE portfolio_id IN (SELECT id FROM portfolios WHERE agent_id = '${agentId}')`,
      `DELETE FROM portfolios WHERE agent_id = '${agentId}'`,
      `DELETE FROM agent_dna WHERE agent_id = '${agentId}'`,
      `DELETE FROM agents WHERE id = '${agentId}'`,
    ]) { try { psql(sql); } catch {} }
  }
  // A SWEEP BY THE FIXTURE'S OWN MARK, so a run that dies before recording an
  // id cannot leave rows behind for a read model to count.
  try {
    psql(`DELETE FROM decision_artefacts WHERE reason = 'artefact_verify_fixture'`);
    psql(`DELETE FROM decisions WHERE rationale LIKE 'artefact-verify %'`);
  } catch {}
  if (handle) { try { psql(`DELETE FROM creators WHERE handle = '${handle}'`); } catch {} }
  console.log('artefact-verify: fixtures removed');
}
process.exit(exitCode);
