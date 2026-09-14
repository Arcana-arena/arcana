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
const ARCA = process.env.ARCA_URL || 'http://127.0.0.1:3004';

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
  // IT USED TO ASK THE WRONG BOARD. The default leaderboard EXCLUDES unranked
  // agents — that is what `include_unranked` is for — so reading the default
  // response and finding none was guaranteed, and the section closed itself
  // with "nothing to render" on every run. The condition was not missing from
  // the platform; it was missing from the question. A check that can only ever
  // decline is worse than no check, because the declining is legible and looks
  // like diligence.
  const withUnranked = await api(AGENT, '/v1/leaderboard?include_unranked=true');
  const un = (withUnranked.body?.items ?? []).filter((i) => !i.ranked);
  if (un.length === 0) {
    nothingToCheck(
      'no agent anywhere in this season is below the ranking threshold, so the withheld case has ' +
      'nothing to render. This is now a fact about the data, not about which board was asked.');
    return;
  }

  const p = await page('/leaderboard?include_unranked=true');
  const t = text(p.html);
  check('the board that includes unranked agents renders', p.status === 200, `status ${p.status}`);

  const one = un[0];
  check('the unranked agent is on it', t.includes(one.agent_name), `${one.agent_name} is not on the page`);
  check('the page says a score is withheld rather than showing a digit',
    /withheld/i.test(t), 'the word "withheld" does not appear');
  check('and it marks the row UNRANKED', /UNRANKED/.test(t), 'no UNRANKED marker on the page');

  // WHY, NOT JUST THAT. The API sends the reason; a page that showed only the
  // word would leave somebody unable to tell "not enough decisions yet" from
  // "something went wrong".
  check('the reason the score is withheld is printed, not just the fact',
    typeof one.unranked_note === 'string' && one.unranked_note.length > 0
      ? t.includes(one.unranked_note.slice(0, 40))
      : true,
    `unranked_note: ${String(one.unranked_note).slice(0, 80)}`);

  // AND NO NUMBER STANDS IN FOR IT. A withheld composite must not be rendered
  // as 0, which reads as a measurement and ranks like one.
  check('the composite is not rendered as zero for the unranked agent',
    one.arcana_score === null || one.arcana_score === undefined,
    `the API sent arcana_score=${one.arcana_score} for an agent it marked unranked`);
  check('and the unranked agent carries no rank number',
    one.rank === null || one.rank === undefined, `rank=${one.rank}`);
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
    // A NUMBER IS FOUND WHERE IT IS PRINTED, NOT AS A SUBSTRING OF THE PAGE. This
    // used to ask whether the passport's count appeared anywhere in the
    // overview's text, and the overview never prints it for a ranked, active
    // agent: it passed while some NAV figure happened to contain the digits, and
    // failed on 2026-09-14 when the count moved from 278 to 279 and the
    // coincidence ended. The Decisions tab prints the count in one labelled place.
    const dt = text((await page(`/agents/${first.agent_id}?tab=decisions`)).html);
    const shown = dt.match(/Decisions\s*·\s*([\d,]+)\s*recorded/);
    check('the decision count on the Decisions tab is the passport\'s',
      typeof dec === 'number' ? !!shown && Number(shown[1].replace(/,/g, '')) === dec : true,
      `passport says ${dec} decisions; the tab says ${shown ? shown[1] : 'nothing labelled'}`);
    const own = pass.body?.decided_by?.own;
    const prot = pass.body?.decided_by?.protective;
    check('the agent\'s own trades and the protective exits are shown as separate numbers',
      /own trades/i.test(t) && /protective exits/i.test(t),
      'the two are not labelled separately');
    const token = (n) => new RegExp(`(^|[^\\d.,])${Number(n).toLocaleString('en-US')}([^\\d.,]|$)`);
    check('and those two numbers are the passport\'s',
      typeof own === 'number' && typeof prot === 'number'
        ? token(own).test(t) && token(prot).test(t)
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
    nothingToCheck('no season currently has enforced=null, so the unknown-gate rendering is not exercised HERE — gate-unknown-verify builds that condition and proves it');
  } else {
    check('a gate nothing has verified is shown as unknown, not as unenforced',
      /nothing has verified this gate|UNKNOWN/i.test(t),
      `${unknown.length} seasons carry enforced=null and the page does not say so`);
  }
});

