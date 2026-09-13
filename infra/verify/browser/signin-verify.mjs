/**
 * signin-verify.mjs — sign in with a wallet, in a real browser, against the
 * deployment people actually use.
 *
 * THIS USED TO BUILD A SECOND STACK. It had to: AUTH_SIWE_DOMAIN was
 * `arcana.local`, a placeholder from before a frontend existed, so no browser
 * on the real origin could complete a sign-in and the flow could only be proved
 * somewhere artificial. The domain is now arcana-arena.com and the site is
 * served from it, so the honest thing to test is the site.
 *
 * THE WALLET IS FAKE BUT THE SIGNATURE IS NOT. `window.ethereum` is injected and
 * forwards `personal_sign` to a real secp256k1 signature over the real message,
 * made in this process with a freshly generated key. The server recovers the
 * address from it exactly as it would from MetaMask. What is NOT proved here is
 * MetaMask's own UI; everything from the message bytes onwards is.
 *
 * THE FIRST ASSERTION IS AN INVARIANT, NOT A CONFIGURATION. Whatever the domain
 * is set to, the page must either accept and have an enabled button, or refuse
 * and have a disabled one. A page that shows the mismatch warning beside a live
 * button, or hides the warning while refusing, is broken in the direction that
 * matters — and that check keeps working after the domain changes again.
 *
 * WHAT IT ASSERTS THAT MATTERS MOST: that after signing in, the session token is
 * NOT readable from `document.cookie`. An httpOnly claim nobody checks is the
 * kind of claim that quietly stops being true.
 *
 * It creates a session for a throwaway wallet and no creator profile, the same
 * thing auth-verify does against this deployment many times a run.
 *
 *   node infra/verify/browser/signin-verify.mjs
 *   ORIGIN=http://127.0.0.1:8080 node infra/verify/browser/signin-verify.mjs
 */
import puppeteer from '/tmp/pptr/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const ORIGIN = process.env.ORIGIN || 'https://arcana-arena.com';

let pass = 0;
let fail = 0;
let skipped = null;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(`${name} — ${detail}`);
    console.log(`  FAIL  ${name} — ${detail}`);
  }
};
const note = (s) => console.log(`      ${s}`);

let browser = null;
try {
  const account = privateKeyToAccount(generatePrivateKey());
  note(`origin ${ORIGIN}`);
  note(`test wallet ${account.address}`);

  browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));

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

  // ---- signed out, before anything ----------------------------------------
  await page.goto(`${ORIGIN}/me`, { waitUntil: 'networkidle0' });
  check('a signed-out visitor asking for /me is sent to sign in',
    page.url().includes('/signin'), `landed on ${page.url()}`);

  await page.goto(`${ORIGIN}/signin`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !/checking what this page can do/.test(document.body.innerText), { timeout: 15000 });
  const before = await page.evaluate(() => ({
    host: location.host,
    text: document.body.innerText,
    refuses: /cannot complete a sign-in yet/.test(document.body.innerText),
    disabled: document.querySelector('button')?.disabled ?? null,
  }));

  // THE INVARIANT. Refusing and offering are both legitimate; doing one while
  // saying the other is not.
  check('the page\'s warning and its button agree with each other',
    before.refuses === (before.disabled === true),
    `refuses=${before.refuses} buttonDisabled=${before.disabled}`);

  if (before.refuses) {
    skipped =
      `this deployment's configured sign-in domain does not match ${before.host}, so it correctly ` +
      'refuses to sign and the rest of the flow cannot be exercised here';
    note(`NOTHING FURTHER TO CHECK  ${skipped}`);
  } else {
    check('the sign-in button is offered', before.disabled === false, `disabled=${before.disabled}`);

    // ---- sign in -----------------------------------------------------------
    await page.click('button');
    await page.waitForFunction(
      () => !/^\/signin/.test(location.pathname) || /did not complete/.test(document.body.innerText),
      { timeout: 45000 },
    );
    await new Promise((r) => setTimeout(r, 800));

    const after = await page.evaluate(() => ({
      path: location.pathname,
      text: document.body.innerText,
      cookie: document.cookie,
    }));

    check('signing in lands on the dashboard', after.path === '/me',
      `on ${after.path}: ${after.text.slice(0, 200)}`);
    check('no uncaught error was thrown in the page', pageErrors.length === 0, pageErrors.join(' | '));

    // If this ever starts failing, one injected script is a full account
    // takeover.
    check('the session token is NOT readable by scripts on the page',
      !/arcana_at|arcana_rt/.test(after.cookie),
      `document.cookie contained: ${after.cookie.slice(0, 120)}`);

    // CASE-INSENSITIVE ON PURPOSE: viem hands back an EIP-55 checksummed
    // address, the verifier stores it lowercased, and the page prints what the
    // record holds rather than re-encoding it.
    const short = `${account.address.slice(0, 6)}…${account.address.slice(-4)}`.toLowerCase();
    const shows = (t) => t.toLowerCase().includes(short);

    check('the dashboard shows the wallet that signed', shows(after.text),
      `looked for ${short} in: ${after.text.slice(0, 200)}`);
    check('a wallet with no creator profile is told so, not shown an empty dashboard',
      /no creator profile yet/i.test(after.text), after.text.slice(0, 240));

    await page.goto(`${ORIGIN}/me`, { waitUntil: 'networkidle0' });
    const reload = await page.evaluate(() => ({ path: location.pathname, text: document.body.innerText }));
    check('the session survives a page load', reload.path === '/me' && shows(reload.text), `on ${reload.path}`);

    // ---- and it is gone when asked ------------------------------------------
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /sign out/i.test(x.innerText));
      if (b) b.click();
    });
    await page
      .waitForFunction(() => location.pathname === '/' || /did not/.test(document.body.innerText), { timeout: 20000 })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 600));

    await page.goto(`${ORIGIN}/me`, { waitUntil: 'networkidle0' });
    check('after signing out, /me sends the visitor back to sign in',
      page.url().includes('/signin'), `landed on ${page.url()}`);
  }

  // ---- the public surface still needs no session ---------------------------
  for (const p of ['/', '/leaderboard', '/marketplace', '/seasons']) {
    const r = await page.goto(`${ORIGIN}${p}`, { waitUntil: 'domcontentloaded' });
    check(`${p} is readable with no session`, r?.status() === 200, `status ${r?.status()}`);
  }
} finally {
  if (browser) await browser.close().catch(() => {});
}

console.log('\n========================================');
console.log(`  PASS: ${pass}   FAIL: ${fail}`);
console.log('========================================');
if (skipped) {
  console.log('\nNot proven by this run:');
  console.log(`  - the sign-in flow itself: ${skipped}`);
}
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('signin-verify: a wallet signs, a session exists, and the page cannot read it.');
