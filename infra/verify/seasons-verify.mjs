/**
 * seasons-verify.mjs — the arena list a browsing page can actually render.
 *
 * WHAT WAS ACTUALLY WRONG, because it was not what it looked like. GET
 * /v1/seasons was reported as a stub returning a fixed empty array. It is not:
 * it returns every season with its universe, its dates, its tier and a full
 * $ARCA access block. What it did not return was two of the six things a Seasons
 * page needs — how many agents are in an arena, and whether that arena is
 * running — so a page would have had to derive both, once per row, and every
 * client would have derived them slightly differently.
 *
 * HOW YOU PROVE A NUMBER IS NOT A STUB. Not by checking it exists: `0` exists.
 * By computing the same number a second way, from the database, and requiring
 * the two to agree — and by requiring the values to DIFFER across rows, since a
 * constant is exactly what a stub returns. A season with no competitions must
 * report 0 while one with two reports 2, from the same endpoint in the same
 * response, or the field is not carrying information.
 *
 * Reads only. It creates nothing and needs no session: the arena list is public
 * on purpose, because what an arena costs to enter should be knowable before
 * anyone signs in.
 */
import { execFileSync } from 'node:child_process';
import { req } from './lib/rate-aware.mjs';
import { suite } from './lib/sections.mjs';