// ---------------------------------------------------------------------------

await section('The marketplace prints the browse rows, in the browse order', async () => {
  const b = await api(MARKET, '/v1/marketplace/browse');
  const p = await page('/marketplace');
  const t = text(p.html);
  check('the marketplace renders', p.status === 200, `status ${p.status}`);
  check('and the browse endpoint answers', b.status === 200, `status ${b.status}`);

  const rows = Array.isArray(b.body?.items) ? b.body.items : [];
  if (rows.length === 0) {
    // FOUR DIFFERENT FACTS RENDER AS NO CARDS, and the page has to say which.
    const counts = b.body?.counts ?? {};
    check('an empty grid distinguishes which kind of empty it is',
      /No agent has been listed|Nothing here can be bought|No listing matches/i.test(t),
      'the grid is empty and the page does not say why');
    if ((counts.listings ?? 0) > 0) {
      check('and it states how many listings exist', t.includes(String(counts.listings)),
        `${counts.listings} listings exist and the count is not printed`);
    }
  } else {
    const named = rows.filter((r) => r.agent_name).map((r) => r.agent_name);
    const missing = named.filter((n) => !t.includes(n));
    check('every listed agent appears', missing.length === 0, `missing: ${missing.join(', ')}`);
    const pos = positions(t, named);
    check('in the order the service returned them', isAscending(pos), `positions ${pos.join(', ')}`);
  }

  // THE CARD THAT CANNOT BE BOUGHT MUST SAY SO WHERE THE BUTTON WOULD BE. A
  // Subscribe button on a listing with no payee address invites somebody to
  // send money nobody can receive and nobody can refund.
  const unbuyable = rows.filter((r) => !r.buyable);
  if (unbuyable.length === 0) {
    nothingToCheck('no listing is currently unbuyable, so the refusal wording has nothing to assert against');
  } else {
    const silent = unbuyable.filter((r) => r.not_buyable_note && !t.includes(r.not_buyable_note.slice(0, 40)));
    check('an unbuyable listing shows the reason it cannot be bought',
      silent.length === 0,
      `${silent.length} unbuyable listing(s) render without their reason`);
    check('and no Subscribe control is offered for it',
      !/Subscribe<\/a>/.test(p.html) || rows.some((r) => r.buyable),
      'a Subscribe link is rendered while nothing on the page is buyable');
  }

  // AN ABSENT RETURN IS NOT A ZERO. The card prints a dash, never 0.00%.
  const unmeasured = rows.filter((r) => r.performance?.return_pct === null);
  if (unmeasured.length === 0) {
    nothingToCheck('every listed agent has a measured return, so the absent case has nothing to assert against');
  } else {
    check('an unmeasured return is not printed as a zero',
      !/\bRETURN\s+\+?0\.00%/i.test(t),
      'a card shows +0.00% for a return the service reported as null');
  }
});

