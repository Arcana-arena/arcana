/**
 * thesis-article-browser-verify.mjs — publishing a thesis, and everything a
 * reader can press on /articles/:id, done in a real browser.
 *
 * WHAT THE OTHER SUITES LEAVE UNPROVEN. thesis-verify drives the API and reads
 * server-rendered HTML; forum-browser-verify posts one comment on an article
 * that carries nothing. Neither ever touched ThesisForm, the article form's
 * thesis picker, save, un-like, the edit round trip, or report and hide — and
 * every one of those is a client component that serves perfect HTML while its
 * buttons are dead. This file presses each of them.
 *
 * THE ORDER IS THE FEATURE'S OWN ORDER: publish a thesis from the form, carry
 * it in an article from the picker that was permanently disabled before day 1,
 * then use that article the way a reader and its author would. Each write is
 * followed by a reload or a psql count, because a number that moved in React
 * and nowhere else passes every in-page assertion.
 *
 * THE PRIVATE AGENT IS HERE ON PURPOSE. ThesisForm offers every active agent
 * because visibility is not in the dashboard read, and explains the refusal
 * afterwards. That explanation is the one branch of the form a person is
 * certain to meet, so it is exercised, and the database is asked whether the
 * refusal really wrote nothing.
 *
 * CLEANUP IS TWO STEPS. A thesis cannot be deleted by the application — the
 * immutability trigger refuses it — and it holds its agent by a foreign key,
 * so the shared fixture sweep alone would roll back on the first agent. The
 * purge below removes this run's articles and theses first (the same door
 * thesis-verify uses), and the shared sweep then takes the agents and creator.
 *
 *   ORIGIN=https://arcana-arena.com node infra/verify/browser/thesis-article-browser-verify.mjs
 */
import puppeteer from '/tmp/pptr/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { signIn as sharedSignIn, SIWE_DOMAIN, SIWE_URI, VERIFICATION_HEADER } from '../lib/rate-aware.mjs';
import { sweepOnExit } from '../lib/fixtures.mjs';
import { suite } from '../lib/sections.mjs';

const ORIGIN = process.env.ORIGIN || 'https://arcana-arena.com';
const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const DB = process.env.DATABASE_URL || 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';

const { check, section, report } = suite('thesis-article-browser-verify');

const sql = (q) =>
  execFileSync('psql', [DB, '-At', '-q', '-c', q], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const TAG = `verify_tabrowse_${randomUUID().replace(/-/g, '').slice(0, 8)}`;

/**
 * Articles, then theses, for creators matching the pattern. The trigger is
 * disabled only for the length of the delete, exactly as thesis-verify does.
 */
function purge(handleLike) {
  const mine = `(SELECT id FROM creators WHERE handle LIKE '${handleLike}')`;
  try {
    sql(`ALTER TABLE public_theses DISABLE TRIGGER public_theses_immutable;
         DELETE FROM articles WHERE creator_id IN ${mine};
         DELETE FROM public_theses WHERE creator_id IN ${mine};
         ALTER TABLE public_theses ENABLE TRIGGER public_theses_immutable;`);
  } catch (e) {
    console.log('  cleanup warning: ' + e.message);
  }
}
purge('verify_tabrowse_%');
// Registered before the sweep, so it runs first: the sweep cannot delete an
// agent a thesis still points at.
process.on('exit', () => purge(`${TAG}%`));
sweepOnExit('thesis-article-browser-verify');

/** Click the first button (else a.btn) inside `scope` whose text contains `text`. */
async function clickIn(page, scope, text) {
  const done = await page.evaluate((s, t) => {
    const root = s ? document.querySelector(s) : document;
    if (!root) return false;
    const matches = (b) => (b.innerText || '').toLowerCase().includes(t.toLowerCase());
    const el = [...root.querySelectorAll('button')].find(matches)
      ?? [...root.querySelectorAll('a.btn')].find(matches);
    if (!el) return false;
    el.click();
    return true;
  }, scope, text);
  if (!done) throw new Error(`no clickable element containing "${text}"${scope ? ` in ${scope}` : ''}`);
  await new Promise((r) => setTimeout(r, 700));
}
const clickText = (page, text) => clickIn(page, null, text);

const bodyText = (page) => page.evaluate(() => document.body.innerText);
const waitText = (page, s, timeout = 20000) =>
  page.waitForFunction((x) => document.body.innerText.includes(x), { timeout }, s);

/** The button that publishes the thesis — disabled is the gate being asserted. */
const publishDisabled = (page) =>
  page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /Publish thesis|Publishing/.test(x.innerText));
    return b ? b.disabled : null;
  });

