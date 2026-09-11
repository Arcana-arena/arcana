/**
 * guard-verify.mjs — the parts of take-profit / stop-loss that do not need the
 * chain, driven rather than read.
 *
 * WHAT THIS COVERS AND WHAT IT DOES NOT.
 *
 * The chain-side proof — a level crossing that produces a real transaction with
 * a real hash — is guard-chain-verify.mjs, because it spends real money and
 * cannot run on every commit. This covers everything else, and the most
 * important thing in it is the COLLISION:
 *
 *   the decision cycle and the position guard both want to move the same
 *   agent's funds at the same instant
 *
 * That is proved by MAKING IT HAPPEN — two real actors, one real lease, at the
 * same time — not by reading the branch that handles it. The rule it enforces
 * is the one already written for unresolved transactions: one intent must never
 * become two transactions.
 *
 * The fixtures are a fresh agent per case, for the reason cost-budget-verify
 * had to learn twice: every cycle rewrites the snapshot, so state set for one
 * case is silently restored by the next.
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { req, signInToken, bearer, ok2xx } from './lib/rate-aware.mjs';

const REPO = process.env.REPO || '/home/ubuntu/arcana';
const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const PG = process.env.PG_CONTAINER || 'arcana-postgres';
const GO = process.env.GO_BIN || '/usr/local/go/bin/go';

let pass = 0, fail = 0, exitCode = 0;
const failures = [];
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; failures.push(`${n} — ${d}`); console.log(`  FAIL  ${n} — ${d}`); }
};
const psql = (s) => execFileSync('docker', ['exec', PG, 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc', s], { encoding: 'utf8' }).trim();

const made = [];
const handles = [];

async function freshAgent(label) {
  const acct = privateKeyToAccount(generatePrivateKey());
  const tk = await signInToken(AGENT, acct, { chainId: 4663, domain: 'arcana.local', uri: 'https://arcana.local' });
  const h = `guard_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const c = await req(`${AGENT}/v1/creators`, { method: 'POST', headers: bearer(tk), body: JSON.stringify({ handle: h }) });
  if (!ok2xx(c.status)) throw new Error('creator: ' + JSON.stringify(c.body));
  handles.push(h);
  const a = await req(`${AGENT}/v1/agents`, {
    method: 'POST', headers: bearer(tk),
    body: JSON.stringify({ name: `guard ${label} ${Date.now().toString(36)}`, assetUniverse: 'stock_tokens' }),
  });
  if (!ok2xx(a.status)) throw new Error('agent: ' + JSON.stringify(a.body));
  made.push(a.body.id);
  await req(`${AGENT}/v1/agents/${a.body.id}/activate`, { method: 'POST', headers: bearer(tk) });
  return a.body.id;
}

try {
  // =====================================================================
  console.log('=== The schema refuses guards that could not work ===');
  {
    const id = await freshAgent('schema');
    const bad = (cols, vals) => {
      try {
        psql(`INSERT INTO position_guards (agent_id, symbol, entry_price, entry_qty, ${cols})
              VALUES ('${id}','AAPL',100,1,${vals})`);
        return null;
      } catch (e) { return String(e.stderr || e.message); }
    };
    check('a guard with neither level is refused',
      /position_guards_armed_has_a_level/.test(bad('note', `'x'`) || ''),
      'a guard that can never fire was accepted. The constraint was renamed when migration ' +
      '0037 narrowed it to ARMED rows: a REFUSED guard has no level by definition, because it ' +
      'records protection that was asked for and could not be given');
    check('a stop above its target is refused',
      /position_guards_ordered/.test(bad('stop_loss, take_profit', '120, 110') || ''),
      'both levels would fire at once and the order would silently decide which');
    check('a negative level is refused',
      /position_guards_stop_loss_check|violates check/.test(bad('stop_loss', '-1') || ''), 'a level below zero was accepted');

    // ONE ARMED GUARD PER POSITION, enforced by the database rather than by
    // whoever writes the next caller. Two armed guards are two exits of a
    // position that can only be exited once.
    psql(`INSERT INTO position_guards (agent_id, symbol, entry_price, entry_qty, stop_loss)
          VALUES ('${id}','AAPL',100,1,95)`);
    let second = null;
    try {
      psql(`INSERT INTO position_guards (agent_id, symbol, entry_price, entry_qty, stop_loss)
            VALUES ('${id}','AAPL',100,1,90)`);
    } catch (e) { second = String(e.stderr || e.message); }
    check('a second armed guard on the same position is refused',
      /uq_position_guards_armed/.test(second || ''), 'two armed guards on one position were allowed');
    check('but a guard on a DIFFERENT symbol is fine', (() => {
      try {
        psql(`INSERT INTO position_guards (agent_id, symbol, entry_price, entry_qty, stop_loss)
              VALUES ('${id}','NVDA',100,1,95)`);
        return true;
      } catch { return false; }
    })(), 'an agent could not guard two positions at once');
    check('and a closed guard stops blocking a new one', (() => {
      psql(`UPDATE position_guards SET status='cleared' WHERE agent_id='${id}' AND symbol='AAPL'`);
      try {
        psql(`INSERT INTO position_guards (agent_id, symbol, entry_price, entry_qty, stop_loss)
              VALUES ('${id}','AAPL',100,1,90)`);
        return true;
      } catch (e) { return false; }
    })(), 're-entering a position could not be re-guarded');
  }

  // =====================================================================
  // THE COLLISION. Two processes, one agent, the same instant.
  //
  // Not a simulation of contention: two real Go programs using the real store
  // against the real database, started together and racing for the same lease.
  console.log('\n=== One intent, one transaction: the lease, under a real race ===');
  {
    const id = await freshAgent('lease');
    // BUILT FROM THE REPOSITORY, not written here. Go forbids importing an
    // internal/ package from outside its module, and using the real store is
    // the point: a race against a reimplementation of the lease would prove
    // something about the reimplementation. See cmd/leaserace.
    const RACE = `${REPO}/.guard-verify-race`;
    // Remove whatever is at that path first: an earlier failed run left a
    // DIRECTORY there, go build wrote into it happily, and spawn then failed
    // with EACCES on a path that looked like a binary.
    execFileSync('bash', ['-lc', `rm -rf ${RACE}`]);
    execFileSync(GO, ['build', '-o', RACE, './cmd/leaserace'], {
      cwd: `${REPO}/services/decision-engine`, stdio: 'pipe',
    });
    const DB = 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';
    const runRace = () => new Promise((resolve) => {
      const at = new Date(Date.now() + 1500).toISOString();
      const out = [];
      let done = 0;
      for (const holder of ['cycle', 'guard']) {
        const p = spawn(`${RACE}`, [id, holder, at], { env: { ...process.env, DATABASE_URL: DB } });
        // AN UNHANDLED 'error' EVENT KILLS THE PROCESS WITHOUT RUNNING finally.
        // The first run of this suite hit EACCES here, died on the event, and
        // left two ARMED guards and their agent in the live database -- which
        // the running watcher then picked up and counted. Same family as the
        // process.exit-skips-finally bug in cost-budget-verify: a failing
        // verification must never leave state behind for production to act on.
        p.on('error', (e) => { buf += 'ERR ' + e.message; if (++done === 2) resolve(out.concat(buf.trim())); });
        let buf = '';
        p.stdout.on('data', (c) => (buf += c));
        p.stderr.on('data', (c) => (buf += c));
        p.on('close', () => { out.push(buf.trim()); if (++done === 2) resolve(out); });
      }
    });

    // Run it several times: a race that only ever resolves one way might be
    // resolving on start order rather than on the lease.
    const winners = [];
    for (let i = 0; i < 5; i++) {
      psql(`DELETE FROM agent_execution_leases WHERE agent_id = '${id}'`);
      const out = await runRace();
      const acquired = out.filter((l) => l.startsWith('ACQUIRED'));
      const held = out.filter((l) => l.startsWith('HELD'));
      if (i === 0) console.log(`      round 1: ${out.join(' / ')}`);
      check(`round ${i + 1}: exactly one actor acquired the lease`,
        acquired.length === 1 && held.length === 1, out.join(' / '));
      if (acquired.length === 1) winners.push(acquired[0].split(' ')[1]);
      check(`round ${i + 1}: the loser was told who holds it, and did not wait`,
        held.length === 1 && /by (cycle|guard) true/.test(held[0]), held.join(' / '));
    }
    // THE CONTROL. If one side always won, the race is being decided by
    // something other than the lease and this suite is measuring start order.
    check('and it is a real race, not a fixed order',
      new Set(winners).size > 1 || winners.length === 0,
      `the same actor won all ${winners.length} rounds: ${winners.join(',')}`);
    console.log(`      winners across rounds: ${winners.join(', ')}`);

    // An expired lease must not block forever: a holder that dies mid-swap is
    // exactly the case the expiry exists for.
    psql(`DELETE FROM agent_execution_leases WHERE agent_id = '${id}'`);
    psql(`INSERT INTO agent_execution_leases (agent_id, holder, acquired_at, expires_at)
          VALUES ('${id}','cycle', now() - interval '10 minutes', now() - interval '5 minutes')`);
    const out = await runRace();
    check('an EXPIRED lease is taken over rather than honoured',
      out.filter((l) => l.startsWith('ACQUIRED')).length === 1, out.join(' / '));
    execFileSync('bash', ['-lc', `rm -f ${RACE}`]);
  }

  // =====================================================================
  console.log('\n=== A dead watcher looks different from a quiet one ===');
  {
    const WD = `${REPO}/infra/alerting/arcana-guard-watchdog.sh`;
    const run = (env) => {
      try {
        return execFileSync('bash', [WD], {
          encoding: 'utf8',
          env: { ...process.env, WATCHDOG_DRY_RUN: '1', ARCANA_DIR: REPO, ...env },
        });
      } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); }
    };

    // Save whatever is really there, so this suite cannot leave a false
    // heartbeat behind for the watchdog to read later.
    const saved = psql(`SELECT count(*) FROM guard_heartbeat`);
    psql(`INSERT INTO guard_heartbeat (id, last_scan_at, scans, armed_guards, triggers, version)
          VALUES (1, now(), 10, 1, 0, 'verify')
          ON CONFLICT (id) DO UPDATE SET last_scan_at = now(), last_error = NULL, version = 'verify'`);

    // FORCED TO ZERO, because this case is about the heartbeat and the live
    // database may hold a genuinely unprotected position — it does. Leaving it
    // unforced would make this case fail for a reason it is not about.
    const fresh = run({ WATCHDOG_FORCE_UNIT: 'active', WATCHDOG_FORCE_UNGUARDED: '0' });
    check('a fresh heartbeat with an active unit is healthy',
      /VERDICT=healthy/.test(fresh), fresh.trim().split('\n').slice(-2).join(' | '));

    const stale = run({ WATCHDOG_FORCE_AGE: '600', WATCHDOG_FORCE_UNIT: 'active' });
    check('a stale heartbeat alarms even while the unit is ACTIVE',
      /WOULD ALERT/.test(stale) && /VERDICT=alerted/.test(stale), stale.trim().split('\n').slice(-2).join(' | '));
    check('and it says the process is running but not scanning',
      /ACTIVE, so the process is running and is NOT completing scans/.test(stale),
      'the alert does not distinguish wedged from crashed');

    const dead = run({ WATCHDOG_FORCE_AGE: '600', WATCHDOG_FORCE_UNIT: 'inactive' });
    check('a stale heartbeat with a dead unit alarms too', /VERDICT=alerted/.test(dead), dead.slice(-200));
    check('and it says the process is not running',
      /The process is not running/.test(dead), 'the two failures read the same');

    const failing = run({ WATCHDOG_FORCE_ERROR: 'quote GOOGL: rpc timeout', WATCHDOG_FORCE_UNIT: 'active' });
    check('alive-and-failing is its own alarm, not silence',
      /VERDICT=alerted/.test(failing) && /scanning and failing/.test(failing),
      failing.trim().split('\n').slice(-2).join(' | '));

    const ghost = run({ WATCHDOG_FORCE_UNIT: 'inactive' });
    check('a fresh heartbeat with no running guard alarms',
      /VERDICT=alerted/.test(ghost) && /without a running guard/.test(ghost), ghost.slice(-200));

    // A LEVEL CROSSED AND NOT ACTED ON is the quietest failure of all: the
    // watcher is alive, scanning, and reporting no error, because refusing is
    // not an error. From outside it looks exactly like a level nothing has
    // reached.
    const gid = await freshAgent('refused').then((id) => {
      psql(`INSERT INTO position_guards (agent_id, symbol, entry_price, entry_qty, stop_loss,
              last_refusal_at, last_refusal_reason)
            VALUES ('${id}','AAPL',100,1,95, now() - interval '3 minutes', 'cost_budget_exceeded')`);
      return id;
    });
    const refused = run({ WATCHDOG_FORCE_UNIT: 'active', WATCHDOG_FORCE_UNGUARDED: '0' });
    check('a level that fired and was refused alarms, even with a healthy watcher',
      /VERDICT=alerted/.test(refused) && /exit was refused/.test(refused),
      refused.trim().split(String.fromCharCode(10)).slice(-2).join(' | '));
    // THE OWNER IS PART OF THE NAME NOW. One agent's levels can watch several
    // wallets — its creator's and one per subscriber — so the alert says which,
    // and an owner is no longer sent to look at a position that is not theirs.
    check('and the alert names the symbol, whose wallet, and the reason',
      /AAPL \[creator\] cost_budget_exceeded/.test(refused), refused.slice(-400));
    psql(`DELETE FROM position_guards WHERE agent_id = '${gid}'`);

    // THE CONTROL: with the refusal cleared, the same healthy watcher is quiet.
    const quiet = run({ WATCHDOG_FORCE_UNIT: 'active', WATCHDOG_FORCE_UNGUARDED: '0' });
    check('and with nothing refused it goes back to healthy',
      /VERDICT=healthy/.test(quiet), quiet.trim().split(String.fromCharCode(10)).slice(-1).join(''));

    if (saved === '0') psql(`DELETE FROM guard_heartbeat WHERE id = 1`);
    else psql(`UPDATE guard_heartbeat SET version = NULL, last_error = NULL WHERE id = 1 AND version = 'verify'`);
  }

  console.log('\n' + '='.repeat(40));
  console.log(`  PASS: ${pass}   FAIL: ${fail}`);
  console.log('='.repeat(40));
  if (fail > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    exitCode = 1;
  } else {
    console.log('guard-verify: the collision was made to happen, and one intent stayed one transaction.');
  }
} finally {
  for (const id of made) {
    for (const sql of [
      `DELETE FROM position_guards WHERE agent_id = '${id}'`,
      `DELETE FROM agent_execution_leases WHERE agent_id = '${id}'`,
      `DELETE FROM decisions WHERE agent_id = '${id}'`,
      `DELETE FROM portfolio_snapshots WHERE portfolio_id IN (SELECT id FROM portfolios WHERE agent_id = '${id}')`,
      `DELETE FROM portfolios WHERE agent_id = '${id}'`,
      `DELETE FROM agents WHERE id = '${id}'`,
    ]) { try { psql(sql); } catch {} }
  }
  // A SWEEP BY NAME, not only by the ids this run happens to remember. A run
  // that died before recording an id would otherwise leave an armed guard in
  // the live database, and the watcher acts on armed guards.
  try {
    psql(`DELETE FROM position_guards WHERE agent_id IN (SELECT a.id FROM agents a JOIN creators c ON c.id = a.creator_id WHERE c.handle LIKE 'guard\_%')`);
    psql(`DELETE FROM agent_execution_leases WHERE agent_id IN (SELECT a.id FROM agents a JOIN creators c ON c.id = a.creator_id WHERE c.handle LIKE 'guard\_%')`);
    psql(`DELETE FROM decisions WHERE agent_id IN (SELECT a.id FROM agents a JOIN creators c ON c.id = a.creator_id WHERE c.handle LIKE 'guard\_%')`);
    psql(`DELETE FROM portfolio_snapshots WHERE portfolio_id IN (SELECT p.id FROM portfolios p JOIN agents a ON a.id = p.agent_id JOIN creators c ON c.id = a.creator_id WHERE c.handle LIKE 'guard\_%')`);
    psql(`DELETE FROM portfolios WHERE agent_id IN (SELECT a.id FROM agents a JOIN creators c ON c.id = a.creator_id WHERE c.handle LIKE 'guard\_%')`);
    psql(`DELETE FROM agents WHERE creator_id IN (SELECT id FROM creators WHERE handle LIKE 'guard\_%')`);
    psql(`DELETE FROM creators WHERE handle LIKE 'guard\_%'`);
  } catch (e) { console.log('  WARNING: the fixture sweep failed: ' + e.message); }
  console.log('guard-verify: fixtures removed');
}
process.exit(exitCode);