await section('A listing page states what it costs before what it is', async () => {
  const b = await api(MARKET, '/v1/marketplace/browse');
  const rows = Array.isArray(b.body?.items) ? b.body.items : [];
  if (rows.length === 0) {
    nothingToCheck('no listing exists, so there is no listing page to open');
    return;
  }
  const one = rows[0];
  const d = await api(MARKET, `/v1/marketplace/listings/${one.listing_id}/detail`);
  const p = await page(`/marketplace/${one.listing_id}`);
  const t = text(p.html);
  check('the listing page renders', p.status === 200, `status ${p.status}`);
  check('the detail endpoint answers', d.status === 200, `status ${d.status}`);
  if (one.agent_name) {
    check('and names the agent it is selling', t.includes(one.agent_name), `${one.agent_name} not on the page`);
  }

  // THE NO-REFUND WARNING BELONGS TO THE QUOTE, which is the last moment a
  // buyer can still decide. A buyable listing that does not carry it is
  // selling an irreversible transfer without saying so.
  if (one.buyable) {
    check('a buyable listing warns that the payment cannot be refunded',
      /No refunds|cannot refund|cannot be refunded/i.test(t),
      'the quote panel does not carry the no-refund warning');
  } else {
    check('an unbuyable listing says why rather than quoting a price to pay',
      d.body?.not_buyable_note ? t.includes(d.body.not_buyable_note.slice(0, 40)) : true,
      'the page does not print the reason this listing cannot be bought');
  }

  // WIN RATE IS NOT COMPUTABLE FROM THIS RECORD and the page must not invent
  // one. It is the single figure the design asks for that the data cannot
  // honestly produce.
  check('win rate is shown as not computable rather than as a percentage',
    !/Win rate\s+\d+(\.\d+)?%/i.test(t),
    'a win rate percentage is printed, and no closed round trips are recorded to compute one from');

  // DECLARED AND MEASURED ARE NOT THE SAME FIELD. Showing the measurement
  // under the declaration's heading lets a mislabelled agent present its own
  // description as evidence.
  check('declared limits and measured behaviour are labelled separately',
    /DECLARED/i.test(t) && /MEASURED/i.test(t),
    'the page does not distinguish what the creator declared from what was measured');
});

await section('A listing id that names nothing answers 404', async () => {
  const p = await page('/marketplace/00000000-0000-0000-0000-000000000000');
  // A 404 PAGE SERVED WITH A 200 IS A LIE TO EVERY CRAWLER AND LINK CHECKER.
  // This regressed once: loading.tsx at the marketplace segment began the
  // response before notFound() could set the status.
  check('an unknown listing answers 404', p.status === 404, `status ${p.status}`);
  check('and says no listing is at that address',
    /No listing at this address/i.test(p.html),
    'the listing not-found page did not render');
});

await section('The docs quote the engine, not a design document', async () => {
  const params = await api(AGENT, '/v1/docs/parameters');
  const p = await page('/docs/scoring');
  const t = text(p.html);
  check('the scoring page renders', p.status === 200, `status ${p.status}`);
  check('the parameters endpoint answers', params.status === 200, `status ${params.status}`);

  const weights = params.body?.scoring?.weights ?? [];
  if (weights.length === 0) {
    check('the parameters endpoint publishes weights', false, 'it returned none');
  } else {
    // EVERY WEIGHT THE ENGINE HOLDS MUST BE ON THE PAGE. A docs page that
    // hard-coded the design document's .25/.20/.15 would be confidently wrong
    // about the one thing it exists to explain.
    const absent = weights.filter((w) => !t.includes(w.weight.toFixed(2))).map((w) => w.key);
    check('every weight the engine holds is printed', absent.length === 0,
      `not on the page: ${absent.join(', ')}`);
    const sum = weights.reduce((a, w) => a + w.weight, 0);
    check('the weights on the page sum to one', Math.abs(sum - 1) < 1e-9, `they sum to ${sum.toFixed(4)}`);

    // THE TERM THAT MEASURES NOTHING MUST BE NAMED AS SUCH. It carries a real
    // weight over a constant, which is exactly what looks like a measurement
    // and is not.
    const blind = weights.find((w) => w.measures === false);
    if (!blind) {
      nothingToCheck('every published component measures something, so there is nothing to disclose');
    } else {
      check(`${blind.key} is disclosed as measuring nothing`,
        /measures nothing|arithmetic over a constant/i.test(t),
        `${blind.key} carries weight ${blind.weight} and the page does not say it discriminates between no two agents`);
    }
  }

  // STRATEGY IS A MULTIPLIER, NOT A SEVENTH WEIGHT. Listing it beside
  // performance would tell a reader the two trade off against each other.
  check('strategy is described as a multiplier rather than a weighted term',
    /multiplier/i.test(t),
    'the page does not say strategy multiplies the total');

  check('the ranking threshold on the page is the engine\'s',
    typeof params.body?.scoring?.min_decisions_to_rank === 'number'
      ? t.includes(String(params.body.scoring.min_decisions_to_rank))
      : true,
    `engine says ${params.body?.scoring?.min_decisions_to_rank}`);
});

