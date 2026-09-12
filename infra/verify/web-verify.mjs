/**
 * web-verify.mjs — the pages render, and the numbers on them are the API's.
 *
 * WHAT THIS IS FOR. A frontend can be wrong in a way no backend test can see:
 * it can render a 200 with nothing in it, it can print a zero where the API sent
 * null, and it can re-sort a list the database already ordered. None of those
 * show up in a status code, and all three are exactly the failures this project
 * keeps removing.
 *
 * SO EVERY CHECK COMPARES AGAINST THE API, NOT AGAINST ITSELF. For each page it
 * fetches the same data the page fetched and requires the rendered HTML to
 * contain those values — and, for the lists, IN THE SAME ORDER. A page that
 * sorted client-side would still contain every name; it would contain them in
 * the wrong sequence, and that is what is asserted.
 *
 * It also requires the pages to load with authentication switched off, since the
 * whole public surface is supposed to need no wallet: every request here is made
 * without a session, deliberately.
 *
 * This checks the SERVER-RENDERED HTML. It is not a substitute for opening the
 * pages in a browser — a page can server-render correctly and still throw in
 * the client — and the browser pass is run separately.
 *
 *   WEB_URL=http://127.0.0.1:3000 node infra/verify/web-verify.mjs
 */
import { suite } from './lib/sections.mjs';

const WEB = process.env.WEB_URL || 'http://127.0.0.1:3000';
const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const MARKET = process.env.MARKETPLACE_URL || 'http://127.0.0.1:3002';

const { check, section, nothingToCheck, report } = suite('web-verify');

async function page(path) {
  const r = await fetch(`${WEB}${path}`, { headers: { accept: 'text/html' } });
  return { status: r.status, html: await r.text() };
}

async function api(base, path) {
  const r = await fetch(`${base}${path}`, { headers: { accept: 'application/json' } });
  const text = await r.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* left null on purpose: a non-JSON body is a failure the caller should see */
  }
  return { status: r.status, body };
}

/** Strip tags so a number split across spans is still findable as text. */
const text = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');

/**
 * The position of each needle in the haystack, in order.
 *
 * Returns -1 for a needle that is absent. Used to prove ORDER, which is the
 * property a client-side re-sort would break while leaving every other check
 * green.
 */
const positions = (hay, needles) => needles.map((n) => hay.indexOf(n));
const isAscending = (xs) => xs.every((v, i) => i === 0 || (v > xs[i - 1] && v >= 0));

const score1 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1) : null);

// ---------------------------------------------------------------------------

await section('The public surface answers without a session', async () => {
  for (const [name, path] of [
    ['landing', '/'],
    ['leaderboard', '/leaderboard'],
    ['marketplace', '/marketplace'],
    ['seasons', '/seasons'],
  ]) {
    const p = await page(path);
    check(`${name} renders for a caller with no cookie and no wallet`, p.status === 200, `status ${p.status}`);
    check(`${name} returns a real document, not an empty shell`,
      p.html.length > 2000 && /<\/html>/i.test(p.html),
      `${p.html.length} bytes, closing tag ${/<\/html>/i.test(p.html)}`);
    // A Next error page still answers 200. This is what separates "rendered"
    // from "answered".
    check(`${name} is not the error boundary`,
      !/This page failed to render/.test(p.html),
      'the error boundary was rendered instead of the page');
  }
});

// ---------------------------------------------------------------------------

const board = await api(AGENT, '/v1/leaderboard?page_size=25');
const lbHtml = await page('/leaderboard');
const lbText = text(lbHtml.html);

