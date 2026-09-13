/**
 * leaderboard-verify.mjs — the ranked list, and the things it must not flatten.
 *
 * WHY A WHOLE SUITE FOR ONE ENDPOINT. A leaderboard is the surface where every
 * distinction this platform draws can quietly collapse into a number: an agent
 * that has not competed looks like an agent that competed badly, a placeholder
 * looks like a measurement, and a list that is not really sorted looks exactly
 * like one that is.
 *
 * THE LESSON FROM seasons-verify APPLIES DIRECTLY. Proving a number is not a
 * stub is not checking that it exists, because 0 exists and so does rank 1. Two
 * things are required and both are here:
 *
 *   1. compute the ordering a SECOND way, straight from score_snapshots, and
 *      require the endpoint to agree; and
 *   2. require the orderings to DIFFER between categories. Seven tabs that all
 *      return the same order is precisely what a stub returns, and check (1)
 *      alone would pass it every time the database happened to agree.
 *
 * Reads only. No session, no writes, nothing it could spend.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { req } from './lib/rate-aware.mjs';
import { suite } from './lib/sections.mjs';

const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const REPO = process.env.REPO || '/home/ubuntu/arcana';
const PG = process.env.PG_CONTAINER || 'arcana-postgres';
const psql = (s) => execFileSync('docker',
  ['exec', PG, 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc', s], { encoding: 'utf8' }).trim();

const { check, section, nothingToCheck, report } = suite('leaderboard-verify');

// The season with the most scored agents: the one that can actually exercise a
// ranking. Chosen from the data rather than hardcoded.
const SEASON = psql(
  `SELECT season_id::text FROM score_snapshots GROUP BY season_id ORDER BY count(*) DESC LIMIT 1`);

const get = (q) => req(`${AGENT}/v1/leaderboard?${q}`);

const board = await get(`season_id=${SEASON}&page_size=50`);

await section('It answers, publicly, and says what it is a leaderboard of', async () => {
  check('GET /v1/leaderboard is reachable without a session', board.status === 200,
    `status ${board.status} ${JSON.stringify(board.body).slice(0, 160)}`);
  if (board.status !== 200) {
    nothingToCheck('nothing below can run against a response that did not arrive');
    return;
  }
  check('it names the season it ranked', board.body?.season?.id === SEASON,
    `season = ${JSON.stringify(board.body?.season)}`);
  check('and the category it sorted by', typeof board.body?.category === 'string',
    `category = ${JSON.stringify(board.body?.category)}`);
  check('it returns rows', Array.isArray(board.body?.items) && board.body.items.length > 0,
    `${board.body?.items?.length} items`);
});

await section('Seven categories, and the eighth is refused rather than ignored', async () => {
  const cats = board.body?.categories ?? [];
  const keys = cats.map((c) => c.key);
  // RANKABLE is the property that matters, not presence in the list.
  //
  // These two checks used to be "exactly seven categories" and "regime is NOT
  // offered", and they were right about the intent and wrong about the shape.
  // Leaving regime out of the list entirely made the score breakdown's weight
  // column sum to 0.90, with the missing tenth being the one factor that
  // measures nothing. It is in the list now, carrying its weight and marked
  // unrankable — so the assertion moved from "is it absent" to "can it order a
  // board", which is what was actually being protected.
  const rankable = cats.filter((c) => c.rankable !== false).map((c) => c.key);
  check('exactly seven rankable categories are offered', rankable.length === 7,
    `rankable: ${rankable.join(', ')}`);
  for (const want of ['overall', 'performance', 'risk', 'consistency', 'strategy', 'longevity', 'creator']) {
    check(`${want} is one of them`, rankable.includes(want), `rankable: ${rankable.join(', ')}`);
  }

  // THE ONE THAT MATTERS. regime_score is a flat placeholder the scoring engine
  // writes identically for every agent. Ordering by it would present a constant
  // as a measurement.
  check('regime is NOT rankable', !rankable.includes('regime') && !rankable.includes('regime_score'),
    `rankable: ${rankable.join(', ')}`);
  check('and it is published with its weight rather than hidden',
    cats.some((c) => c.key === 'regime' && typeof c.weight === 'number'),
    `regime = ${JSON.stringify(cats.find((c) => c.key === 'regime'))}`);
  check('and it says it measures nothing',
    /placeholder|not implemented|constant/i.test(cats.find((c) => c.key === 'regime')?.weight_note ?? ''),
    JSON.stringify(cats.find((c) => c.key === 'regime')?.weight_note));

  const regime = await get(`season_id=${SEASON}&category=regime`);
  check('and asking for it is REFUSED, not quietly defaulted', regime.status === 400,
    `status ${regime.status}, category came back as ` +
    `${JSON.stringify(regime.body?.category)} — a silent fallback is how a client ` +
    'believes it asked for something it did not get');

  const nonsense = await get(`season_id=${SEASON}&category=banana`);
  check('an unknown category is refused too', nonsense.status === 400, `status ${nonsense.status}`);

  check('the response says why regime is absent rather than leaving a gap',
    typeof board.body?.regime_note === 'string' && /placeholder|constant|not implemented/i.test(board.body.regime_note),
    `regime_note = ${JSON.stringify(board.body?.regime_note)?.slice(0, 120)}`);
});

// The same ordering, computed a second way, straight from the table.
const truthFor = (column) => psql(`
  SELECT string_agg(agent_id::text, ',' ORDER BY ord)
    FROM (
      SELECT l.agent_id,
             -- SAME TOTAL ORDER AS THE ENDPOINT, DOWN TO THE LAST TIEBREAK.
             -- Leaving agent_id off here is how this check found the bug: two
             -- agents share a score and a name, both queries were free to
             -- order them either way, and the two disagreed. That disagreement
             -- was the finding — an ordering that is not total is not stable
             -- across pages either.
             row_number() OVER (ORDER BY l.${column} DESC NULLS LAST, a.name ASC, l.agent_id ASC) AS ord
        FROM (SELECT DISTINCT ON (agent_id) * FROM score_snapshots
               WHERE season_id = '${SEASON}' ORDER BY agent_id, ts DESC) l
        JOIN agents a ON a.id = l.agent_id
       WHERE l.arcana_score IS NOT NULL
    ) x`).split(',').filter(Boolean);

const COLUMN_OF = {
  overall: 'arcana_score', performance: 'performance_score', risk: 'risk_score',
  consistency: 'consistency_score', strategy: 'strategy_score',
  longevity: 'longevity_score', creator: 'creator_score',
};

const ordersSeen = {};

await section('Every category ranks in the order the database ranks it', async () => {
  for (const [cat, column] of Object.entries(COLUMN_OF)) {
    const r = await get(`season_id=${SEASON}&category=${cat}&page_size=50`);
    if (r.status !== 200) {
      check(`${cat} answers`, false, `status ${r.status}`);
      continue;
    }
    const got = r.body.items.filter((i) => i.ranked).map((i) => i.agent_id);
    const want = truthFor(column);
    ordersSeen[cat] = got.join(',');
    check(`${cat} matches the ordering computed straight from score_snapshots`,
      got.join(',') === want.join(','),
      `endpoint: ${got.map((x) => x.slice(0, 8)).join(' ')} | database: ${want.map((x) => x.slice(0, 8)).join(' ')}`);
    // TIES SHARE A RANK, AND THAT IS CORRECT. longevity_score is 100 for every
    // agent that has been in the season since it opened, so rank() returns
    // 1,2,2,4 — standard competition ranking. The first version of this check
    // demanded dense 1..n and failed here, and the CHECK was what was wrong:
    // dense numbering would force the endpoint to invent an order between
    // agents the data says are equal, which is the opposite of what this suite
    // exists to protect.
    const ranked = r.body.items.filter((i) => i.ranked);
    const ranks = ranked.map((i) => i.rank);
    check(`${cat} starts at rank 1`, ranks[0] === 1, ranks.join(','));
    check(`${cat} never ranks a later row above an earlier one`,
      ranks.every((v, n) => n === 0 || v >= ranks[n - 1]), ranks.join(','));
    // A DEAD HEAT READS AS A DEAD HEAT. The rank window orders by the score
    // ALONE. The row order still breaks ties by name — a list needs one order
    // and paging has to be deterministic — but the RANK must not inherit that
    // tiebreak, because then two agents on an identical 100 would be printed
    // "1st" and "2nd" and the page would be asserting a difference the data
    // does not contain.
    //
    // THIS CHECK WAS REMOVED ONCE AND WAS RIGHT THE WHOLE TIME. It failed
    // against an implementation that carried agent_name inside the window, and
    // the failure was read as the check being wrong about the contract. It was
    // the contract that was wrong. It is restored here unchanged in intent,
    // now testing the behaviour that should hold.
    //
    // (The check that was dropped for good demanded dense 1..n, which would
    // force the endpoint to invent an order between agents the data says are
    // equal — the opposite of this one.)
    const key = (i) => String(i.score);
    check(`${cat} gives an identical score an identical rank`,
      ranked.every((i, n) => n === 0 ||
        ((key(i) === key(ranked[n - 1])) === (i.rank === ranked[n - 1].rank))),
      ranked.map((i) => `${i.rank}:${i.score}:${i.agent_name}`).join('  '));
    // AND THE NEXT ONE SKIPS. rank(), not dense_rank(): after two firsts the
    // next agent is 3rd, so a rank still answers "how many are ahead of me".
    // Computed the second way — a row's rank is the position of the FIRST row
    // sharing its score — so a shared rank that failed to skip is caught too.
    check(`${cat} skips after a tie, so a rank still counts the agents ahead`,
      ranked.every((i) => i.rank === ranked.findIndex((x) => key(x) === key(i)) + 1),
      ranked.map((i) => `${i.rank}:${i.score}`).join('  '));
    const tied = ranked.filter((i, n) => n > 0 && key(i) === key(ranked[n - 1])).length;
    if (tied === 0) {
      console.log(`      NOTE  ${cat} has no two agents on the same score right now, so ` +
        'this run cannot tell tie-sharing from a name tiebreak');
    }
  }
});

await section('The seven tabs are not seven copies of one list', async () => {
  const distinct = new Set(Object.values(ordersSeen));
  if (Object.keys(ordersSeen).length < 2) {
    nothingToCheck('fewer than two categories answered, so there is nothing to compare');
    return;
  }
  // A CONSTANT IS WHAT A STUB RETURNS. Agreeing with the database would not
  // catch an endpoint that sorts by one column and labels it seven ways,
  // because the database would agree with it seven times.
  check('at least two categories produce a different ordering', distinct.size >= 2,
    `all ${Object.keys(ordersSeen).length} categories returned the identical order — ` +
    'either the data is degenerate or the category parameter is not being applied');
  for (const [cat, ord] of Object.entries(ordersSeen)) {
    console.log(`      ${cat.padEnd(12)} ${ord.split(',').map((x) => x.slice(0, 8)).join(' ')}`);
  }
});

await section('An unranked agent is absent, not last', async () => {
  // LOOK WHERE THE EVIDENCE IS. The season chosen for ordering is the busiest
  // one, and it may happen to hold no withheld agent. Any season with one will
  // prove the withholding, and which season that is gets printed rather than
  // quietly assumed.
  const UNSEASON = psql(`
    SELECT l.season_id::text FROM (SELECT DISTINCT ON (agent_id, season_id) *
      FROM score_snapshots ORDER BY agent_id, season_id, ts DESC) l
     WHERE l.arcana_score IS NULL GROUP BY l.season_id ORDER BY count(*) DESC LIMIT 1`);
  const unrankedInDb = UNSEASON ? 1 : 0;
  if (unrankedInDb === 0) {
    nothingToCheck('every scored agent in this season is ranked, so the withheld case ' +
      'has nothing real to show');
    return;
  }
  console.log(`      withheld agents found in season ${UNSEASON.slice(0, 8)}`);
  const without = await get(`season_id=${UNSEASON}&page_size=50`);
  const withThem = await get(`season_id=${UNSEASON}&page_size=50&include_unranked=true`);
  check('by default the unranked are left out', (without.body?.items ?? []).every((i) => i.ranked),
    `${(without.body?.items ?? []).filter((i) => !i.ranked).length} unranked rows appeared by default`);
  check('include_unranked brings them back', withThem.body.items.length > without.body.items.length,
    `${without.body.items.length} -> ${withThem.body.items.length}`);

  const un = withThem.body.items.filter((i) => !i.ranked);
  check('they carry no rank at all, rather than a bad one', un.every((i) => i.rank === null),
    `ranks: ${un.map((i) => i.rank).join(',')}`);
  // THE DISTINCTION THE WHOLE FIELD EXISTS FOR: not competed, versus competed
  // badly. A reader must be able to tell those apart.
  check('and a reason that names the threshold, not a low score',
    un.every((i) => typeof i.unranked_note === 'string' && /decision/i.test(i.unranked_note)),
    `note: ${JSON.stringify(un[0]?.unranked_note)?.slice(0, 140)}`);
  check('the counts add up', withThem.body.total_ranked + withThem.body.total_unranked === withThem.body.total,
    `${withThem.body.total_ranked} + ${withThem.body.total_unranked} != ${withThem.body.total}`);
  console.log(`      ${un.length} withheld: ${un.map((i) => i.agent_name).join(', ')}`);
});

await section('The threshold is the scoring engine\'s, not a copy of it', async () => {
  // The Go constant is the authority: below it the engine writes NULL, and that
  // NULL is what every reader here is describing. If the TypeScript side drifts,
  // an agent is ranked by one surface and withheld by another with no error.
  const go = readFileSync(`${REPO}/services/scoring-engine/internal/engine/score.go`, 'utf8');
  const m = go.match(/minParticipationDecisions\s*=\s*(\d+)/);
  check('the scoring engine states a participation threshold', !!m, 'not found in score.go');
  if (!m) return;
  check('and the leaderboard reports the same number',
    board.body?.threshold_decisions === Number(m[1]),
    `score.go says ${m[1]}, the endpoint reports ${JSON.stringify(board.body?.threshold_decisions)}`);
  console.log(`      score.go minParticipationDecisions = ${m[1]}`);
});

await section("The weights are the scoring engine's, not a copy of them", async () => {
  // SAME ARRANGEMENT AS THE THRESHOLD ABOVE, for the same reason. The weights
  // are declared in Go and repeated once in TypeScript so the read surface has
  // one place to be wrong. Nothing would notice them drifting: every score on
  // the page would still be the engine's, and only the breakdown beside it
  // would be explaining the total with the wrong arithmetic.
  const go = readFileSync(`${REPO}/services/scoring-engine/internal/engine/score.go`, 'utf8');
  const want = {};
  for (const [name, key] of [
    ['wPerformance', 'performance'], ['wRisk', 'risk'], ['wConsistency', 'consistency'],
    ['wRegime', 'regime'], ['wCreator', 'creator'], ['wLongevity', 'longevity'],
  ]) {
    // `\\s`, not `\s`. In a JavaScript string literal '\s' is an unknown escape
    // and collapses to a bare 's', so the pattern became `wPerformances*=s*…`
    // and matched nothing — and the check reported "found none" as though
    // score.go had no weights at all.
    const m = go.match(new RegExp(name + '\\s*=\\s*([0-9.]+)'));
    if (m) want[key] = Number(m[1]);
  }
  check('score.go declares six weights', Object.keys(want).length === 6,
    `found ${Object.keys(want).join(', ') || 'none'}`);
  if (Object.keys(want).length !== 6) return;

  check('and they sum to 1.0 in the engine',
    Math.abs(Object.values(want).reduce((a, b) => a + b, 0) - 1) < 1e-9,
    `they sum to ${Object.values(want).reduce((a, b) => a + b, 0)}`);

  const got = Object.fromEntries(
    (board.body?.categories ?? []).filter((c) => c.weight !== null && c.weight !== undefined)
      .map((c) => [c.key, c.weight]));
  const wrong = Object.entries(want)
    .filter(([k, v]) => Math.abs((got[k] ?? -1) - v) > 1e-9)
    .map(([k, v]) => `${k}: score.go ${v}, endpoint ${JSON.stringify(got[k])}`);
  check('the endpoint publishes the same six weights', wrong.length === 0, wrong.join('; '));

  // STRATEGY MUST NOT BE PUBLISHED AS A WEIGHT. It is a multiplier on the
  // total; showing it as a seventh term would tell a reader it trades off
  // against performance, which it does not.
  const strategy = (board.body?.categories ?? []).find((c) => c.key === 'strategy');
  check('strategy is offered as a category but carries no weight',
    strategy && (strategy.weight === null || strategy.weight === undefined),
    `strategy weight = ${JSON.stringify(strategy?.weight)}`);
  check('and it says why', typeof strategy?.weight_note === 'string' && /multiplier/i.test(strategy.weight_note),
    JSON.stringify(strategy?.weight_note));
  console.log(`      score.go weights: ${Object.entries(want).map(([k, v]) => k + '=' + v).join(' ')}`);
});

await section('Paging continues the ranking rather than restarting it', async () => {
  const total = board.body?.total ?? 0;
  if (total < 3) {
    nothingToCheck(`only ${total} ranked agent(s) in this season, so there is no second page`);
    return;
  }
  const p1 = await get(`season_id=${SEASON}&page_size=2&page=1`);
  const p2 = await get(`season_id=${SEASON}&page_size=2&page=2`);
  check('page 1 starts at rank 1', p1.body?.items?.[0]?.rank === 1, `${p1.body?.items?.[0]?.rank}`);
  // NOT "page 2 opens at rank 3". That was hardcoded, and it was only right
  // while no two agents tied: once ties share a rank, the third row can legally
  // be rank 1. The property that actually matters is that an agent's rank is
  // the same number wherever it is read — it belongs to the season, not to the
  // page — so it is compared against the rank the same agent carries in the
  // unpaged list.
  const rankOf = (id) => board.body?.items?.find((i) => i.agent_id === id)?.rank;
  const opener = p2.body?.items?.[0];
  check('page 2 carries the rank that agent has in the whole season',
    opener && opener.rank === rankOf(opener.agent_id),
    `page 2 opens with ${opener?.agent_name} at rank ${opener?.rank}; the unpaged list ` +
    `puts it at ${rankOf(opener?.agent_id)} — a rank that restarts per page is a rank of ` +
    'the page, not of the season');
  // AND THE CHECK ABOVE HAS TO BE ABLE TO FAIL. If the agent opening page 2 is
  // itself on rank 1 — three agents tied at the top — then "same as unpaged"
  // and "restarted at 1" are the same number and the comparison proves nothing.
  // That is stated rather than counted as a pass.
  if (rankOf(opener?.agent_id) === 1) {
    nothingToCheck('the agent opening page 2 is tied for first, so a per-page rank and a ' +
      'per-season rank would both read 1 here and this run cannot separate them');
  } else {
    check('and it is not 1, which is what a rank restarted per page would read',
      opener.rank > 1, `rank ${opener?.rank}`);
  }
  check('and the two pages hold different agents',
    p1.body?.items?.[0]?.agent_id !== p2.body?.items?.[0]?.agent_id, 'the same agent on both pages');
});

const code = report();
if (code !== 0) process.exit(code);
console.log('leaderboard-verify: seven orderings, each the one the database gives, and the eighth refused.');
