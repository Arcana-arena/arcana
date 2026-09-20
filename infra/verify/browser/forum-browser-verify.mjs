/**
 * forum-browser-verify.mjs — the social layer, USED, in a real browser.
 *
 * WHAT forum-verify CANNOT SEE. It calls the API and it fetches server-rendered
 * HTML, and every check in it passes on a page whose client components never
 * hydrate. But like, save, the reply box, the markdown preview and the
 * moderation controls are ALL client components: they are React state and a
 * server action, and a page that throws on hydration serves perfect HTML with
 * dead buttons. So the suite that says "forum works" was, until this file,
 * saying "the forum's server half works".
 *
 * SO THIS CLICKS THINGS. It signs in with a real signature, starts a thread by
 * typing into the form, likes it, watches the count change WITHOUT a reload,
 * reloads and requires the count to still be there — because a count that moves
 * in the page and not in the database is exactly the optimistic-rendering bug
 * ReactionBar was written to avoid, and only a reload can tell the two apart.
 * Then it writes an article, comments on it, and checks the markdown it typed
 * came back as markup rather than as asterisks.
 *
 * THE WALLET IS FAKE, THE SIGNATURE IS NOT — the same injection signin-verify
 * uses: `window.ethereum` forwards personal_sign to a real secp256k1 signature
 * over the real message. Everything from the message bytes onwards is the
 * production path.
 *
 * THE CREATOR PROFILE IS MADE THROUGH THE API FIRST, not through the UI, and
 * that is deliberate: a profile created by the browser would be provenance
 * 'live' and the fixture sweep would refuse to touch it, leaving a stranger's
 * handle in the creators table for good. Made through the API with the
 * verification header it is a fixture, and the purge at the end removes it.
 *
 *   ORIGIN=https://arcana-arena.com node infra/verify/browser/forum-browser-verify.mjs
 */
import puppeteer from '/tmp/pptr/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { signIn as sharedSignIn, SIWE_DOMAIN, SIWE_URI, VERIFICATION_HEADER } from '../lib/rate-aware.mjs';
import { suite } from '../lib/sections.mjs';

const ORIGIN = process.env.ORIGIN || 'https://arcana-arena.com';
const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const DB = process.env.DATABASE_URL || 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';

const { check, section, report } = suite('forum-browser-verify');