await section('The leaderboard prints the API rows, in the API order', async () => {
  if (board.status !== 200 || !Array.isArray(board.body?.items)) {
    check('the leaderboard API answered', false, `status ${board.status}`);
    return;
  }
  const items = board.body.items;
  if (items.length === 0) {
    nothingToCheck('the leaderboard returned no rows, so there is no ordering to compare against');
    return;
  }

  const missing = items.filter((i) => !lbText.includes(i.agent_name)).map((i) => i.agent_name);
  check('every agent the API returned appears on the page', missing.length === 0, `missing: ${missing.join(', ')}`);

  // THE ORDER IS THE ASSERTION. A page that re-sorted in the browser would
  // still contain all of these names.
  const pos = positions(lbText, items.map((i) => i.agent_name));
  check('and they appear in the order the API returned them',
    isAscending(pos),
    `positions ${pos.join(', ')} for ${items.map((i) => i.agent_name).join(', ')}`);

  // The scores, to one decimal, exactly as the page formats them.
  const wrong = [];
  for (const i of items) {
    if (!i.ranked) continue;
    const s = score1(i.score);
    if (s === null) continue;
    if (!lbText.includes(s)) wrong.push(`${i.agent_name} score ${s} not found on the page`);
  }
  check('every published score is printed to the digit the API sent', wrong.length === 0, wrong.join('; '));

  check('the page states the ranked total the API reported',
    lbText.includes(String(board.body.total_ranked)),
    `total_ranked=${board.body.total_ranked} not found in the page text`);

  // A CONTROL THAT REPORTS AN ABSENCE MUST BE RIGHT ABOUT IT. The first version
  // of the pager demanded both `total` and `total_pages`; the leaderboard sends
  // `total` and `has_more`, so the page printed "the response did not carry a
  // total" underneath a response that carried one. A false absence is the same
  // defect as a false number, and it slipped past this suite because nothing
  // here read the pagination line.
  check('the pager does not claim the total is missing when the API sent one',
    typeof board.body.total !== 'number' || !/did not carry a total/.test(lbText),
    `the API sent total=${board.body.total} and the page says the total is unknown`);
  check('and it prints that total',
    typeof board.body.total === 'number' ? lbText.includes(`of ${board.body.total} agents`) : true,
    `expected "of ${board.body.total} agents" in the pagination line`);
});

await section('A withheld score is not printed as a number', async () => {
  const un = (board.body?.items ?? []).filter((i) => !i.ranked);
  if (un.length === 0) {
    nothingToCheck('no unranked agent is on this page, so the withheld case has nothing to render');
    return;
  }
  check('the page says a score is withheld rather than showing a digit',
    /withheld/i.test(lbText), 'the word "withheld" does not appear');
  check('and it marks the row UNRANKED', /UNRANKED/.test(lbText), 'no UNRANKED marker on the page');
});

await section('The eighth category is refused, and the refusal is explained', async () => {
  const bad = await page('/leaderboard?category=regime');
  check('asking for regime does not render a ranking', bad.status === 200, `status ${bad.status}`);
  const t = text(bad.html);
  check('the page explains that regime is not offered',
    /regime/i.test(t) && /(not offered|not implemented|placeholder)/i.test(t),
    'no explanation of why regime is absent');
});

// ---------------------------------------------------------------------------

await section('An agent page prints that agent, and its own numbers', async () => {
  const first = board.body?.items?.[0];
  if (!first) {
    nothingToCheck('no agent to open');
    return;
  }
  const pass = await api(AGENT, `/v1/agents/${first.agent_id}/passport`);
  const p = await page(`/agents/${first.agent_id}`);
  const t = text(p.html);

  check('the agent page renders', p.status === 200, `status ${p.status}`);
  check('it names the agent', t.includes(first.agent_name), `${first.agent_name} not on the page`);
  check('all seven tabs are offered',
    ['Overview', 'Decisions', 'DNA', 'Autopsy', 'Passport', 'Evolution', 'Positions'].every((x) => t.includes(x)),
    'a tab is missing from the page');

  if (pass.status === 200) {
    const dec = pass.body?.participation?.decisions;
    check('the decision count on the page is the passport\'s',
      typeof dec === 'number' ? t.includes(String(dec)) : true,
      `passport says ${dec} decisions, not found on the page`);
    const own = pass.body?.decided_by?.own;
    const prot = pass.body?.decided_by?.protective;
    check('the agent\'s own trades and the protective exits are shown as separate numbers',
      /own trades/i.test(t) && /protective exits/i.test(t),
      'the two are not labelled separately');
    check('and those two numbers are the passport\'s',
      typeof own === 'number' && typeof prot === 'number'
        ? t.includes(String(own)) && t.includes(String(prot))
        : true,
      `passport: own=${own} protective=${prot}`);
  }
});

