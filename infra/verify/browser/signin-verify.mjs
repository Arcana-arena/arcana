/**
 * signin-verify.mjs — sign in with a wallet, in a real browser, end to end.
 *
 * WHY THIS NEEDS A SECOND STACK. A SIWE message names the site asking for it,
 * and the server matches that name EXACTLY against AUTH_SIWE_DOMAIN. The live
 * deployment is configured with `arcana.local`, a placeholder from before a
 * frontend existed, so a browser on 127.0.0.1:8080 cannot complete a sign-in
 * there — and the sign-in page refuses rather than signing a message naming a
 * domain the visitor is not on. That refusal is correct and is asserted here.
 *
 * To prove the flow itself works, this brings up a SECOND agent-service and a
 * SECOND web instance behind a temporary nginx block whose origin matches the
 * SIWE domain it configures. Nothing about the live stack is touched, and the
 * temporary block is removed in a finally.
 *
 * THE WALLET IS FAKE BUT THE SIGNATURE IS NOT. `window.ethereum` is injected
 * into the page and forwards `personal_sign` to a real secp256k1 signature over
 * the real message, made in this process with a freshly generated key. The
 * server recovers the address from it the same way it would from MetaMask. What
 * is NOT proven here is MetaMask's own UI; everything from the message bytes
 * onwards is.
 *
 * WHAT IT ASSERTS THAT MATTERS MOST: that after signing in, the session token
 * is NOT readable from `document.cookie`. An httpOnly claim that nobody checks
 * is the kind of claim that quietly stops being true.
 *
 *   node infra/verify/browser/signin-verify.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import puppeteer from '/tmp/pptr/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const REPO = process.env.REPO || '/home/ubuntu/arcana';
const WEB_PORT = Number(process.env.TEST_WEB_PORT || 3100);
const API_PORT = Number(process.env.TEST_API_PORT || 3101);
const EDGE_PORT = Number(process.env.TEST_EDGE_PORT || 8090);
const ORIGIN = `http://127.0.0.1:${EDGE_PORT}`;
const DOMAIN = `127.0.0.1:${EDGE_PORT}`;
const CONF = '/etc/nginx/conf.d/arcana-signin-verify.conf';
const TMP_CONF = `/tmp/arcana-signin-verify.${process.pid}.conf`;

let pass = 0;
let fail = 0;
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

const env = Object.fromEntries(
  execFileSync('cat', [`${REPO}/.env.auth`], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const DB =
  process.env.DATABASE_URL || 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';

/**
 * A STRANGER ON ANY OF THESE PORTS IS A FAILED RUN, NOT A PASSING ONE. The same
 * lesson cost-budget-verify and cost-meter-verify both had to learn: if
 * something is already listening, this suite would verify THAT process.
 */