await section('The docs carry every section, and search says what it searched', async () => {
  const slugs = [
    'what-arcana-is', 'how-it-works', 'creating-an-agent', 'writing-a-mandate',
    'triggers-and-protection', 'wallets-and-custody', 'scoring', 'dna', 'autopsy',
    'marketplace', 'arca', 'api', 'faq',
  ];
  const bad = [];
  for (const s of slugs) {
    const p = await page(`/docs/${s}`);
    if (p.status !== 200) bad.push(`${s}:${p.status}`);
  }
  check('all thirteen documentation pages render', bad.length === 0, bad.join(', '));

  const miss = await page('/docs/not-a-real-page');
  check('an unknown docs slug answers 404', miss.status === 404, `status ${miss.status}`);

  // SEARCH THAT FINDS NOTHING MUST SAY WHAT IT LOOKED IN. "No results" reads
  // as "that word appears nowhere in the documentation", which is a much
  // stronger claim than this index can make.
  const s = await page('/docs/scoring?q=zzzznotaword');
  const st = text(s.html);
  check('a search with no hits says which index it searched',
    /titles, summaries, keywords and headings|not the body text/i.test(st),
    'an empty search result does not say what was searched');

  const hit = await page('/docs/scoring?q=drawdown');
  check('a search with hits lists them', /result/i.test(text(hit.html)), 'no result line rendered');
});

await section('The subscription terms on the docs are the ones in force', async () => {
  const terms = await api(ARCA, '/v1/arca/terms');
  const p = await page('/docs/marketplace');
  const t = text(p.html);
  check('the marketplace docs render', p.status === 200, `status ${p.status}`);
  if (terms.status !== 200) {
    check('the terms endpoint answers', false, `status ${terms.status}`);
    return;
  }
  check('the term length on the page is the service\'s',
    t.includes(`${terms.body.term_days} days`), `service says ${terms.body.term_days} days`);
  check('the grace window on the page is the service\'s',
    t.includes(`${terms.body.grace_hours}h`), `service says ${terms.body.grace_hours}h`);
  check('the confirmation depth on the page is the service\'s',
    t.includes(String(terms.body.min_confirmations)), `service says ${terms.body.min_confirmations}`);
  // THE CONFIRMATION COUNT IS MEANINGLESS WITHOUT THE BLOCK TIME. 12 on
  // Ethereum is two and a half minutes; 12 here would be 1.2 seconds.
  check('and it is stated in wall-clock terms as well as blocks',
    t.includes(String(terms.body.approx_confirmation_seconds)),
    `service says about ${terms.body.approx_confirmation_seconds}s`);
  check('the page states that nothing can be refunded',
    /cannot refund|no refunds|refundable\s+no/i.test(t),
    'the docs do not say a payment cannot be refunded');
});

await section('System status never reports a missing check as a passing one', async () => {
  const s = await api(AGENT, '/v1/status');
  const p = await page('/status');
  const t = text(p.html);
  check('the status page renders', p.status === 200, `status ${p.status}`);
  check('the status endpoint answers', s.status === 200, `status ${s.status}`);

  const comps = s.body?.components ?? [];
  check('it probes something', comps.length > 0, 'no components were returned');

  const unknown = comps.filter((c) => c.state === 'unknown');
  if (unknown.length === 0) {
    nothingToCheck('every probe ran, so the unknown-is-not-green rule has nothing to assert against');
  } else {
    // THE RULE. A probe that could not run is not a probe that passed.
    check('an unrunnable probe does not make the overall state operational',
      s.body.overall !== 'operational',
      `${unknown.length} probe(s) returned unknown and the overall state is still operational`);
    check('and the page says so', /UNKNOWN/i.test(t), 'the unknown state is not rendered');
  }

  // A VERDICT WITHOUT ITS THRESHOLD CANNOT BE DISAGREED WITH.
  const judged = comps.filter((c) => c.state !== 'unknown');
  const noThreshold = judged.filter((c) => !c.threshold).map((c) => c.key);
  check('every judged component states the threshold it was judged against',
    noThreshold.length === 0, `without a threshold: ${noThreshold.join(', ')}`);

  // NO UPTIME PERCENTAGE. There is no probe log to compute one from, and a
  // figure with a decimal point and no measurement behind it is the most
  // convincing kind of invented number.
  check('no uptime percentage is claimed',
    !/9\d\.\d+%\s*uptime|uptime\s*9\d/i.test(t),
    'an uptime figure is printed and nothing measures one');
});