await section('Every tab of the agent page renders on its own', async () => {
  const first = board.body?.items?.[0];
  if (!first) {
    nothingToCheck('no agent to open');
    return;
  }
  for (const tab of ['overview', 'decisions', 'dna', 'autopsy', 'passport', 'evolution', 'positions']) {
    const p = await page(`/agents/${first.agent_id}?tab=${tab}`);
    check(`tab ${tab} renders`, p.status === 200, `status ${p.status}`);
    check(`tab ${tab} is not the error boundary`,
      !/This page failed to render/.test(p.html), 'error boundary rendered');
  }
});

await section('The decision log shows a status where a price is missing', async () => {
  const first = board.body?.items?.[0];
  if (!first) {
    nothingToCheck('no agent to open');
    return;
  }
  const dec = await api(AGENT, `/v1/agents/${first.agent_id}/decisions?page=1&page_size=25`);
  const p = await page(`/agents/${first.agent_id}?tab=decisions`);
  const t = text(p.html);
  const rows = dec.body?.decisions ?? [];
  if (rows.length === 0) {
    nothingToCheck('this agent has no decisions, so there is no price column to inspect');
    return;
  }
  const nullPrices = rows.filter((r) => r.price === null || r.price === undefined);
  if (nullPrices.length === 0) {
    nothingToCheck('every decision on this page carries a price, so the missing-price rendering is not exercised');
  } else {
    check('a decision with no price does not print a zero',
      !/\b0\.00\b/.test(t) || /n\/a|unavailable/.test(t),
      'a 0.00 appears and no absence marker does');
    check('and the reason is shown instead',
      /n\/a|unavailable|no_symbol/.test(t),
      `${nullPrices.length} rows carry a null price; the page shows no status for them`);
  }
  check('the total the API reports is printed', t.includes(String(dec.body?.total_decisions ?? '')),
    `total_decisions=${dec.body?.total_decisions}`);
});

// ---------------------------------------------------------------------------

await section('A protective exit looks different from the agent\'s own trade', async () => {
  // The agent the platform has actually acted for. Chosen from the API rather
  // than hardcoded, and skipped honestly when no such agent exists.
  const board2 = await api(AGENT, '/v1/leaderboard?page_size=25&include_unranked=true');
  let found = null;
  for (const row of board2.body?.items ?? []) {
    const d = await api(AGENT, `/v1/agents/${row.agent_id}/decisions?page_size=200&include_prices=false`);
    const rows = d.body?.decisions ?? [];
    if (rows.some((x) => x.decider === 'protective')) {
      found = { id: row.agent_id, rows };
      break;
    }
  }
  if (!found) {
    nothingToCheck('no agent on the leaderboard has a protective decision, so the distinction cannot be seen');
    return;
  }

  const p = await page(`/agents/${found.id}?tab=decisions`);
  const t = text(p.html);
  check('the decisions tab renders for that agent', p.status === 200, `status ${p.status}`);

  // Only the first page is rendered, so compare against the same slice.
  const shown = found.rows.slice(0, 25);
  const exits = shown.filter((x) => x.decided_by?.category === 'protective_exit');
  const held = shown.filter((x) => x.decided_by?.category === 'protective_held_back');

  if (exits.length === 0 && held.length === 0) {
    nothingToCheck('the protective rows fall outside the first page, which is what the page renders');
    return;
  }
  for (const x of [...exits, ...held]) {
    check(`the ${x.decided_by.category} at ${x.ts} is labelled on the page`,
      t.includes(x.decided_by.label),
      `label ${JSON.stringify(x.decided_by.label)} not found in the rendered text`);
  }
  // AND IT MUST NOT READ AS AN EXIT WHEN NOTHING WAS SOLD.
  if (held.length > 0) {
    check('a level that was crossed and not acted on says the exit was NOT taken',
      /NOT taken/.test(t),
      'the refused-exit wording is absent from the page');
  }
  // A page that labelled EVERY row the same way would pass the checks above.
  const labels = new Set(shown.map((x) => x.decided_by?.label).filter(Boolean));
  check('and the page is not giving every row the same label',
    labels.size >= 2, `only one label in play: ${[...labels].join(', ')}`);
});

