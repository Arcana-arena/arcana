/**
 * creator-onboarding-verify.mjs — somebody arriving today can start.
 *
 * THE DEAD END THIS GUARDS. A wallet that signs in with no creator profile can
 * read the whole platform and do nothing on it: an agent belongs to a creator,
 * and for a long while the only way to make one was `POST /v1/creators` with a
 * handle. The page said so honestly and was still a dead end — every mockup
 * assumes a creator already exists, which is true of nobody arriving for the
 * first time.
 *
 * So this drives the door the way a new person does: sign in with a wallet
 * nothing has seen, land on the dashboard, read what it offers, create the
 * profile through the same endpoint the form's action calls, and confirm the
 * dashboard that follows is the real one rather than the offer to create.
 *
 * THE FIXTURE IS MARKED `verification` and deleted on the way out. A creator
 * row minted by a test and left behind is a person who does not exist.
 *
 *   node infra/verify/creator-onboarding-verify.mjs
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { suite } from './lib/sections.mjs';
import { signIn as sharedSignIn, VERIFICATION_HEADER } from './lib/rate-aware.mjs';

const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const WEB = process.env.WEB_URL || 'http://127.0.0.1:3000';
const DB = process.env.DATABASE_URL || 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';

const { check, section, report } = suite('creator-onboarding-verify');

const sql = (q) =>
  execFileSync('psql', [DB, '-At', '-q', '-c', q], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim()
    .split('\n')[0]
    .trim();

let token = null;
const api = async (path, init = {}) => {
  const r = await fetch(`${AGENT}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const t = await r.text();
  let body = null;
  try {
    body = t ? JSON.parse(t) : null;
  } catch {
    /* left null: a non-JSON body is a failure the caller should see */
  }
  return { status: r.status, body };
};
const page = async (path) => {
  const r = await fetch(`${WEB}${path}`, {
    headers: { accept: 'text/html', ...(token ? { cookie: `arcana_at=${token}` } : {}) },
  });
  return { status: r.status, html: await r.text() };
};
const text = (html) =>
  html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&ldquo;|&rdquo;/g, '"').replace(/\s+/g, ' ');

