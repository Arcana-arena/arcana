/**
 * lib/fixtures.mjs — remove what a verification run created, by its mark.
 *
 * WHY A SWEEP AND NOT A LIST OF IDS. Every suite here already tracked what it
 * made and deleted it in a `finally`. It did not work, and the reason is
 * specific: `process.exit()` SKIPS `finally`. prompt-injection-verify,
 * cost-meter-verify and subscription-verify each have a cleanup block and each
 * also calls process.exit on a failure path, so the runs that failed — exactly
 * the runs that leave the most behind — never reached their own cleanup.
 * auth-verify had no cleanup at all and relied on a hand-run .sql file, which is
 * to say it relied on somebody remembering: 42 agents and 81 creators later,
 * nobody had.
 *
 * A sweep keyed on the MARK rather than on ids collected in memory is
 * self-healing. It does not care which run made the row or whether that run
 * lived long enough to tidy up: the next suite to finish removes whatever the
 * last one abandoned.
 *
 * WHAT IT REFUSES TO TOUCH, and why there are two conditions and not one.
 *
 * The mark says a row came from the verification path. That is the first
 * condition. The second is independent of it: nothing is deleted that holds a
 * wallet, has ever executed on chain, or holds a seat in a competition. Either
 * condition alone would be enough on a good day. Together they mean the sweep
 * still does no harm on a bad one — if the mark were ever wrong about a real
 * agent, custody would still stop the delete.
 *
 * That is not hypothetical. The agent named `Phase 8c buy leg`, under a creator
 * named `phase8_operator`, reads exactly like a leftover fixture and holds the
 * only wallet still trading. The old name-matching cleanup would have taken it.
 */
import { execFileSync } from 'node:child_process';

