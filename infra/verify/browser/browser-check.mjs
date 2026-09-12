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

const PAGES = [
  ['landing', '/'],
  ['leaderboard', '/leaderboard'],
  ['leaderboard-performance', '/leaderboard?category=performance'],
  ['leaderboard-unranked', '/leaderboard?include_unranked=true'],
  ['marketplace', '/marketplace'],
  ['seasons', '/seasons'],
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
  // The not-found page is deliberately short. Every other page must have
  // painted real content, not just a header.
  const minText = expected404 ? 100 : 600;
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

// Phone width, on the one page densest with tables.
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 900 });
await page.goto(`${BASE}/leaderboard`, { waitUntil: 'networkidle0', timeout: 45000 });
const narrow = await page.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
}));
await page.screenshot({ path: '/tmp/shots/leaderboard-390.png', fullPage: false });
const narrowOk = narrow.scrollWidth <= narrow.clientWidth + 1;
if (!narrowOk) failures++;
console.log(
  `${narrowOk ? 'PASS' : 'FAIL'}  leaderboard at 390px      ` +
    `${narrow.scrollWidth} <= ${narrow.clientWidth}`,
);
await page.close();

await browser.close();
writeFileSync('/tmp/shots/report.json', JSON.stringify(rows, null, 1));
console.log(`\n${rows.length + 1} page loads, ${failures} with problems`);
process.exit(failures === 0 ? 0 : 1);