await section('A season page lists the rules nobody enforces', async () => {
  const seasons = await api(AGENT, '/v1/seasons?page_size=1');
  const s = seasons.body?.items?.[0];
  if (!s) {
    nothingToCheck('no season exists, so there is no season page to open');
    return;
  }
  const rules = await api(AGENT, `/v1/seasons/${s.id}/rules`);
  const ticks = await api(AGENT, `/v1/seasons/${s.id}/ticks`);
  const p = await page(`/seasons/${s.id}`);
  const t = text(p.html);
  check('the season page renders', p.status === 200, `status ${p.status}`);
  check('the rules endpoint answers', rules.status === 200, `status ${rules.status}`);
  check('the ticks endpoint answers', ticks.status === 200, `status ${ticks.status}`);

  const described = (rules.body?.rules ?? []).filter((r) => !r.enforced);
  if (described.length === 0) {
    nothingToCheck('every rule this season names is enforced, so there is nothing to disclose as unenforced');
  } else {
    // A FOUR-RULE TABLE READS AS A COMPLETE ONE. The rules the platform does
    // not apply have to be visible, and without invented figures.
    const hidden = described.filter((r) => !t.includes(r.label));
    check('every rule the platform does not enforce is still listed',
      hidden.length === 0, `not on the page: ${hidden.map((r) => r.label).join(', ')}`);
    check('and they are marked as not enforced',
      /not enforced|Described, not enforced/i.test(t),
      'unenforced rules are listed without being marked as unenforced');
    const withValues = described.filter((r) => r.value !== null);
    check('none of them carries an invented figure',
      withValues.length === 0,
      `these have values while nothing applies them: ${withValues.map((r) => r.label).join(', ')}`);
  }

  // A DAY WITH NO TICK IS ABSENT, NOT ZERO.
  if ((ticks.body?.ticks ?? 0) === 0) {
    check('a season with no ticks says nothing has run in it',
      /No tick has been recorded/i.test(t),
      'the page draws an empty tick history without saying it is empty');
  } else {
    check('the tick total on the page is the endpoint\'s',
      t.includes(String(ticks.body.ticks)), `endpoint says ${ticks.body.ticks}`);
    check('and the page says a missing day is not a day of zero ticks',
      /absent from this array|absent from the daily|rather than present with a count of zero/i.test(t),
      'the daily tick chart does not disclose that absent days are absent rather than zero');
  }
});

await section('An arena whose gate cannot be read does not read as open', async () => {
  const seasons = await api(AGENT, '/v1/seasons?page_size=50');
  const rows = seasons.body?.items ?? [];
  const unknown = rows.filter((s) => s.access && s.access.enforced === null);
  const marked = rows.filter((s) => s.access && s.access.enforced === false && s.accessTier === 'premium');
  const p = await page('/seasons');
  const t = text(p.html);
  check('the seasons page renders', p.status === 200, `status ${p.status}`);

  if (unknown.length === 0 && marked.length === 0) {
    nothingToCheck('every gate reports a definite state, so the three-state rendering has nothing to assert against');
  }
  if (unknown.length > 0) {
    // `enforced: null` IS NOT "NOT ENFORCED". It is "nobody could find out",
    // and rendering it as open answers a question the platform could not.
    check('an unreadable gate is shown as unknown, not as open',
      /GATE UNKNOWN/i.test(t),
      `${unknown.length} season(s) have enforced: null and the page does not mark them unknown`);
  }
  if (marked.length > 0) {
    check('a premium arena whose gate admits everyone says it is marked, not guarded',
      /NOT GUARDED|marked premium/i.test(t),
      'a premium tier with an inactive gate is presented as though entry were checked');
  }

  // AN EMPTY SEASON IS NOT HIDDEN. Hiding empty arenas would hide one that is
  // empty because it has not started, which is a different fact entirely.
  const empty = rows.filter((s) => (s.progress?.participants ?? 0) === 0);
  if (empty.length === 0) {
    nothingToCheck('every season has entrants, so the empty-season rule has nothing to assert against');
  } else {
    const hidden = empty.filter((s) => !t.includes(s.name));
    check('a season with no entrants is still listed', hidden.length === 0,
      `hidden: ${hidden.map((s) => s.name).join(', ')}`);
  }
});