const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const PG = process.env.PG_CONTAINER || 'arcana-postgres';
const psql = (s) => execFileSync('docker',
  ['exec', PG, 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc', s], { encoding: 'utf8' }).trim();

const { check, section, nothingToCheck, report } = suite('seasons-verify');

const list = await req(`${AGENT}/v1/seasons?page_size=50`);
const items = list.body?.items ?? [];

await section('The list answers at all, and with the seasons that exist', async () => {
  check('GET /v1/seasons is reachable without a session', list.status === 200, `status ${list.status}`);
  const inDb = Number(psql('SELECT count(*) FROM seasons'));
  check('it returns every season the database holds', items.length === inDb,
    `the endpoint returned ${items.length}, the table holds ${inDb}`);
  if (items.length === 0) {
    nothingToCheck('there are no seasons at all, so nothing below has anything to describe');
  }
});

await section('Each row carries what a page has to print', async () => {
  if (items.length === 0) {
    nothingToCheck('no rows to inspect');
    return;
  }
  for (const field of ['id', 'name', 'universe', 'startAt', 'endAt', 'accessTier']) {
    check(`every row carries ${field}`,
      items.every((s) => s[field] !== undefined && s[field] !== null && s[field] !== ''),
      `missing on: ${items.filter((s) => !s[field]).map((s) => s.name ?? s.id).join(', ')}`);
  }
  check('every row carries a progress block',
    items.every((s) => s.progress && typeof s.progress === 'object'),
    'a row has no progress');
  check('and an access block naming its gates',
    items.every((s) => Array.isArray(s.access?.gates) && s.access.gates.length > 0),
    'a row has no gates listed');
});

await section('The participant count is a count, not a constant', async () => {
  if (items.length === 0) {
    nothingToCheck('no rows to count against');
    return;
  }
  // The same number, computed a second way. If the endpoint were returning a
  // fixed value this is what would catch it.
  const rows = psql(`
    SELECT s.id::text || '|' || count(DISTINCT c.id) || '|' || count(DISTINCT p.agent_id)
      FROM seasons s
      LEFT JOIN competitions c ON c.season_id = s.id
      LEFT JOIN LATERAL unnest(coalesce(c.participant_ids,'{}'::uuid[])) AS p(agent_id) ON true
     GROUP BY s.id`).split('\n').filter(Boolean);
  const truth = Object.fromEntries(rows.map((l) => {
    const [id, comps, parts] = l.split('|');
    return [id, { competitions: Number(comps), participants: Number(parts) }];
  }));

  let mismatched = [];
  for (const s of items) {
    const t = truth[s.id];
    if (!t) continue;
    if (s.progress?.competitions !== t.competitions || s.progress?.participants !== t.participants) {
      mismatched.push(`${s.name}: endpoint ${s.progress?.competitions}/${s.progress?.participants}, ` +
        `database ${t.competitions}/${t.participants}`);
    }
  }
  check('every count matches the same count taken from the database',
    mismatched.length === 0, mismatched.join('; '));

  // A CONSTANT IS WHAT A STUB RETURNS. If every arena reported the same number
  // the check above would still pass whenever the database happened to agree.
  const distinct = new Set(items.map((s) => s.progress?.competitions));
  if (distinct.size < 2) {
    nothingToCheck(`every season currently has the same competition count ` +
      `(${[...distinct].join(',')}), so this run cannot tell a real count from a constant`);
  } else {
    check('and the counts differ between arenas, so the field carries information',
      distinct.size >= 2, `every arena reports ${[...distinct].join(',')}`);
    for (const s of items) {
      console.log(`      ${String(s.progress?.status).padEnd(8)} ${String(s.progress?.competitions)} comp ` +
        `${String(s.progress?.participants).padStart(2)} agents  ${s.name}`);
    }
  }
});

await section('Status is derived from the dates, and says which way', async () => {
  if (items.length === 0) {
    nothingToCheck('no rows to place on a clock');
    return;
  }
  const now = Date.now();
  const expected = (s) => (now < Date.parse(s.startAt) ? 'upcoming'
    : now > Date.parse(s.endAt) ? 'ended' : 'running');
  const wrong = items.filter((s) => s.progress?.status !== expected(s))
    .map((s) => `${s.name}: says ${s.progress?.status}, dates say ${expected(s)}`);
  check('every status agrees with its own start and end dates', wrong.length === 0, wrong.join('; '));
  check('and the vocabulary is closed',
    items.every((s) => ['upcoming', 'running', 'ended'].includes(s.progress?.status)),
    `saw: ${[...new Set(items.map((s) => s.progress?.status))].join(', ')}`);
});

await section('A premium arena says what it costs, and whether that is enforced', async () => {
  const premium = items.filter((s) => s.accessTier === 'premium');
  if (premium.length === 0) {
    nothingToCheck('no premium arena exists right now, so there is no gated entry to describe');
    return;
  }
  for (const s of premium) {
    const actions = (s.access?.gates ?? []).map((g) => g.action);
    check(`${s.name} names both gates`,
      actions.includes('compete') && actions.includes('premium_arena'),
      `gates: ${actions.join(', ')}`);
    // MARKED IS NOT GUARDED. A premium tier whose gates read no balance admits
    // everyone, and the listing has to say so rather than letting the tier imply
    // a requirement that is not being applied.
    check(`${s.name} says whether entry is verified against a balance`,
      s.access?.enforced === true || s.access?.enforced === false || s.access?.enforced === null,
      `enforced = ${JSON.stringify(s.access?.enforced)}`);
    check(`${s.name} states the required $ARCA, or null when no gate reads one`,
      s.access?.enforced === true ? s.access?.required_arca != null : s.access?.required_arca === null,
      `enforced=${JSON.stringify(s.access?.enforced)} required_arca=${JSON.stringify(s.access?.required_arca)}`);
    console.log(`      ${s.name}: enforced=${JSON.stringify(s.access?.enforced)} ` +
      `required=${JSON.stringify(s.access?.required_arca)}`);
  }
});

await section('The detail route answers with the same shape as the list', async () => {
  if (items.length === 0) {
    nothingToCheck('no season to fetch by id');
    return;
  }
  const one = await req(`${AGENT}/v1/seasons/${items[0].id}`);
  check('GET /v1/seasons/:id is reachable', one.status === 200, `status ${one.status}`);
  check('and carries the same progress and access blocks',
    one.body?.progress?.status === items[0].progress?.status &&
    one.body?.progress?.participants === items[0].progress?.participants &&
    one.body?.access?.tier === items[0].access?.tier,
    `detail: ${JSON.stringify(one.body?.progress)} / list: ${JSON.stringify(items[0].progress)}`);
  // A page showing one arena needs its competitions; that list already exists
  // and is filtered by season, so there is no third endpoint to add here.
  const comps = await req(`${AGENT}/v1/competitions?season_id=${items[0].id}&page_size=5`);
  check('and the competitions of a season are reachable from the existing list',
    comps.status === 200, `status ${comps.status}`);
});

const code = report();
if (code !== 0) process.exit(code);
console.log('seasons-verify: the arena list carries what a page needs, and the numbers are real.');