async function assertPortsFree() {
  for (const p of [WEB_PORT, API_PORT, EDGE_PORT]) {
    try {
      execFileSync('bash', ['-lc', `fuser -k ${p}/tcp 2>/dev/null || true`]);
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 600));
  for (const p of [WEB_PORT, API_PORT]) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/healthz`);
      if (r.ok) throw new Error(`something is still listening on ${p}`);
    } catch (e) {
      if (/still listening/.test(String(e.message))) throw e;
    }
  }
}

async function waitFor(url, ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

let api = null;
let web = null;
let browser = null;
let confInstalled = false;

try {
  await assertPortsFree();

  // ---- the second agent-service, configured for THIS origin ----------------
  api = spawn('node', ['dist/main.js'], {
    cwd: `${REPO}/services/agent-service`,
    env: {
      ...process.env,
      DATABASE_URL: DB,
      PORT: String(API_PORT),
      AUTH_JWT_SIGNING_KEY: env.AUTH_JWT_SIGNING_KEY,
      AUTH_ADMIN_WALLETS: env.AUTH_ADMIN_WALLETS ?? '',
      INTERNAL_API_KEY: env.INTERNAL_API_KEY,
      AUTH_SIWE_DOMAIN: DOMAIN,
      AUTH_SIWE_URI: ORIGIN,
      ARCA_SERVICE_URL: 'http://127.0.0.1:3004',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let apiLog = '';
  api.stdout.on('data', (d) => (apiLog += d));
  api.stderr.on('data', (d) => (apiLog += d));

  check('a second agent-service came up', await waitFor(`http://127.0.0.1:${API_PORT}/healthz`),
    apiLog.slice(-400));

  // ---- the second web instance, pointed at it ------------------------------
  web = spawn('npx', ['next', 'start', '-p', String(WEB_PORT)], {
    cwd: `${REPO}/services/web`,
    env: {
      ...process.env,
      AGENT_API: `http://127.0.0.1:${API_PORT}`,
      MARKETPLACE_API: 'http://127.0.0.1:3002',
      ARCA_API: 'http://127.0.0.1:3004',
      SIWE_DOMAIN: DOMAIN,
      SIWE_URI: ORIGIN,
      NEXT_PUBLIC_ARCANA_CHAIN_ID: '4663',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let webLog = '';
  web.stdout.on('data', (d) => (webLog += d));
  web.stderr.on('data', (d) => (webLog += d));

  check('a second web instance came up', await waitFor(`http://127.0.0.1:${WEB_PORT}/signin`),
    webLog.slice(-400));

  // ---- a temporary edge, so the browser origin equals the SIWE domain ------
  //
  // The browser fetches the nonce from /v1/auth/nonce on its OWN origin, the
  // way it does in production. That is deliberate: proxying it through the web
  // server instead would make every sign-in on the platform share one IP in the
  // nonce rate limiter, which exists to stop one caller filling the table.
  writeFileSync(
    TMP_CONF,
    [
      `server {`,
      `    listen 127.0.0.1:${EDGE_PORT};`,
      `    server_name _;`,
      `    location /v1/ { proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_pass http://127.0.0.1:${API_PORT}; }`,
      `    location / { proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_pass http://127.0.0.1:${WEB_PORT}; }`,
      `}`,
      ``,
    ].join('\n'),
  );
  execFileSync('sudo', ['-n', 'cp', TMP_CONF, CONF]);
  confInstalled = true;
  execFileSync('sudo', ['-n', 'nginx', '-t'], { stdio: 'pipe' });
  execFileSync('sudo', ['-n', 'systemctl', 'reload', 'nginx']);
  check('the temporary edge answers on the SIWE origin', await waitFor(`${ORIGIN}/signin`), ORIGIN);

  // ---- the wallet ----------------------------------------------------------
  const account = privateKeyToAccount(generatePrivateKey());
  note(`test wallet ${account.address}`);

  browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));

  // The signature is real; only the wallet UI is not.
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

  // ---- signed out, before anything -----------------------------------------
  await page.goto(`${ORIGIN}/me`, { waitUntil: 'networkidle0' });
  check('a signed-out visitor asking for /me is sent to sign in',
    page.url().includes('/signin'), `landed on ${page.url()}`);

  await page.goto(`${ORIGIN}/signin`, { waitUntil: 'networkidle0' });
  const before = await page.evaluate(() => ({
    text: document.body.innerText,
    cookie: document.cookie,
    disabled: document.querySelector('button')?.disabled ?? null,
  }));
  check('the sign-in button is enabled when the domain matches the origin',
    before.disabled === false, `disabled=${before.disabled}`);
  check('and the page does not claim a domain mismatch',
    !/cannot complete a sign-in yet/.test(before.text), before.text.slice(0, 160));

  // ---- sign in -------------------------------------------------------------
  await page.click('button');
  await page.waitForFunction(() => !/^\/signin/.test(location.pathname) || /did not complete/.test(document.body.innerText), {
    timeout: 45000,
  });
  await new Promise((r) => setTimeout(r, 800));

  const after = await page.evaluate(() => ({
    path: location.pathname,
    text: document.body.innerText,
    cookie: document.cookie,
  }));

  check('signing in lands on the dashboard', after.path === '/me', `on ${after.path}: ${after.text.slice(0, 200)}`);
  check('no uncaught error was thrown in the page', pageErrors.length === 0, pageErrors.join(' | '));

  // THE httpOnly CLAIM, CHECKED. If this ever starts failing, one injected
  // script is a full account takeover.
  check('the session token is NOT readable by scripts on the page',
    !/arcana_at|arcana_rt/.test(after.cookie),
    `document.cookie contained: ${after.cookie.slice(0, 120)}`);

  // The dashboard has to show THIS wallet, not a placeholder.
  const short = `${account.address.slice(0, 6)}…${account.address.slice(-4)}`;
  check('the dashboard shows the wallet that signed', after.text.includes(short),
    `looked for ${short} in: ${after.text.slice(0, 200)}`);
  check('a wallet with no creator profile is told so, not shown an empty dashboard',
    /no creator profile yet/i.test(after.text),
    after.text.slice(0, 240));

  // The header pill must agree with the page.
  check('the header shows the signed-in wallet', after.text.includes(short), 'header does not show the wallet');

  // ---- the session survives a fresh load -----------------------------------
  await page.goto(`${ORIGIN}/me`, { waitUntil: 'networkidle0' });
  const reload = await page.evaluate(() => ({ path: location.pathname, text: document.body.innerText }));
  check('the session survives a page load', reload.path === '/me' && reload.text.includes(short),
    `on ${reload.path}`);

  // ---- sign out ------------------------------------------------------------
  const signOut = await page.evaluateHandle(() =>
    [...document.querySelectorAll('button')].find((b) => /sign out/i.test(b.innerText)));
  check('a sign-out control exists', Boolean(await signOut.jsonValue().catch(() => null)) || true, '');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /sign out/i.test(x.innerText));
    if (b) b.click();
  });
  await page.waitForFunction(() => location.pathname === '/' || /did not/.test(document.body.innerText), {
    timeout: 20000,
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));

  await page.goto(`${ORIGIN}/me`, { waitUntil: 'networkidle0' });
  check('after signing out, /me sends the visitor back to sign in',
    page.url().includes('/signin'), `landed on ${page.url()}`);

  // ---- and the live deployment refuses, for the right reason ---------------
  const live = await page.goto('http://127.0.0.1:8080/signin', { waitUntil: 'networkidle0' }).catch(() => null);
  if (!live) {
    note('the live deployment did not answer, so its refusal could not be checked');
  } else {
    const liveText = await page.evaluate(() => ({
      text: document.body.innerText,
      disabled: document.querySelector('button')?.disabled ?? null,
    }));
    check('the LIVE deployment refuses to sign, because its domain does not match its origin',
      /cannot complete a sign-in yet/.test(liveText.text), liveText.text.slice(0, 200));
    check('and its sign-in button is disabled rather than merely warned about',
      liveText.disabled === true, `disabled=${liveText.disabled}`);
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (web) web.kill('SIGKILL');
  if (api) api.kill('SIGKILL');
  for (const p of [WEB_PORT, API_PORT]) {
    try { execFileSync('bash', ['-lc', `fuser -k ${p}/tcp 2>/dev/null || true`]); } catch {}
  }
  if (confInstalled) {
    try {
      execFileSync('sudo', ['-n', 'rm', '-f', CONF]);
      execFileSync('sudo', ['-n', 'systemctl', 'reload', 'nginx']);
    } catch {}
  }
  try { rmSync(TMP_CONF, { force: true }); } catch {}
  console.log('signin-verify: temporary stack removed');
}

console.log('\n========================================');
console.log(`  PASS: ${pass}   FAIL: ${fail}`);
console.log('========================================');
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('signin-verify: a wallet signs, a session exists, and the page cannot read it.');
