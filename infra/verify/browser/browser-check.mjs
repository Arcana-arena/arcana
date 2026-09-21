/**
 * Open every public page in a real browser and report what actually happened.
 *
 * Server-rendered HTML can be correct and the page still broken: a client
 * component can throw on hydration, a stylesheet can fail to load, a font can
 * 404. curl sees none of that. This drives Chromium, records every console
 * error, every failed request and every uncaught exception, measures how much
 * text the page really painted, and screenshots each one.
 */
import puppeteer from '/tmp/pptr/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js';
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const AGENT_ID = process.env.AGENT_ID;
const LISTING_ID = process.env.LISTING_ID;
const SEASON_ID = process.env.SEASON_ID;

// EVERY DOCUMENTATION PAGE IS OPENED, not a sample of them. Each one carries a
// copy button, which is the only client component in the docs, and a page that
// throws on hydration still server-renders perfectly — which is the whole
// reason this file drives a real browser.
// KEPT IN STEP WITH content.tsx BY HAND, which is a list that has already
// drifted: `private-agents` shipped and was never added here, so the one page
// explaining what a private agent withholds went unopened by every browser run
// since. Both it and `roadmap` are here now. A slug added to PAGES and not to
// this list is a documentation page nothing ever loads in a browser.
const DOC_SLUGS = [
  'what-arcana-is', 'how-it-works', 'roadmap', 'creating-an-agent', 'writing-a-mandate',
  'triggers-and-protection', 'wallets-and-custody', 'private-agents', 'scoring', 'dna',
  'autopsy', 'marketplace', 'arca', 'api', 'faq',
];

const PAGES = [
  ['landing', '/'],
  ['leaderboard', '/leaderboard'],
  ['leaderboard-performance', '/leaderboard?category=performance'],
  ['leaderboard-unranked', '/leaderboard?include_unranked=true'],
  ['marketplace', '/marketplace'],
  ['marketplace-filtered', '/marketplace?sort=return&buyable_only=true'],
  ['seasons', '/seasons'],
  ...(SEASON_ID ? [['season-detail', `/seasons/${SEASON_ID}`]] : []),
  ...(LISTING_ID ? [['listing-detail', `/marketplace/${LISTING_ID}`]] : []),
  ['status', '/status'],
  ...DOC_SLUGS.map((s) => [`docs-${s}`, `/docs/${s}`]),
  ['docs-search', '/docs/scoring?q=drawdown'],
  ['signin', '/signin'],
  // THE CREATOR SURFACE, SIGNED OUT. Each of these must send a visitor to sign
  // in rather than render an empty dashboard, and the browser is where a
  // redirect that only half works shows up.
  ['me-signed-out', '/me'],
  ['me-new-agent-signed-out', '/me/agents/new'],
  ['agents-directory', '/agents'],
  ...(AGENT_ID
    ? ['overview', 'decisions', 'dna', 'autopsy', 'passport', 'evolution', 'positions'].map((t) => [
        `agent-${t}`,
        `/agents/${AGENT_ID}?tab=${t}`,
      ])
    : []),
  ['not-found', '/no-such-page-here'],
];

const browser = await puppeteer.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

let failures = 0;
const rows = [];