const PG = process.env.PG_CONTAINER || 'arcana-postgres';
const psql = (sql) =>
  execFileSync('docker', ['exec', PG, 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc', sql],
    { encoding: 'utf8' }).trim();

/**
 * The agents a sweep may remove. Marked, and holding nothing that matters.
 * Written once and used by both the listing and the delete, so the two can
 * never drift apart.
 */
const DELETABLE_AGENTS = `
  SELECT a.id
    FROM agents a
   WHERE a.provenance = 'verification'
     AND NOT EXISTS (SELECT 1 FROM agent_wallets w WHERE w.agent_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM executions e WHERE e.agent_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM competitions c WHERE a.id = ANY(c.participant_ids))`;

/**
 * Run the sweep however the process ends.
 *
 * THIS IS WHY IT IS SYNCHRONOUS. `finally` is the obvious place for cleanup and
 * it is the place that failed: process.exit() skips it, and a verification suite
 * exits that way precisely when it has failed. Node's 'exit' event fires for
 * process.exit(), for the event loop emptying, and after an uncaught throw — but
 * it allows no async work, so a cleanup that awaits anything cannot live there.
 * Everything here goes through execFileSync for that reason alone.
 *
 * Call it once, near the top of a suite. It needs no list of what to remove,
 * because the mark is the list.
 */
export function sweepOnExit(label = '') {
  process.on('exit', () => {
    try {
      sweepFixtures({ quiet: false });
    } catch (e) {
      // A cleanup that throws inside an exit handler would replace the suite's
      // own result with a stack trace. Say what happened and let the real exit
      // code stand.
      console.log(`  fixtures: sweep failed${label ? ` (${label})` : ''}: ${e && e.message}`);
    }
  });
}

/** What the sweep would remove, without removing it. */
export function listFixtures() {
  const agents = psql(`
    SELECT a.id::text || '|' || a.name || '|' || a.status || '|' || coalesce(c.handle,'(none)')
      FROM agents a LEFT JOIN creators c ON c.id = a.creator_id
     WHERE a.id IN (${DELETABLE_AGENTS})
     ORDER BY a.created_at`).split(/\r?\n/).filter(Boolean)
    .map((l) => {
      const [id, name, status, handle] = l.split('|');
      return { id, name, status, handle };
    });

  // Marked, but held back by the custody condition. Listing these separately is
  // the point: a row that is marked and NOT deletable is either a suite that
  // left something real behind, or a mark that is wrong. Both want looking at.
  const held = psql(`
    SELECT a.name || '|' || coalesce(c.handle,'(none)') || '|' ||
           (SELECT count(*) FROM agent_wallets w WHERE w.agent_id = a.id) || '|' ||
           (SELECT count(*) FROM executions e WHERE e.agent_id = a.id) || '|' ||
           (SELECT count(*) FROM competitions comp WHERE a.id = ANY(comp.participant_ids))
      FROM agents a LEFT JOIN creators c ON c.id = a.creator_id
     WHERE a.provenance = 'verification' AND a.id NOT IN (${DELETABLE_AGENTS})`)
    .split(/\r?\n/).filter(Boolean)
    .map((l) => {
      const [name, handle, wallets, execs, comps] = l.split('|');
      return { name, handle, wallets: +wallets, execs: +execs, comps: +comps };
    });

  const creators = Number(psql(`
    SELECT count(*) FROM creators c
     WHERE c.provenance = 'verification'
       AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.creator_id = c.id AND a.id NOT IN (${DELETABLE_AGENTS}))`));

  return { agents, held, creators };
}

/**
 * Remove them. Dependents first, because the foreign keys say so.
 *
 * Returns what it did. Silent success is not a thing this repository keeps.
 */
export function sweepFixtures({ quiet = false } = {}) {
  const before = listFixtures();
  if (before.agents.length === 0 && before.creators === 0) {
    if (!quiet) console.log('  fixtures: nothing marked for removal');
    return { agents: 0, creators: 0, held: before.held };
  }

  // One statement, one transaction: a sweep that half-ran would leave rows whose
  // agent is gone, which is a worse mess than the one it was clearing.
  psql(`
    BEGIN;
    CREATE TEMP TABLE doomed ON COMMIT DROP AS ${DELETABLE_AGENTS};
    DELETE FROM agent_dna            WHERE agent_id IN (SELECT id FROM doomed);
    DELETE FROM score_snapshots      WHERE agent_id IN (SELECT id FROM doomed);
    -- Allowed only because these agents are marked as verification (0049).
    DELETE FROM score_input_seals    WHERE agent_id IN (SELECT id FROM doomed);
    DELETE FROM decision_artefacts   WHERE agent_id IN (SELECT id FROM doomed);
    -- Before agents (FK), and allowed only because these agents are marked as
    -- verification: the trigger in 0047 refuses deleting a real disclosure.
    DELETE FROM intelligence_disclosures WHERE agent_id IN (SELECT id FROM doomed);
    DELETE FROM decisions_counted    WHERE agent_id IN (SELECT id FROM doomed);
    DELETE FROM position_guards      WHERE agent_id IN (SELECT id FROM doomed);
    DELETE FROM marketplace_listings WHERE agent_id IN (SELECT id FROM doomed);
    DELETE FROM subscriptions        WHERE agent_id IN (SELECT id FROM doomed);
    DELETE FROM custody_drift        WHERE agent_id IN (SELECT id FROM doomed);
    DELETE FROM agent_execution_leases WHERE agent_id IN (SELECT id FROM doomed);
    -- articles.agent_id is RESTRICT (0056), so an article naming a doomed agent
    -- would fail the DELETE below and roll back this entire sweep -- taking
    -- every suite's cleanup with it, for one fixture nobody thought about.
    --
    -- ONLY A FIXTURE AUTHOR'S ARTICLE IS REMOVED. An article by a real creator
    -- bound to a marked agent is left alone deliberately: it then blocks the
    -- sweep, the sweep says so, and that is the correct noise to make. The
    -- alternative is a sweep that deletes a person's writing because something
    -- it was about was marked as a fixture.
    -- Comments, likes and reports under these articles go with them: every one
    -- of those references articles ON DELETE CASCADE (0056), so they need no
    -- line of their own here.
    DELETE FROM articles WHERE agent_id IN (SELECT id FROM doomed)
       AND creator_id IN (SELECT id FROM creators WHERE provenance = 'verification');
    DELETE FROM portfolio_snapshots
     WHERE portfolio_id IN (SELECT id FROM portfolios WHERE agent_id IN (SELECT id FROM doomed));
    DELETE FROM portfolios           WHERE agent_id IN (SELECT id FROM doomed);
    DELETE FROM decisions            WHERE agent_id IN (SELECT id FROM doomed);
    DELETE FROM agents               WHERE id IN (SELECT id FROM doomed);
    DELETE FROM creators c
     WHERE c.provenance = 'verification'
       AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.creator_id = c.id);
    COMMIT;`);

  const after = listFixtures();
  const removedAgents = before.agents.length - after.agents.length;
  const removedCreators = before.creators - after.creators;
  if (!quiet) {
    console.log(`  fixtures: removed ${removedAgents} agent(s) and ${removedCreators} creator(s)`);
    for (const h of before.held) {
      console.log(`  fixtures: KEPT ${h.name} (${h.handle}) — ${h.wallets} wallet(s), ` +
        `${h.execs} execution(s), ${h.comps} competition seat(s). Marked as a fixture and ` +
        'holding something real: worth a look either way.');
    }
  }
  return { agents: removedAgents, creators: removedCreators, held: before.held };
}