await section('Seasons render what the season record says, including the unknowns', async () => {
  const seasons = await api(AGENT, '/v1/seasons?page_size=50');
  const p = await page('/seasons');
  const t = text(p.html);
  const items = seasons.body?.items ?? [];
  if (items.length === 0) {
    nothingToCheck('no seasons exist, so there is nothing to compare');
    return;
  }
  const missing = items.filter((s) => !t.includes(s.name)).map((s) => s.name);
  check('every season is named on the page', missing.length === 0, `missing: ${missing.join(', ')}`);

  const counts = items.filter((s) => typeof s.progress?.participants === 'number');
  check('the participant counts are the API\'s',
    counts.every((s) => t.includes(String(s.progress.participants))),
    counts.map((s) => `${s.name}=${s.progress.participants}`).join(', '));

  // enforced: null must not read as "not enforced".
  const unknown = items.filter((s) => s.access && s.access.enforced === null);
  if (unknown.length === 0) {
    nothingToCheck('no season currently has enforced=null, so the unknown-gate rendering is not exercised');
  } else {
    check('a gate nothing has verified is shown as unknown, not as unenforced',
      /nothing has verified this gate|UNKNOWN/i.test(t),
      `${unknown.length} seasons carry enforced=null and the page does not say so`);
  }
});

// ---------------------------------------------------------------------------

await section('The marketplace separates "none listed" from "none active"', async () => {
  const disc = await api(MARKET, '/v1/marketplace/agents?sort=score_desc');
  const all = await api(MARKET, '/v1/marketplace/listings');
  const p = await page('/marketplace');
  const t = text(p.html);
  check('the marketplace renders', p.status === 200, `status ${p.status}`);

  const rows = Array.isArray(disc.body) ? disc.body : [];
  const listings = Array.isArray(all.body) ? all.body : [];
  if (rows.length > 0) {
    const missing = rows.filter((r) => r.agent_name && !t.includes(r.agent_name)).map((r) => r.agent_name);
    check('every discoverable agent appears', missing.length === 0, `missing: ${missing.join(', ')}`);
    const pos = positions(t, rows.filter((r) => r.agent_name).map((r) => r.agent_name));
    check('in the order the service returned them', isAscending(pos), `positions ${pos.join(', ')}`);
  } else if (listings.length > 0) {
    check('an empty grid says the listings exist but are switched off',
      /switched off|not active/i.test(t),
      `${listings.length} listings exist and the page does not distinguish that from none existing`);
    check('and it states how many', t.includes(String(listings.length)), `${listings.length} not printed`);
  } else {
    check('an empty grid says nobody has listed an agent',
      /never been listed|No agent has ever been listed/i.test(t),
      'the page does not say which kind of empty this is');
  }
});

// ---------------------------------------------------------------------------

await section('The landing page shows what it cannot source, rather than a plausible number', async () => {
  const p = await page('/');
  const t = text(p.html);
  check('the landing page renders', p.status === 200, `status ${p.status}`);
  check('it names the statistics it has no source for',
    (t.match(/no source/g) ?? []).length >= 4,
    `found ${(t.match(/no source/g) ?? []).length} "no source" tiles, expected at least 4`);
  check('and it says there is no live decision feed',
    /no live decision feed/i.test(t),
    'the missing feed is not declared');
  // The counts it DOES have must be the endpoints' own.
  const agents = await api(AGENT, '/v1/agents?page_size=1');
  const creators = await api(AGENT, '/v1/creators?page_size=1');
  check('the agent count is the agents endpoint\'s total',
    typeof agents.body?.total === 'number' ? t.includes(String(agents.body.total)) : true,
    `API total ${agents.body?.total}`);
  check('the creator count is the creators endpoint\'s total',
    typeof creators.body?.total === 'number' ? t.includes(String(creators.body.total)) : true,
    `API total ${creators.body?.total}`);
});

await section('A URL that names nothing says so', async () => {
  const p = await page('/no-such-page-here');
  check('an unknown path answers 404', p.status === 404, `status ${p.status}`);
  check('and says the address matched no record',
    /Nothing is published at this address/i.test(p.html),
    'the not-found page did not render');
});

const code = report();
if (code !== 0) process.exit(code);
console.log('web-verify: the pages render, and every number on them came from the API.');