// The handle validator's rule — lowercase, digits, underscore — matched here
// rather than discovered from a 400 halfway through the run.
const TAG = `verify_onb_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
let creatorId = null;

function teardown() {
  try {
    sql(`DELETE FROM creators WHERE handle LIKE 'verify_onb_%'`);
  } catch (e) {
    console.log('  cleanup warning: ' + e.message);
  }
}
teardown(); // anything an interrupted run left behind
process.on('exit', teardown);
process.on('SIGINT', () => {
  teardown();
  process.exit(130);
});

try {
  const newcomer = privateKeyToAccount(generatePrivateKey());
  const s = await sharedSignIn(AGENT, newcomer);
  if (s.status !== 200 || !s.body?.access_token) {
    check('a wallet nobody has seen can sign in', false, `status ${s.status} ${JSON.stringify(s.body)}`);
    throw new Error('cannot continue without a session');
  }
  token = s.body.access_token;

  await section('A newcomer is offered the door, not just told where it is', async () => {
    check('a wallet nobody has seen can sign in', true);
    const p = await page('/me');
    const t = text(p.html);
    check('the dashboard renders for it', p.status === 200, `status ${p.status}`);
    check('it says a profile is missing rather than reporting a failure',
      /no creator profile yet/i.test(t) && !/could not be read/i.test(t),
      'the missing profile is not explained, or is reported as a read failure');

    // THE CHECK THIS FILE EXISTS FOR. The page used to name the endpoint and
    // stop, which is honest and still a dead end.
    check('and offers a form rather than naming an endpoint',
      /Create your creator profile/i.test(t) && /Handle/.test(t),
      'no create-profile form on the page — a newcomer cannot start from the interface');
    check('the wallet is shown as taken from the session, not asked for',
      /Bound to/i.test(t) && /not from this form/i.test(t),
      'the form does not say where the wallet comes from');
    check('the handle rule is stated before it is broken',
      /Lowercase letters, digits and underscores/i.test(t),
      'the rule is only discoverable from a refusal');

    // THE SENTENCE THIS FORM GOT WRONG ONCE. It said creating a profile "does
    // not make you payable", while the service writes the session wallet into
    // creators.wallet_address — the column resolvePayable() reads to decide who
    // a buyer pays. The page must say which address money arrives at, because
    // the choice is made at sign-in and cannot be undone afterwards.
    check('and it says this wallet is where buyers will pay',
      /also where buyers will pay you/i.test(t),
      'the form does not say the sign-in wallet is the payout address');
    check('and that it cannot be re-pointed afterwards',
      /cannot be re-pointed/i.test(t),
      'the form does not say the binding is permanent');
    check('without claiming a payout field that does not exist',
      !/does not make you payable/i.test(t),
      'the form still claims a profile is not payable, which the records contradict');
  });

  await section('Creating it works, and the wallet comes from the session', async () => {
    const r = await api('/v1/creators', {
      method: 'POST',
      body: { handle: TAG },
      headers: VERIFICATION_HEADER,
    });
    check('the profile is created', r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);
    creatorId = r.body?.id ?? null;
    if (!creatorId) throw new Error('no creator id came back; the rest of this suite has nothing to drive');
    check('it carries the handle that was asked for', r.body?.handle === TAG, String(r.body?.handle));

    const bound = sql(`SELECT lower(wallet_address) FROM creators WHERE id = '${creatorId}'`);
    check('and is bound to the wallet that signed in, not to anything sent',
      bound === newcomer.address.toLowerCase(), `${bound} vs ${newcomer.address.toLowerCase()}`);
    check('with the verification provenance the fixture actually has',
      sql(`SELECT provenance FROM creators WHERE id = '${creatorId}'`) === 'verification',
      'a test creator was recorded as a live signup');

    // AND THE SAME ADDRESS IS THE PAYEE — proven from the column the payment
    // path reads, not from the copy that describes it.
    const payee = sql(
      `SELECT lower(c.wallet_address) FROM creators c WHERE c.id = '${creatorId}' AND c.wallet_verified_at IS NOT NULL`,
    );
    check('the address a buyer would be told to pay is that same proven wallet',
      payee === newcomer.address.toLowerCase(),
      `resolvePayable() reads creators.wallet_address; it holds '${payee}'`);

    // ONE WALLET, ONE PROFILE — and the refusal names the handle it already
    // has, rather than leaving somebody trying different names against a rule
    // that has nothing to do with the name.
    const again = await api('/v1/creators', {
      method: 'POST',
      body: { handle: `${TAG}2` },
      headers: VERIFICATION_HEADER,
    });
    check('a second profile for the same wallet is refused', again.status === 409, `status ${again.status}`);
    const msg = String(again.body?.message ?? JSON.stringify(again.body));
    check('and the refusal names the profile that already exists', msg.includes(TAG), msg.slice(0, 160));
    check('no second row was written', sql(`SELECT count(*) FROM creators WHERE handle = '${TAG}2'`) === '0',
      'the refusal was cosmetic');
  });

  await section('The dashboard that follows is the real one', async () => {
    const p = await page('/me');
    const t = text(p.html);
    check('it renders', p.status === 200, `status ${p.status}`);
    check('the offer to create is gone', !/Create your creator profile/i.test(t),
      'still offering to create a profile that exists');
    check('with the handle that was chosen', t.includes(TAG), `${TAG} is not on the page`);
    check('and the slots this creator now holds', /of \d+ slots used|slots? free/.test(t),
      'no slot count on the dashboard');

    // AND THE PROFILE EVERYONE ELSE READS IS REACHABLE FROM IT.
    check('the public profile is linked from the account that owns it',
      p.html.includes(`/creators/${creatorId}`),
      'nothing on the dashboard links to the public profile');
    const pub = await page(`/creators/${creatorId}`);
    check('and that page opens', pub.status === 200, `status ${pub.status}`);
    check('naming the creator it belongs to', text(pub.html).includes(TAG), `${TAG} is not on its own profile`);
  });
} catch (e) {
  // Not rethrown: a suite that dies without printing its summary looks to the
  // sweep exactly like one that was never run.
  check('the run completed', false, String(e && e.message));
} finally {
  teardown();
  creatorId = null;
}

const code = report();
if (code !== 0) process.exit(code);
console.log('creator-onboarding-verify: somebody arriving today can start from the interface.');