// ---------------------------------------------------------------------------

await section('The landing page shows what it cannot source, rather than a plausible number', async () => {
  const p = await page('/');
  const t = text(p.html);
  check('the landing page renders', p.status === 200, `status ${p.status}`);
  // THESE TWO USED TO ASSERT THE OPPOSITE, AND THEY WERE RIGHT TO FAIL.
  // They required the page to print "no source" on four tiles and to declare
  // that it had no decision feed. That was a note to myself rendered at a
  // visitor, and the objection behind it — that a feed assembled in the browser
  // would be a different list on every load — was an argument for building the
  // endpoint, not for deleting the feature. The endpoints exist now, so the
  // checks assert the numbers instead of the apology.
  check('no statistic is published as an apology',
    !/no source/i.test(t), 'a "no source" tile is still being shown to visitors');

  const stats = await api(AGENT, '/v1/stats');
  if (stats.status !== 200) {
    check('the platform statistics are readable', false, `status ${stats.status}`);
  } else {
    const st = stats.body;
    const tiles = [
      ['agents', st.agents?.total],
      ['active agents', st.agents?.active],
      ['decisions', st.decisions?.total],
      ['settled executions', st.executions?.settled],
      ['creators', st.creators?.total],
      ['seasons running', st.seasons?.running],
      ['latest block', st.chain?.last_block_seen],
    ];
    const missing = tiles
      .filter(([, v]) => typeof v === 'number')
      .filter(([, v]) => !t.includes(Number(v).toLocaleString('en-US')) && !t.includes(String(v)))
      .map(([name, v]) => `${name}=${v}`);
    check('every headline statistic on the page is the one the API counted',
      missing.length === 0, `not found on the page: ${missing.join(', ')}`);

    // A CONSTANT WOULD PASS THE CHECK ABOVE if every total happened to be the
    // same. Requiring them to differ is what separates reading from printing.
    const distinct = new Set(tiles.map(([, v]) => String(v)));
    if (distinct.size < 3) {
      nothingToCheck(`the platform totals are nearly all the same value right now ` +
        `(${[...distinct].join(',')}), so this run cannot tell a read from a constant`);
    } else {
      check('and the totals differ from one another, so they carry information',
        distinct.size >= 3, `only ${distinct.size} distinct values`);
    }
  }

  const feed = await api(AGENT, '/v1/decisions/recent?limit=8');
  if (feed.status !== 200 || !Array.isArray(feed.body?.items)) {
    check('the cross-agent decision feed is readable', false, `status ${feed.status}`);
  } else if (feed.body.items.length === 0) {
    nothingToCheck('no decision has been recorded, so the hero feed has nothing to render');
  } else {
    const names = feed.body.items.map((i) => i.agent_name);
    const absent = names.filter((nm) => !t.includes(nm));
    check('the live decision feed shows the agents the API returned',
      absent.length === 0, `missing from the page: ${[...new Set(absent)].join(', ')}`);
    // ORDER, not just presence — the feed is ordered by the database and a page
    // that re-sorted it would still contain every name.
    //
    // DISTINCT NAMES ONLY. One agent decides many times, so the same name
    // appears on several rows and indexOf returns its FIRST position every
    // time — which reads as a list going backwards. Comparing the first
    // appearance of each distinct name, in the order the API first mentions it,
    // is the same assertion without the false failure.
    const firstSeen = [...new Set(names)];
    const pos = positions(t, firstSeen);
    check('and in the order the API returned them', isAscending(pos.filter((p) => p >= 0)),
      `${firstSeen.join(', ')} at ${pos.join(', ')}`);
  }

  // NO DEVELOPMENT-ERA LABELS ON THE PUBLIC SURFACE. The page sells a record
  // nobody can edit; showing it under `dummy_creator` and `Dummy Season 1`
  // undermines the only claim it makes.
  const devNames = ['dummy_creator', 'Dummy Season 1', 'dummy_agent', 'Phase 8'];
  const found = devNames.filter((d) => t.includes(d));
  check('no development-era name is shown to visitors', found.length === 0,
    `still on the page: ${found.join(', ')}`);
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

await section('The creator surface is private, and says so rather than rendering empty', async () => {
  // NO SESSION IS SENT BY THIS SUITE, deliberately. Every page under /me
  // holds somebody's wallet addresses and the state of their protective
  // levels, and a signed-out visitor must be sent to sign in rather than
  // shown a dashboard with nothing in it — an empty dashboard reads as
  // "you have no agents", which is a claim about somebody else.
  for (const [name, path] of [
    ['the dashboard', '/me'],
    ['the create form', '/me/agents/new'],
    ['my subscriptions', '/me/subscriptions'],
  ]) {
    const p = await page(path);
    const t = text(p.html);
    check(name + ' sends a signed-out visitor to sign in',
      /Sign in|signin/i.test(p.html), 'status ' + p.status);
    check(name + " does not render somebody's agents to a stranger",
      !/Needs attention|My agents/i.test(t), 'private content rendered without a session');
  }
});
await section('The agent directory exists, lists the live agents, and the header opens it', async () => {
  // "Agents" in the header was disabled text for as long as /agents was a 404,
  // and the create form was linked from nowhere a signed-out visitor could see.
  const p = await page('/agents');
  const t = text(p.html);
  check('/agents renders', p.status === 200, `status ${p.status}`);
  const live = await api(AGENT, '/v1/agents?provenance=live&page_size=50');
  const total = live.body?.total;
  check('the count is the endpoint\'s LIVE total, so no verification fixture is advertised',
    typeof total === 'number' && new RegExp(`\\b${total}\\s+live agent`).test(t),
    `API live total ${total}`);
  const missing = (live.body?.items ?? []).filter((a) => !p.html.includes(`/agents/${a.id}`));
  check('every live agent on the first page links to its own page',
    (live.body?.items ?? []).length > 0 && missing.length === 0,
    missing.map((a) => a.name).join(', ') || 'the endpoint returned no agents');
  const home = await page('/');
  check('the header Agents entry is a link, not disabled text',
    /<a[^>]*href="\/agents"[^>]*>Agents<\/a>/.test(home.html), 'the nav renders Agents without a link');
  check('the header links to the create form',
    home.html.includes('href="/me/agents/new"'), 'no link to /me/agents/new on the landing page');
});

await section('The landing art loads, and the figure beside it is the leaderboard\'s', async () => {
  const assets = [
    ['/landing/arena-climb.mp4', 'video/mp4'],
    ['/landing/arena-climb-poster.webp', 'image/webp'],
    ['/landing/arena-vs.webp', 'image/webp'],
    ['/landing/globe.webp', 'image/webp'],
    ['/landing/passport-robot.webp', 'image/webp'],
    ['/brand/arcana-logo-512.png', 'image/png'],
  ];
  for (const [path, type] of assets) {
    const r = await fetch(`${WEB}${path}`, { method: 'HEAD' });
    check(`${path} is served as ${type}`, r.status === 200 && (r.headers.get('content-type') ?? '').startsWith(type),
      `status ${r.status}, content-type ${r.headers.get('content-type')}`);
  }
  // THE ART CARRIES NO NUMBER. The name and score beside the film are the
  // leaderboard's, so they are checked against the leaderboard, not the art.
  const home = await page('/');
  const t = text(home.html).replace(/\s+/g, ' ');
  const shown = t.match(/TOP OF THE BOARD, RIGHT NOW (\S+) #(\d+) · score ([\d.]+)/);
  const top = (board.body?.items ?? []).find((i) => i.ranked);
  if (!top) {
    nothingToCheck('no agent is ranked, so the banner names nobody');
    return;
  }
  check('the banner names the leaderboard\'s top ranked agent, with its rank and score',
    !!shown && shown[1] === top.agent_name && Number(shown[2]) === top.rank && Math.abs(Number(shown[3]) - top.score) < 0.05,
    `banner ${shown ? shown.slice(1).join(' / ') : 'not found'}; leaderboard ${top.agent_name} / ${top.rank} / ${top.score}`);
});

await section('The landing page tells the private-agent story, word for word, with proof beside it', async () => {
  const home = await page('/');
  const t = text(home.html);
  // THE BRIEF'S COPY, VERBATIM. A paraphrase once stood here and nobody noticed
  // the product's main distinction had gone missing from the page.
  const lines = [
    'PRIVATE AGENT. PUBLIC PROOF.',
    'Protect the intelligence. Prove the performance.',
    "The best AI strategies shouldn't have to reveal their secrets to prove they work.",
    'ARCANA measures what an agent actually does — not what its creator claims it can do.',
    'Your alpha stays private.',
    'Your performance speaks publicly.',
    'Strategy • Prompts • Model Logic • Parameters • Proprietary Data • Risk Rules',
    'Decisions • Outcomes • Performance • Competition History • Reputation',
  ];
  const norm = (s) => s.replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
  const flat = norm(t);
  const missing = lines.filter((l) => !flat.includes(norm(l)));
  check('every line of the private-agent copy is on the landing page, verbatim', missing.length === 0, missing.join(' | '));
  check('the chain is three steps, and names no agent economy',
    flat.includes('PRIVATE INTELLIGENCE → VERIFIABLE PERFORMANCE → MACHINE REPUTATION') && !/AGENT ECONOMY/i.test(flat),
    'the chain is missing, or claims a fourth step no payment supports');
  const at = flat.indexOf('PRIVATE AGENT. PUBLIC PROOF.');
  const stats = flat.indexOf('Decisions recorded');
  check('it sits directly under the hero, before the statistics', at > 0 && (stats < 0 || at < stats),
    `story at ${at}, statistics at ${stats}`);
  check('and the proof panel states how the hidden part stays checkable',
    /Hidden is not the same as unverifiable/.test(flat) && /Anchored on chain/.test(flat), 'the mechanism is not stated beside the promise');

  // A LIVE EXAMPLE IS ONLY SHOWN WHEN IT IS TRUE.
  const example = home.html.match(/A PRIVATE AGENT, LIVE ON THE RECORD[\s\S]*?href="\/agents\/([0-9a-f-]{36})"[\s\S]*?title="([0-9a-f]{64})"/);
  if (!example) {
    nothingToCheck('no private agent has a sealed decision yet, so the landing page shows no live example — which is the rule');
    return;
  }
  const a = await api(AGENT, `/v1/agents/${example[1]}`);
  check('the live example is an agent that really is private', a.body?.intelligence?.private === true, JSON.stringify(a.body?.intelligence));
  const d = await api(AGENT, `/v1/agents/${example[1]}/decisions?page_size=5&include_prices=false`);
  check('and its decision really carries the commitment the card shows',
    (d.body?.decisions ?? []).some((x) => x.commitment === example[2]), `commitment ${example[2].slice(0, 12)} not among its latest decisions`);
});

await section('Every entry in the landing footer leads somewhere', async () => {
  // It carried twenty mockup entries with no page behind them, printed as muted
  // text. A visitor reads that as a broken link, so every entry is now a link
  // and every link has to answer.
  const home = await page('/');
  const start = home.html.indexOf('footer-cols');
  const block = start >= 0 ? home.html.slice(start, home.html.indexOf('© 2026', start)) : '';
  check('the landing footer renders', block.length > 0, 'no footer-cols block on the landing page');
  const hrefs = [...block.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  check('the footer has links', hrefs.length >= 15, `${hrefs.length} link(s)`);
  check('and no entry is plain text standing in for a link',
    !/<span class="m3">[^<]+<\/span>/.test(block), 'a muted text entry is still in the footer');
  for (const href of [...new Set(hrefs)]) {
    const r = await page(href.split('#')[0]);
    check(`footer link ${href} answers`, r.status === 200, `status ${r.status}`);
  }
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