for (const [name, path] of PAGES) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
  // A CANCELLED PREFETCH IS NOT A FAILURE. Next prefetches every route a page
  // links to as `?_rsc=...`, and Chromium aborts those the moment the page is
  // navigated away from or closed. They arrive here as ERR_ABORTED and mean
  // only that nobody waited. Every OTHER failed request — including an aborted
  // one that is not a prefetch — is still reported.
  page.on('requestfailed', (r) => {
    const err = r.failure()?.errorText;
    if (r.url().includes('_rsc=') && err === 'net::ERR_ABORTED') return;
    failedRequests.push(`${r.url().slice(0, 120)} :: ${err}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().includes('/no-such-page-here')) {
      failedRequests.push(`${r.status()} ${r.url().slice(0, 120)}`);
    }
  });

  const resp = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle0', timeout: 45000 });
  // Give hydration a moment to throw if it is going to.
  await new Promise((r) => setTimeout(r, 600));

  const info = await page.evaluate(() => {
    const bodyText = document.body.innerText || '';
    const cs = getComputedStyle(document.body);
    const h1 = document.querySelector('h1');
    return {
      textLength: bodyText.length,
      background: cs.backgroundColor,
      color: cs.color,
      fontFamily: cs.fontFamily,
      monoCount: Array.from(document.querySelectorAll('.mono')).length,
      monoFont: (() => {
        const el = document.querySelector('.mono');
        return el ? getComputedStyle(el).fontFamily : null;
      })(),
      heading: h1 ? h1.innerText.slice(0, 60) : null,
      // An explicit empty state is PAINTED CONTENT, not a blank frame. A tab
      // that says "this agent has only one version" is doing its job and is
      // legitimately short; the thing this check exists to catch is a page
      // that rendered nothing at all.
      statusTitle: (() => {
        const el = document.querySelector(".status-title");
        return el ? el.innerText.slice(0, 80) : null;
      })(),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      errorBoundary: /This page failed to render/.test(bodyText),
    };
  });

  await page.screenshot({ path: `/tmp/shots/${name}.png`, fullPage: false });

  const expected404 = name === 'not-found';
  const status = resp?.status() ?? 0;
  const problems = [];
  if (expected404 ? status !== 404 : status !== 200) problems.push(`status ${status}`);
  if (info.errorBoundary) problems.push('error boundary rendered');
  // The not-found page is deliberately short, and so is any tab whose honest
  // answer is an empty state — "this agent has only one version" is a finding,
  // not a failure to render. A page showing one is required to have painted its
  // title; everything else has to carry real content.
  const minText = expected404 || info.statusTitle ? 100 : 600;
  if (info.textLength < minText) {
    problems.push(`only ${info.textLength} chars of visible text, expected at least ${minText}`);
  }
  if (pageErrors.length) problems.push(`uncaught: ${pageErrors.join(' | ')}`);
  // The not-found page IS a 404, and Chromium logs the document's own status as
  // a console error. That is the page working. Any other console error on it,
  // and every console error anywhere else, still counts.
  const consoleReal = consoleErrors.filter(
    (t) => !(expected404 && /Failed to load resource.*404/.test(t)),
  );
  if (consoleReal.length) problems.push(`console: ${consoleReal.join(' | ')}`);
  if (failedRequests.length) problems.push(`requests: ${failedRequests.join(' | ')}`);
  if (info.background !== 'rgb(5, 11, 7)') problems.push(`body background is ${info.background}, expected the #050b07 token`);
  if (info.monoCount > 0 && !/JetBrains/i.test(info.monoFont || '')) {
    problems.push(`numbers are not in JetBrains Mono: ${info.monoFont}`);
  }
  if (info.scrollWidth > info.clientWidth + 1) {
    problems.push(`the page scrolls sideways (${info.scrollWidth} > ${info.clientWidth})`);
  }

  if (problems.length) failures++;
  rows.push({ name, path, status, ...info, problems });
  console.log(
    `${problems.length ? 'FAIL' : 'PASS'}  ${name.padEnd(24)} ${String(status).padEnd(4)} ` +
      `${String(info.textLength).padStart(6)} chars  ${info.heading ?? ''}` +
      (problems.length ? `\n        ${problems.join('\n        ')}` : ''),
  );

  await page.close();
}

// Phone width, on the pages densest with fixed-width tracks.
//
// A three-column docs layout, a two-column listing page and a table-heavy
// leaderboard are the three shapes most likely to widen a 390px viewport, and a
// page that scrolls sideways on a phone is unusable in a way no desktop check
// notices. A 320px fixed track once widened the seasons page to 359 here.
// The landing hero and an agent's Overview tab both scrolled sideways on a
// phone (516px and 674px) for as long as nothing here opened them at 390px.
for (const [name, path] of [
  ['landing', '/'],
  ['agents', '/agents'],
  ...(AGENT_ID ? [['agent', `/agents/${AGENT_ID}`], ['agent-positions', `/agents/${AGENT_ID}?tab=positions`]] : []),
  ['leaderboard', '/leaderboard'],
  ['docs', '/docs/scoring'],
  ['marketplace', '/marketplace'],
  ['status', '/status'],
  ...(LISTING_ID ? [['listing', `/marketplace/${LISTING_ID}`]] : []),
  ...(SEASON_ID ? [['season', `/seasons/${SEASON_ID}`]] : []),
]) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 900 });
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle0', timeout: 45000 });
  const narrow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    headerHeight: Math.round(document.querySelector('.hdr')?.getBoundingClientRect().height ?? 0),
  }));
  await page.screenshot({ path: `/tmp/shots/${name}-390.png`, fullPage: false });
  // AND THE BAR STAYS ONE ROW. It wrapped to 98px — a quarter of the first
  // screen — until the nav folded into a menu on a phone.
  const narrowOk = narrow.scrollWidth <= narrow.clientWidth + 1 && narrow.headerHeight > 0 && narrow.headerHeight <= 64;
  if (!narrowOk) failures++;
  console.log(
    `${narrowOk ? 'PASS' : 'FAIL'}  ${name} at 390px`.padEnd(38) +
      `${narrow.scrollWidth} <= ${narrow.clientWidth}, header ${narrow.headerHeight}px`,
  );
  await page.close();
}

await browser.close();
writeFileSync('/tmp/shots/report.json', JSON.stringify(rows, null, 1));
console.log(`\n${rows.length + 1} page loads, ${failures} with problems`);
process.exit(failures === 0 ? 0 : 1);