/** Like and save counts as the ReactionBar paints them. */
const reactions = (page) =>
  page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const like = btns.find((x) => (x.innerText || '').includes('♥'));
    const save = btns.find((x) => /[☆★]/.test(x.innerText || ''));
    return {
      like: like ? like.innerText.replace(/[^0-9]/g, '') : null,
      liked: like ? like.getAttribute('aria-pressed') : null,
      save: save ? save.innerText.replace(/[^0-9]/g, '') : null,
      saved: save ? save.getAttribute('aria-pressed') : null,
    };
  });

let browser = null;
try {
  const account = privateKeyToAccount(generatePrivateKey());
  console.log(`      origin ${ORIGIN}`);
  console.log(`      test wallet ${account.address}`);

  // ---- fixtures through the API: a creator, one public agent, one private --
  const s = await sharedSignIn(AGENT, account, { chainId: 4663, domain: SIWE_DOMAIN, uri: SIWE_URI });
  if (s.status !== 200 || !s.body?.access_token) {
    check('the test wallet can sign in through the API', false, `status ${s.status}`);
    throw new Error('cannot continue without a session');
  }
  const api = async (path, body) => {
    const r = await fetch(`${AGENT}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${s.body.access_token}`,
        ...VERIFICATION_HEADER,
      },
      body: JSON.stringify(body ?? {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const creator = await api('/v1/creators', { handle: `${TAG}_author` });
  if (!creator.body?.id) {
    check('a fixture creator profile is made', false, JSON.stringify(creator.body));
    throw new Error('cannot continue without a creator');
  }
  const riskProfile = JSON.stringify({
    cash_floor_pct: 0.05, trade_size_pct: 0.5, max_position_pct: 1, rebalance_band_pct: 0.0002,
  });
  const agents = {};
  for (const visibility of ['public', 'private']) {
    const a = await api('/v1/agents', {
      name: `${TAG}_${visibility}`, strategyType: 'momentum', assetUniverse: 'us_equities', riskProfile, visibility,
    });
    if (!a.body?.id) {
      check(`a ${visibility} fixture agent is made`, false, `status ${a.status} ${JSON.stringify(a.body)}`);
      throw new Error('cannot continue without both agents');
    }
    await api(`/v1/agents/${a.body.id}/activate`);
    agents[visibility] = a.body.id;
  }

  browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });

  // Same accounting as forum-browser-verify, for the same reasons: a hydration
  // failure shows up here and nowhere else; a prefetch 429 is this suite's own
  // traffic meeting the limiter; an abort on our own origin is a navigation
  // this script superseded.
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  const rateLimitedPrefetches = [];
  const abortedNavigations = [];
  const watch = (p) => {
    p.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
    p.on('console', (m) => {
      if (m.type() !== 'error' || /status of 429/.test(m.text())) return;
      consoleErrors.push(m.text().slice(0, 200));
    });
    p.on('requestfailed', (r) => {
      const err = r.failure()?.errorText;
      if (err === 'net::ERR_ABORTED' && r.url().startsWith(ORIGIN)) {
        abortedNavigations.push(r.url().slice(0, 100));
        return;
      }
      failedRequests.push(`${r.url().slice(0, 100)} :: ${err}`);
    });
    p.on('response', (r) => {
      if (r.status() === 429 && r.url().includes('_rsc=')) {
        rateLimitedPrefetches.push(r.url().slice(0, 100));
        return;
      }
      if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url().slice(0, 100)}`);
    });
  };
  watch(page);

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

  const CLAIM = `${TAG} momentum beats SPY over the next month, by any margin at all.`;
  let thesisId = null;
  let articleId = null;
  let commentId = null;

  // =====================================================================
  await section('1. Signing in, in the browser', async () => {
    await page.goto(`${ORIGIN}/signin`, { waitUntil: 'networkidle0', timeout: 45000 });
    await page.waitForFunction(
      () => !/checking what this page can do/.test(document.body.innerText), { timeout: 15000 });
    if (await page.evaluate(() => /cannot complete a sign-in yet/.test(document.body.innerText))) {
      check('this deployment can complete a sign-in at this origin', false,
        `the page refuses to sign at ${ORIGIN} — set ORIGIN to the configured AUTH_SIWE_DOMAIN`);
      throw new Error('cannot exercise the writing paths without a session');
    }
    await clickText(page, 'Sign in with your wallet');
    await page.waitForFunction(() => !/^\/signin/.test(location.pathname), { timeout: 45000 });
    check('signing in lands on the dashboard', new URL(page.url()).pathname === '/me', `on ${page.url()}`);
  });

  // =====================================================================
  await section('2. The thesis form refuses to publish until it should', async () => {
    await page.goto(`${ORIGIN}/me/theses/new`, { waitUntil: 'networkidle0', timeout: 45000 });
    const offered = await page.$$eval('#t-agent option', (os) => os.map((o) => o.value));
    check('both active agents are offered', offered.includes(agents.public) && offered.includes(agents.private),
      `offered ${JSON.stringify(offered)}`);

    check('an empty form cannot be published', (await publishDisabled(page)) === true,
      `disabled=${await publishDisabled(page)}`);

    await page.type('#t-claim', CLAIM);
    const counter = await bodyText(page);
    check('the character counter follows what was typed',
      counter.includes(`${CLAIM.length} / 2,000`), 'no matching counter on the page');
    check('a claim alone is not enough — the permanence box is unticked',
      (await publishDisabled(page)) === true, `disabled=${await publishDisabled(page)}`);

    await page.click('input[type="checkbox"]');
    check('ticking the acknowledgement enables it', (await publishDisabled(page)) === false,
      `disabled=${await publishDisabled(page)}`);

    // A basket of one is not a basket, and the form should know that before
    // the service does.
    await page.select('#t-kind', 'basket');
    check('a basket of one symbol disables it again', (await publishDisabled(page)) === true,
      `disabled=${await publishDisabled(page)}`);
    await page.select('#t-kind', 'arcana_index');
    const indexShown = await page.evaluate(() => !document.querySelector('#t-symbols'));
    check('the market index takes no symbol field', indexShown, 'the symbol input is still there');
    await page.select('#t-kind', 'symbol');
    check('and one symbol is enough again', (await publishDisabled(page)) === false,
      `disabled=${await publishDisabled(page)}`);
  });

  // =====================================================================
  await section('3. A private agent is refused, and the refusal is explained', async () => {
    await page.select('#t-agent', agents.private);
    await clickText(page, 'Publish thesis');
    let explained = true;
    try {
      await waitText(page, 'That agent is private');
    } catch {
      explained = false;
    }
    check('the form says the agent is private rather than "something went wrong"', explained,
      (await bodyText(page)).slice(-600));
    check('it stays on the form, with the claim still typed',
      new URL(page.url()).pathname === '/me/theses/new'
        && (await page.$eval('#t-claim', (t) => t.value)) === CLAIM,
      `on ${page.url()}`);
    const rows = sql(`SELECT count(*) FROM public_theses t JOIN creators c ON c.id = t.creator_id
                       WHERE c.handle LIKE '${TAG}%'`);
    check('and nothing was written', rows === '0', `public_theses rows=${rows}`);
  });

  // =====================================================================
  await section('4. Publishing the thesis for the public agent', async () => {
    await page.select('#t-agent', agents.public);
    await clickText(page, 'Publish thesis');
    await page.waitForFunction(() => /^\/theses\/[0-9a-f-]{36}$/.test(location.pathname), { timeout: 30000 });
    thesisId = new URL(page.url()).pathname.split('/').pop();
    const t = await bodyText(page);
    check('publishing navigates to the thesis page', Boolean(thesisId), page.url());
    check('which states the claim that was typed', t.includes(CLAIM), t.slice(0, 300));
    check('and says it is pending', /pending/i.test(t), t.slice(0, 300));

    const row = sql(`SELECT linked_agent_id || '|' || (benchmark_ref->>'kind') || '|' ||
                            (benchmark_ref->'symbols'->>0) || '|' || (criteria->>'margin_pct') || '|' ||
                            to_char(resolves_at AT TIME ZONE 'UTC', 'HH24:MI:SS')
                       FROM public_theses WHERE id = '${thesisId}'`);
    check('the stored row is what the form showed: public agent, SPY, margin 0, midnight UTC',
      row === `${agents.public}|symbol|SPY|0|00:00:00`, `row=${row}`);

    await page.goto(`${ORIGIN}/me/theses`, { waitUntil: 'networkidle0', timeout: 45000 });
    const mine = await bodyText(page);
    check('/me/theses lists it', mine.includes(CLAIM), mine.slice(0, 400));
    check('and counts one published', /1 published/.test(mine), mine.slice(0, 400));
  });

  // =====================================================================
  await section('5. The article form can now carry it', async () => {
    if (!thesisId) { check('a thesis exists to carry', false, 'section 4 did not produce one'); return; }
    await page.goto(`${ORIGIN}/me/articles/new`, { waitUntil: 'networkidle0', timeout: 45000 });
    const picker = await page.$eval('#a-thesis', (el) => ({
      disabled: el.disabled, values: [...el.options].map((o) => o.value),
    }));
    check('the thesis picker is enabled — it was permanently disabled before day 1',
      picker.disabled === false, `disabled=${picker.disabled}`);
    check('and offers the thesis just published', picker.values.includes(thesisId),
      JSON.stringify(picker.values));

    await page.type('#a-title', `${TAG} why momentum wins this month`);
    await page.type('#a-body', 'The argument, in a paragraph with **bold** in it.');
    await page.select('#a-thesis', thesisId);
    await clickText(page, 'Publish article');
    await page.waitForFunction(() => /^\/articles\/[0-9a-f-]{36}$/.test(location.pathname), { timeout: 30000 });
    articleId = new URL(page.url()).pathname.split('/').pop();

    const t = await bodyText(page);
    check('the article shows the claim it carries', /The claim this article made/.test(t) && t.includes(CLAIM),
      t.slice(0, 600));
    check('and says the claim is still running', /This claim is still running/.test(t), t.slice(0, 600));
    const bound = sql(`SELECT coalesce(thesis_id::text, 'null') FROM articles WHERE id = '${articleId}'`);
    check('the binding is in the database', bound === thesisId, `thesis_id=${bound}`);

    await page.goto(`${ORIGIN}/theses/${thesisId}`, { waitUntil: 'networkidle0', timeout: 45000 });
    check('the thesis page links back to the article',
      await page.$(`a[href="/articles/${articleId}"]`) !== null, 'no link to the article');

    await page.goto(`${ORIGIN}/me/articles/new`, { waitUntil: 'networkidle0', timeout: 45000 });
    const again = await page.$$eval('#a-thesis option', (os) => os.map((o) => o.value));
    check('a carried thesis is no longer offered — one thesis, one article',
      !again.includes(thesisId), JSON.stringify(again));
  });

  const here = () => `${ORIGIN}/articles/${articleId}`;

  // =====================================================================
  await section('6. Like, un-like and save on the article', async () => {
    if (!articleId) { check('an article exists', false, 'section 5 did not produce one'); return; }
    await page.goto(here(), { waitUntil: 'networkidle0', timeout: 45000 });
    const r0 = await reactions(page);
    check('the reaction bar is rendered for a signed-in reader', r0.like === '0' && r0.save === '0',
      JSON.stringify(r0));

    await clickText(page, '♥');
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').includes('♥'));
      return b && b.getAttribute('aria-pressed') === 'true';
    }, { timeout: 15000 });
    await page.reload({ waitUntil: 'networkidle0' });
    const r1 = await reactions(page);
    check('a like survives a reload', r1.like === '1' && r1.liked === 'true', JSON.stringify(r1));

    await clickText(page, '♥');
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').includes('♥'));
      return b && b.getAttribute('aria-pressed') === 'false';
    }, { timeout: 15000 });
    await page.reload({ waitUntil: 'networkidle0' });
    const r2 = await reactions(page);
    check('clicking again removes it, and that survives a reload too', r2.like === '0' && r2.liked === 'false',
      JSON.stringify(r2));

    await clickText(page, '☆');
    await page.waitForFunction(() => [...document.querySelectorAll('button')]
      .some((x) => (x.innerText || '').includes('★')), { timeout: 15000 });
    await page.reload({ waitUntil: 'networkidle0' });
    const r3 = await reactions(page);
    check('saving fills the star and survives a reload', r3.save === '1' && r3.saved === 'true',
      JSON.stringify(r3));

    const rows = sql(`SELECT string_agg(kind, ',' ORDER BY kind) FROM content_reactions
                       WHERE article_id = '${articleId}'`);
    check('the database holds one save and no like', rows === 'save', `kinds=${rows || '(none)'}`);
  });

  // =====================================================================
  await section('7. Editing the prose leaves the claim where it was', async () => {
    if (!articleId) { check('an article exists', false, 'section 5 did not produce one'); return; }
    const link = await page.$(`a[href="/me/articles/${articleId}"]`);
    check('the author sees an Edit link', link !== null, 'no edit link on the article');
    if (!link) return;
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), link.click()]);
    const t = await bodyText(page);
    check('the edit form says the thesis binding cannot change',
      /carries a thesis\. That binding cannot be changed/.test(t), t.slice(0, 600));
    check('and offers no thesis picker at all', (await page.$('#a-thesis')) === null, 'a picker is there');

    await page.focus('#a-body');
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await page.keyboard.type(`\n\nAn edited paragraph ${TAG}.`);
    await clickText(page, 'Save changes');
    await page.waitForFunction((id) => location.pathname === `/articles/${id}`, { timeout: 30000 }, articleId);
    await waitText(page, `An edited paragraph ${TAG}`);
    const after = await bodyText(page);
    check('the edit is on the article', after.includes(`An edited paragraph ${TAG}`), after.slice(0, 400));
    check('the article says it was edited', /edited \d{4}-/.test(after), after.slice(0, 400));
    check('and still carries the same claim', after.includes(CLAIM), after.slice(0, 600));
  });

  // =====================================================================
  await section('8. Reporting a comment, twice', async () => {
    if (!articleId) { check('an article exists', false, 'section 5 did not produce one'); return; }
    await page.goto(here(), { waitUntil: 'networkidle0', timeout: 45000 });
    await page.type('textarea', `A comment to moderate ${TAG}`);
    await clickText(page, 'Post comment');
    await waitText(page, `A comment to moderate ${TAG}`, 30000);
    commentId = sql(`SELECT id FROM forum_posts WHERE article_id = '${articleId}' LIMIT 1`);
    check('the comment is stored', /^[0-9a-f-]{36}$/.test(commentId), `id=${commentId}`);
    const li = `#p-${commentId}`;

    await clickIn(page, li, 'Report');
    await page.select(`#r-${commentId}`, 'spam');
    await page.type(`#d-${commentId}`, 'typed by a browser suite');
    await clickIn(page, li, 'Send report');
    let said = true;
    try { await waitText(page, 'Reported. A moderator will look at it.'); } catch { said = false; }
    check('the first report is acknowledged as new', said, (await bodyText(page)).slice(-500));
    const reportRow = sql(`SELECT reason || '|' || coalesce(detail, '') FROM content_reports
                            WHERE post_id = '${commentId}'`);
    check('and one row holds the reason and detail chosen', reportRow === 'spam|typed by a browser suite',
      `row=${reportRow}`);

    await page.reload({ waitUntil: 'networkidle0' });
    await clickIn(page, li, 'Report');
    await clickIn(page, li, 'Send report');
    let second = true;
    try { await waitText(page, 'You had already reported this'); } catch { second = false; }
    check('a second report is told it was already counted, not that it failed', second,
      (await bodyText(page)).slice(-500));
    const n = sql(`SELECT count(*) FROM content_reports WHERE post_id = '${commentId}'`);
    check('and it did not add a row', n === '1', `rows=${n}`);
  });

  // =====================================================================
  await section('9. The article author hides the comment', async () => {
    if (!commentId) { check('a comment exists', false, 'section 8 did not produce one'); return; }
    await page.goto(here(), { waitUntil: 'networkidle0', timeout: 45000 });
    const li = `#p-${commentId}`;
    await clickIn(page, li, 'Hide');
    check('the hide button waits for a reason',
      await page.evaluate((sel) => {
        const b = [...document.querySelector(sel).querySelectorAll('button')].find((x) => x.innerText.trim() === 'Hide');
        return b ? b.disabled : null;
      }, li) === true, 'Hide was clickable with no reason');
    await page.type(`#h-${commentId}`, 'Removed by the browser suite');
    await clickIn(page, li, 'Hide');
    await waitText(page, 'This reply was hidden by moderation');
    const t = await bodyText(page);
    check('the comment is replaced by a marked gap carrying the reason',
      t.includes('Removed by the browser suite') && !t.includes(`A comment to moderate ${TAG}`), t.slice(-600));
    const row = sql(`SELECT coalesce(hidden_reason, 'null') FROM forum_posts WHERE id = '${commentId}'`);
    check('and the row is kept, marked, not deleted', row === 'Removed by the browser suite', `reason=${row}`);
  });

  // =====================================================================
  await section('10. What a signed-out reader sees of all that', async () => {
    if (!articleId) { check('an article exists', false, 'section 5 did not produce one'); return; }
    const ctx = await (browser.createBrowserContext ?? browser.createIncognitoBrowserContext).call(browser);
    const anon = await ctx.newPage();
    watch(anon);
    await anon.goto(here(), { waitUntil: 'networkidle0', timeout: 45000 });
    const t = await bodyText(anon);
    check('the counts are shown, with a way to sign in instead of dead buttons',
      /♥ 0/.test(t) && /☆ 1/.test(t) && /Sign in to like or save/.test(t), t.slice(0, 800));
    check('the claim is there', t.includes(CLAIM), t.slice(0, 600));
    check('the hidden comment is a gap for them too', /This reply was hidden by moderation/.test(t)
      && !t.includes(`A comment to moderate ${TAG}`), t.slice(-600));
    check('and no Hide control is offered to a stranger',
      await anon.evaluate(() => ![...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Hide')),
      'a Hide button was rendered signed out');
    await ctx.close();
  });

  // =====================================================================
  await section('11. Hiding the article does not touch the claim', async () => {
    if (!articleId) { check('an article exists', false, 'section 5 did not produce one'); return; }
    await page.goto(here(), { waitUntil: 'networkidle0', timeout: 45000 });
    await clickText(page, 'Hide');
    await page.type(`#h-${articleId}`, 'Taken down by its author');
    await clickText(page, 'Hide');
    let shown = true;
    try { await waitText(page, 'This article was hidden by moderation'); } catch { shown = false; }
    check('the article page says it was hidden, and why', shown
      && (await bodyText(page)).includes('Taken down by its author'), (await bodyText(page)).slice(0, 600));

    await page.goto(`${ORIGIN}/theses/${thesisId}`, { waitUntil: 'networkidle0', timeout: 45000 });
    const t = await bodyText(page);
    check('the thesis page still states the claim', t.includes(CLAIM), t.slice(0, 400));
    const st = sql(`SELECT status FROM public_theses WHERE id = '${thesisId}'`);
    check('and the thesis is still pending in the database', st === 'pending', `status=${st}`);
  });

  // =====================================================================
  await section('12. Nothing threw in the browser, the whole way through', async () => {
    check('no uncaught exception on any page', pageErrors.length === 0, pageErrors.join(' | '));
    check('no console error on any page', consoleErrors.length === 0, consoleErrors.join(' | '));
    check('no failed request on any page', failedRequests.length === 0, failedRequests.join(' | '));
    if (rateLimitedPrefetches.length > 0) {
      console.log(`      ${rateLimitedPrefetches.length} prefetch(es) were rate-limited (429) — this ` +
        'suite\'s own traffic meeting the limiter, not a reader being turned away.');
    }
    if (abortedNavigations.length > 0) {
      console.log(`      ${abortedNavigations.length} navigation(s) this script replaced were aborted by Chromium.`);
    }
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