const sql = (q) =>
  execFileSync('psql', [DB, '-At', '-q', '-c', q], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const TAG = `verify_fbrowse_${randomUUID().replace(/-/g, '').slice(0, 8)}`;

/** Same order and same reasoning as forum-verify's purge. */
function purge(handleLike) {
  try {
    sql(
      `DELETE FROM articles WHERE creator_id IN (SELECT id FROM creators WHERE handle LIKE '${handleLike}');
       DELETE FROM creators WHERE handle LIKE '${handleLike}';`,
    );
  } catch (e) {
    console.log('  cleanup warning: ' + e.message);
  }
}
purge('verify_fbrowse_%');
process.on('exit', () => purge(`${TAG}%`));

/** Click the first button whose visible text contains `text`. */
async function clickText(page, text) {
  const done = await page.evaluate((t) => {
    const el = [...document.querySelectorAll('button, a.btn')].find((b) =>
      (b.innerText || '').toLowerCase().includes(t.toLowerCase()));
    if (!el) return false;
    el.click();
    return true;
  }, text);
  if (!done) throw new Error(`no clickable element containing "${text}"`);
  await new Promise((r) => setTimeout(r, 700));
}

const bodyText = (page) => page.evaluate(() => document.body.innerText);

let browser = null;
try {
  const account = privateKeyToAccount(generatePrivateKey());
  console.log(`      origin ${ORIGIN}`);
  console.log(`      test wallet ${account.address}`);

  // ---- a creator profile, made as a fixture ------------------------------
  const s = await sharedSignIn(AGENT, account, { chainId: 4663, domain: SIWE_DOMAIN, uri: SIWE_URI });
  if (s.status !== 200 || !s.body?.access_token) {
    check('the test wallet can sign in through the API', false, `status ${s.status}`);
    throw new Error('cannot continue without a session');
  }
  const made = await fetch(`${AGENT}/v1/creators`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${s.body.access_token}`,
      ...VERIFICATION_HEADER,
    },
    body: JSON.stringify({ handle: `${TAG}_writer` }),
  });
  const creator = await made.json();
  if (!creator?.id) {
    check('a fixture creator profile is made for it', false, JSON.stringify(creator));
    throw new Error('cannot continue without a creator');
  }

  browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });

  // EVERY uncaught error and every failed request, for the whole session. A
  // hydration failure shows up here and nowhere else.
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('requestfailed', (r) => {
    const err = r.failure()?.errorText;
    if (r.url().includes('_rsc=') && err === 'net::ERR_ABORTED') return;
    failedRequests.push(`${r.url().slice(0, 100)} :: ${err}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url().slice(0, 100)}`);
  });

  await page.exposeFunction('__testSign', async (message) => account.signMessage({ message }));
  await page.exposeFunction('__testAccounts', async () => [account.address]);
  await page.evaluateOnNewDocument(() => {
    window.ethereum = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return window.__testAccounts();
        if (method === 'personal_sign') return window.__testSign(params[0]);
        throw new Error(`the test wallet does not implement ${method}`);
      },
    };
  });

  let threadUrl = null;
  let articleUrl = null;

  // =====================================================================
  await section('1. The forum is readable before anyone signs in', async () => {
    await page.goto(`${ORIGIN}/forum`, { waitUntil: 'networkidle0', timeout: 45000 });
    const t = await bodyText(page);
    check('the boards page paints its boards',
      /General Discussion/.test(t) && /Strategy Talk/.test(t) && /Agent Reviews/.test(t),
      t.slice(0, 200));
    check('and says plainly that nothing here moves a score',
      /nothing written here moves a score/i.test(t), 'the disclaimer is missing');
    check('a signed-out visitor is invited to sign in rather than shown a dead button',
      /Sign in/i.test(t), t.slice(0, 200));
    check('no uncaught error while signed out', pageErrors.length === 0, pageErrors.join(' | '));
  });

  // =====================================================================
  await section('2. Signing in, in the browser, with a real signature', async () => {
    await page.goto(`${ORIGIN}/signin`, { waitUntil: 'networkidle0', timeout: 45000 });
    await page.waitForFunction(
      () => !/checking what this page can do/.test(document.body.innerText), { timeout: 15000 });
    const refuses = await page.evaluate(() => /cannot complete a sign-in yet/.test(document.body.innerText));
    if (refuses) {
      // Not a pass and not a silent skip: this suite cannot run here, and the
      // reason is a configured domain, not a broken forum.
      check('this deployment can complete a sign-in at this origin', false,
        `the page refuses to sign at ${ORIGIN} — set ORIGIN to the configured AUTH_SIWE_DOMAIN`);
      throw new Error('cannot exercise the writing paths without a session');
    }
    await clickText(page, 'Sign in');
    await page.waitForFunction(() => !/^\/signin/.test(location.pathname), { timeout: 45000 });
    await new Promise((r) => setTimeout(r, 800));
    check('signing in lands on the dashboard', new URL(page.url()).pathname === '/me',
      `on ${page.url()}`);
    check('and the session token is not readable by scripts',
      !/arcana_at|arcana_rt/.test(await page.evaluate(() => document.cookie)),
      'the token was in document.cookie');
  });

  // =====================================================================
  await section('3. Starting a thread by typing into the form', async () => {
    await page.goto(`${ORIGIN}/forum/strategy`, { waitUntil: 'networkidle0', timeout: 45000 });
    await clickText(page, 'Start a thread');

    const title = `${TAG} does a tighter band help`;
    await page.type('#t-title', title);
    await page.type('#t-body', 'Opening post from a real browser.\n\n**Bold** and `code`.');

    // THE PREVIEW IS THE SAME RENDERER THE PAGE USES, which is only worth
    // anything if it actually renders. Asterisks in the preview would mean the
    // markdown component never ran.
    await clickText(page, 'Preview');
    const previewHtml = await page.evaluate(() => document.body.innerHTML);
    check('the preview renders markdown rather than showing the asterisks',
      /<strong>Bold<\/strong>/.test(previewHtml) && /<code/.test(previewHtml),
      'no <strong> or <code> in the preview');
    await clickText(page, 'Edit');

    await clickText(page, 'Post thread');
    await page.waitForFunction(() => /\/forum\/thread\//.test(location.pathname), { timeout: 30000 });
    threadUrl = page.url();
    const t = await bodyText(page);
    check('posting navigates to the new thread', /\/forum\/thread\//.test(threadUrl), threadUrl);
    check('which shows the title that was typed', t.includes(title), t.slice(0, 200));
    check('and the body, rendered', /Opening post from a real browser/.test(t), t.slice(0, 300));
  });

  // =====================================================================
  await section('4. Liking is a write, not a number that moves in the page', async () => {
    if (!threadUrl) { check('a thread exists to like', false, 'section 3 did not produce one'); return; }

    const likeCount = () => page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').includes('♥'));
      return b ? b.innerText.replace(/[^0-9]/g, '') : null;
    });

    const before = await likeCount();
    check('the like button is rendered for a signed-in reader', before !== null,
      'no ♥ button on the page');
    await clickText(page, '♥');
    await page.waitForFunction(
      (was) => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').includes('♥'));
        return b && b.innerText.replace(/[^0-9]/g, '') !== was;
      },
      { timeout: 15000 }, before);
    const after = await likeCount();
    check('clicking it changes the count in the page', after === String(Number(before) + 1),
      `${before} -> ${after}`);

    // THE RELOAD IS THE POINT. A count that moved only in React would pass the
    // check above and be a lie; this is the one that says the row exists.
    await page.reload({ waitUntil: 'networkidle0' });
    const reloaded = await likeCount();
    check('and the count survives a reload, so the like reached the database',
      reloaded === after, `after click ${after}, after reload ${reloaded}`);

    const inDb = sql(
      `SELECT count(*) FROM content_reactions r JOIN creators c ON c.id = r.creator_id
        WHERE c.handle LIKE '${TAG}%' AND r.kind = 'like'`);
    check('and there is exactly one row behind it', inDb === '1', `rows=${inDb}`);
  });

  // =====================================================================
  await section('5. Replying through the composer', async () => {
    if (!threadUrl) { check('a thread exists to reply to', false, 'section 3 did not produce one'); return; }
    await page.goto(threadUrl, { waitUntil: 'networkidle0' });

    await page.type('textarea', `A reply typed in a browser — ${TAG}`);
    await clickText(page, 'Post reply');
    await page.waitForFunction(
      (tag) => document.body.innerText.includes(`A reply typed in a browser — ${tag}`),
      { timeout: 30000 }, TAG);

    const t = await bodyText(page);
    check('the reply appears without a manual reload', t.includes('A reply typed in a browser'),
      t.slice(0, 300));
    check('and the thread now counts one reply', /1 reply\b/.test(t), t.slice(0, 300));
  });

  // =====================================================================
  await section('6. Writing an article, and commenting on it', async () => {
    await page.goto(`${ORIGIN}/me/articles/new`, { waitUntil: 'networkidle0', timeout: 45000 });
    const title = `${TAG} written in a browser`;
    await page.type('#a-title', title);
    await page.type('#a-body', '## A heading\n\nA paragraph with **bold** in it.');
    await clickText(page, 'Publish article');
    await page.waitForFunction(() => /^\/articles\//.test(location.pathname), { timeout: 30000 });
    articleUrl = page.url();

    const html = await page.evaluate(() => document.body.innerHTML);
    const t = await bodyText(page);
    check('publishing navigates to the article', /\/articles\//.test(articleUrl), articleUrl);
    check('the markdown heading became a heading, not two hashes',
      /<h3[^>]*>A heading<\/h3>/.test(html) && !t.includes('## A heading'),
      'the heading was not rendered');
    check('and the bold became bold', /<strong>bold<\/strong>/.test(html), 'no <strong> in the article');
    check('an article naming no agent says so rather than showing an empty card',
      /carries no thesis and names no agent/i.test(t), t.slice(0, 400));

    await page.type('textarea', `A comment typed in a browser — ${TAG}`);
    await clickText(page, 'Post comment');
    await page.waitForFunction(
      (tag) => document.body.innerText.includes(`A comment typed in a browser — ${tag}`),
      { timeout: 30000 }, TAG);
    const after = await bodyText(page);
    check('the comment appears under the article', after.includes('A comment typed in a browser'),
      after.slice(0, 300));

    const comments = sql(
      `SELECT count(*) FROM forum_posts p JOIN creators c ON c.id = p.creator_id
        WHERE c.handle LIKE '${TAG}%' AND p.article_id IS NOT NULL`);
    check('and it is stored as a forum_post, the same table as a thread reply',
      comments === '1', `rows=${comments}`);
  });

  // =====================================================================
  await section('7. Nothing threw in the browser, the whole way through', async () => {
    check('no uncaught exception on any page', pageErrors.length === 0, pageErrors.join(' | '));
    check('no console error on any page', consoleErrors.length === 0, consoleErrors.join(' | '));
    check('no failed request on any page', failedRequests.length === 0, failedRequests.join(' | '));
  });

  await browser.close();
  browser = null;
  process.exit(report());
} catch (e) {
  console.log(`\n  FAIL  the suite threw before finishing — ${e && e.message}`);
  if (browser) await browser.close();
  report();
  process.exit(1);
}
