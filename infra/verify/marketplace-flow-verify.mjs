/**
 * marketplace-flow-verify.mjs — the buyable path, which production cannot show.
 *
 * WHY THIS SUITE HAD TO BE WRITTEN. Every listing on this deployment is
 * unbuyable: the one that exists belongs to a creator with no wallet address.
 * So web-verify proves the REFUSAL renders — the card that says why, the page
 * that quotes no price — and proves nothing at all about the five-step
 * subscribe flow, the quote panel, or the no-refund warning, because no page
 * ever draws them.
 *
 * A suite that passes because there is nothing to check is the failure this
 * project keeps writing down. So this one builds a listing that CAN be bought,
 * drives the surface against it, and takes it away again.
 *
 * THE FIXTURE IS MARKED AS A FIXTURE. Its creator and agent carry
 * `provenance = 'verification'`, which is the same flag every counting surface
 * on this platform already excludes — so while this runs, the grid, the stats
 * and the leaderboard are unaffected. The listing detail page does NOT filter
 * on provenance, deliberately: a page addressed by id shows what is at that id.
 *
 * NO MONEY MOVES AND NO PAYMENT IS CLAIMED. The claim path is proved by
 * claims-verify against real transactions. What is proved here is that a buyer
 * who can pay is shown the address, the amount, the term and the warning —
 * before paying, which is the only moment the warning is worth anything.
 *
 *   node infra/verify/marketplace-flow-verify.mjs
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { suite } from './lib/sections.mjs';
import { signIn as sharedSignIn, SIWE_DOMAIN, SIWE_URI } from './lib/rate-aware.mjs';

const WEB = process.env.WEB_URL || 'http://127.0.0.1:3000';
const MARKET = process.env.MARKETPLACE_URL || 'http://127.0.0.1:3002';
const ARCA = process.env.ARCA_URL || 'http://127.0.0.1:3004';
const DB = process.env.DATABASE_URL || 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';

const { check, section, nothingToCheck, report } = suite('marketplace-flow-verify');

/**
 * One value out of psql.
 *
 * `-q` matters. Without it an INSERT ... RETURNING prints the returned row AND
 * the "INSERT 0 1" command tag, and the id handed to the next statement is a
 * uuid with a line of English stapled to it. The first line is taken as well,
 * so a stray notice cannot do the same thing again.
 */
const sql = (q) =>
  execFileSync('psql', [DB, '-At', '-q', '-c', q], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim()
    .split('\n')[0]
    .trim();

async function api(base, path) {
  const r = await fetch(`${base}${path}`, { headers: { accept: 'application/json' } });
  const t = await r.text();
  let body = null;
  try {
    body = t ? JSON.parse(t) : null;
  } catch {
    /* left null: a non-JSON body is a failure the caller should see */
  }
  return { status: r.status, body };
}

/**
 * A page, optionally as a signed-in wallet.
 *
 * The session cookie is httpOnly and set by /api/session, but the pages render
 * on the server and read the cookie there — so handing the access token over as
 * `arcana_at` is exactly what a browser would do, and it lets this suite reach
 * the signed-in half of the marketplace without driving a wallet extension.
 */
async function page(path, token = null) {
  const r = await fetch(`${WEB}${path}`, {
    headers: { accept: 'text/html', ...(token ? { cookie: `arcana_at=${token}` } : {}) },
  });
  return { status: r.status, html: await r.text() };
}

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

// --- the fixture ------------------------------------------------------------

const TAG = `verify-mkt-${randomUUID().slice(0, 8)}`;
// A syntactically valid address that is nobody's. It is never paid: this suite
// reads a quote and never submits a claim.
const PAYEE = '0x' + 'a5'.repeat(20);
const PRICE = '12.500000';

let creatorId = null;
let agentId = null;
let listingId = null;
const seasonId = sql(`SELECT id FROM seasons ORDER BY start_at DESC LIMIT 1`) || null;

function build() {
  creatorId = sql(
    `INSERT INTO creators (handle, wallet_address, status, provenance)
     VALUES ('${TAG}', '${PAYEE}', 'active', 'verification') RETURNING id`,
  );
  agentId = sql(
    `INSERT INTO agents (creator_id, name, version, strategy_type, risk_profile, asset_universe,
                         status, mandate, provenance)
     VALUES ('${creatorId}', '${TAG}', 1, 'momentum',
             '{"max_position_pct": 0.40, "cash_floor_pct": 0.20}'::jsonb,
             'us_equities', 'active',
             'Buy strength and exit any position that falls 0.0150 (= 1.50%) below entry.',
             'verification')
     RETURNING id`,
  );
  listingId = sql(
    `INSERT INTO marketplace_listings (agent_id, access_type, price_usd, arca_gate_amount,
                                       revenue_share_creator, active)
     VALUES ('${agentId}', 'subscription', 12.50, ${PRICE}, 0.80, true) RETURNING id`,
  );
}

function teardown() {
  try {
    if (listingId) {
      sql(`DELETE FROM subscriptions WHERE listing_id = '${listingId}'`);
      sql(`DELETE FROM payment_claims WHERE listing_id = '${listingId}'`);
      sql(`DELETE FROM marketplace_listings WHERE id = '${listingId}'`);
    }
    if (agentId) sql(`DELETE FROM agents WHERE id = '${agentId}'`);
    if (creatorId) sql(`DELETE FROM creators WHERE id = '${creatorId}'`);
  } catch (e) {
    console.log('  cleanup warning: ' + e.message);
  }
}

// Rows left by an interrupted run would otherwise sit in the database as a
// buyable listing nobody built on purpose.
try {
  const stale = sql(`SELECT count(*) FROM creators WHERE handle LIKE 'verify-mkt-%'`);
  if (stale !== '0') {
    console.log(`  (clearing ${stale} fixture creator(s) left by an interrupted run)`);
    sql(`DELETE FROM marketplace_listings WHERE agent_id IN
           (SELECT a.id FROM agents a JOIN creators c ON c.id = a.creator_id
             WHERE c.handle LIKE 'verify-mkt-%')`);
    sql(`DELETE FROM agents WHERE creator_id IN (SELECT id FROM creators WHERE handle LIKE 'verify-mkt-%')`);
    sql(`DELETE FROM creators WHERE handle LIKE 'verify-mkt-%'`);
  }
} catch (e) {
  console.log('  stale-cleanup warning: ' + e.message);
}

process.on('exit', teardown);
process.on('SIGINT', () => { teardown(); process.exit(130); });

// ---------------------------------------------------------------------------

try {
  build();
  console.log(`marketplace-flow-verify: built a buyable listing ${listingId} (fixture, provenance=verification)\n`);

  await section('A listing that CAN be bought is reported as buyable', async () => {
    const d = await api(MARKET, `/v1/marketplace/listings/${listingId}/detail`);
    check('the detail endpoint answers', d.status === 200, `status ${d.status}`);
    check('and reports the listing as buyable', d.body?.buyable === true,
      `buyable=${d.body?.buyable} because=${d.body?.not_buyable_because}`);
    check('with no refusal attached', d.body?.not_buyable_because === null,
      String(d.body?.not_buyable_because));
    check('the creator is reported as having a payee address', d.body?.creator?.has_wallet === true,
      JSON.stringify(d.body?.creator));
    // DECLARED AND MEASURED ARE SEPARATE FIELDS. The fixture declares limits
    // and has no computed DNA, which is exactly the case that would collapse
    // if the page read one for the other.
    check('the declared risk profile is returned', d.body?.risk_profile !== null,
      JSON.stringify(d.body?.risk_profile));
    check('and the absent DNA is reported as absent rather than as agreement',
      d.body?.risk_personality === null && /absent measurement, not agreement/i.test(d.body?.risk_personality_note ?? ''),
      d.body?.risk_personality_note ?? 'no note');
  });

  await section('The quote states the payee, the amount and the term before anything is sent', async () => {
    const q = await api(MARKET, `/v1/marketplace/listings/${listingId}/quote`);
    if (q.status !== 200) {
      check('the quote endpoint answers', false, `status ${q.status}: ${JSON.stringify(q.body)}`);
      return;
    }
    check('the quote endpoint answers', true);
    check('it names the address the check will look for',
      typeof q.body.pay_to === 'string' && q.body.pay_to.toLowerCase() === PAYEE.toLowerCase(),
      `${q.body.pay_to} != ${PAYEE}`);
    check('it names the token by address, not by symbol',
      typeof q.body.token === 'string' && /^0x[0-9a-f]{40}$/.test(q.body.token), String(q.body.token));
    // ONE CONVERSION, TWO CALLERS. The human figure and the base-unit figure
    // must describe the same amount, or a client shows one and the chain
    // carries another — and the divergence is a power of ten, not a rounding.
    check('the human amount and the base units are the same number',
      BigInt(q.body.amount_base_units) ===
        BigInt(Math.round(Number(q.body.amount) * 10 ** q.body.decimals)),
      `${q.body.amount} at ${q.body.decimals} decimals != ${q.body.amount_base_units}`);
    check('it states the term the payment buys', typeof q.body.term_days === 'number' && q.body.term_days > 0,
      String(q.body.term_days));
    check('and the grace window that follows it',
      typeof q.body.grace_hours === 'number' && q.body.grace_hours > 0, String(q.body.grace_hours));
    // THE WARNING IS PART OF THE QUOTE, not part of the page. A page could
    // forget to render it; a quote that carries it makes every client say the
    // same thing.
    check('the quote itself carries the no-refund warning',
      typeof q.body.warning === 'string' && /cannot refund|never receives/i.test(q.body.warning),
      q.body.warning ?? 'no warning');

    const terms = await api(ARCA, '/v1/arca/terms');
    if (terms.status === 200) {
      check('the term on the quote is the one the service enforces',
        q.body.term_days === terms.body.term_days, `${q.body.term_days} vs ${terms.body.term_days}`);
      check('and so is the grace window',
        q.body.grace_hours === terms.body.grace_hours, `${q.body.grace_hours} vs ${terms.body.grace_hours}`);
    } else {
      check('the terms endpoint answers', false, `status ${terms.status}`);
    }
  });

  await section('The listing page draws the quote panel, warning first', async () => {
    const p = await page(`/marketplace/${listingId}`);
    const t = text(p.html);
    check('the page renders', p.status === 200, `status ${p.status}`);
    check('it names the agent being sold', t.includes(TAG), `${TAG} not on the page`);

    // THE FIVE STEPS EXIST AS A RAIL, so a buyer can see where they are and how
    // much is left before money moves.
    for (const step of ['1 QUOTE', '2 TRANSFER', '3 HASH', '4 VERIFY', '5 DONE']) {
      check(`the step rail shows ${step}`, t.includes(step), `${step} not rendered`);
    }

    // THE WARNING IS ON STEP ONE, FOR EVERYBODY.
    //
    // This failed on its first run and the failure was real: the panel showed
    // a signed-out visitor the price and the term and NOT the fact that the
    // payment cannot be refunded. Somebody evaluating a purchase — which is
    // precisely what a signed-out visitor is doing — could decide to buy
    // without ever being told, and nothing stops them paying the address from
    // outside this flow. The warning belongs to the quote, not to the session.
    check('the no-refund warning is shown to a signed-out visitor too',
      /No refunds/i.test(t) && /cannot refund|never receives/i.test(t),
      'the quote panel does not carry the warning before sign-in');

    const q = await api(MARKET, `/v1/marketplace/listings/${listingId}/quote`);
    if (q.status === 200) {
      check('the payee on the page is the payee from the quote',
        t.includes(q.body.pay_to), `${q.body.pay_to} not printed`);
      check('the amount on the page is the amount from the quote',
        t.includes(q.body.amount), `${q.body.amount} not printed`);
      check('the term on the page is the term from the quote',
        t.includes(`${q.body.term_days} days`), `${q.body.term_days} days not printed`);
    } else {
      check('the quote could be read for comparison', false, `status ${q.status}`);
    }

    // AND THE PAGE ITSELF NEEDS NO SESSION. Reading a listing never has; only
    // paying does, and the gate says so rather than hiding the price.
    check('a signed-out visitor is told signing in is needed to subscribe, not to read',
      /Sign in to subscribe/i.test(t),
      'the panel does not offer sign-in to a signed-out visitor');
    check('and the price is shown to them anyway',
      q.status !== 200 || t.includes(q.body.amount),
      'the price is hidden behind the sign-in gate');
  });

  await section('The pool minimum is stated before purchase, or its absence is', async () => {
    const d = await api(MARKET, `/v1/marketplace/listings/${listingId}/detail`);
    const p = await page(`/marketplace/${listingId}`);
    const t = text(p.html);
    if (d.body?.pool_minimum_fraction === null) {
      // NOT ZERO, AND SAID SO. An unarmable stop discovered after the first
      // tick is discovered too late, and "no minimum recorded" is a different
      // fact from "any level is accepted".
      check('an unknown pool minimum is described as unknown rather than as zero',
        /not known from the record|unknown, not zero/i.test(t),
        'the page does not say the pool minimum is unknown');
    } else {
      check('the pool minimum is printed as a fraction and as a percent',
        t.includes(String(d.body.pool_minimum_percent)),
        `${d.body.pool_minimum_percent}% not on the page`);
    }
  });

  await section('A signed-in buyer is gated on acknowledging the warning', async () => {
    // THE LOGIN-GATED HALF, driven with a real SIWE session rather than
    // deferred. It is the part of a marketplace that matters, and a suite that
    // stopped at the sign-in wall would be proving the wall.
    const buyer = privateKeyToAccount(generatePrivateKey());
    const s = await sharedSignIn(process.env.AGENT_URL || 'http://127.0.0.1:3001', buyer, {
      chainId: 4663,
      domain: SIWE_DOMAIN,
      uri: SIWE_URI,
    });
    if (s.status !== 200 || !s.body?.access_token) {
      check('a wallet can sign in', false, `status ${s.status} ${JSON.stringify(s.body)}`);
      return;
    }
    check('a wallet can sign in', true);
    const token = s.body.access_token;

    const p = await page(`/marketplace/${listingId}`, token);
    const t = text(p.html);
    check('the listing page renders for a signed-in buyer', p.status === 200, `status ${p.status}`);
    check('the sign-in gate is gone', !/Sign in to subscribe/i.test(t), 'still asking a signed-in buyer to sign in');
    check('the no-refund warning is still on the quote step',
      /No refunds/i.test(t), 'the warning disappeared once signed in');
    // THE BUTTON IS DISABLED UNTIL THE WARNING IS ACKNOWLEDGED. An
    // irreversible transfer should not be one accidental click away.
    check('an acknowledgement is required before the transfer step',
      /I understand the payment is final/i.test(t),
      'no acknowledgement is asked for');
    check('and the continue control starts disabled',
      /disabled=""|disabled\b/.test(p.html),
      'the continue button is not disabled before the box is ticked');

    // MY SUBSCRIPTIONS, for a wallet that has none. The distinction that
    // matters is a counted zero rather than a failure to read.
    const mine = await page('/me/subscriptions', token);
    const mt = text(mine.html);
    check('the subscriptions page renders for a signed-in wallet', mine.status === 200, `status ${mine.status}`);
    check('and a wallet with no subscription is told so, as a counted zero',
      /Nothing is trading in this wallet/i.test(mt),
      'the empty subscription list does not say which kind of empty it is');
    check('rather than reporting a failure to read',
      !/could not be read/i.test(mt), 'the page reports a read failure for an empty list');

    // AND A SIGNED-OUT VISITOR IS SENT TO SIGN IN, not shown an empty list.
    const out = await page('/me/subscriptions');
    check('a signed-out visitor is redirected to sign in rather than shown an empty list',
      out.status === 200 && /Sign in|signin/i.test(out.html),
      `status ${out.status}`);
  });

  await section('A fixture listing does not leak into the public grid', async () => {
    // THE PROVENANCE RULE, PROVED WHILE A FIXTURE IS LIVE. Every counting
    // surface excludes verification rows, and the only way to know that still
    // holds is to check it while one exists.
    const b = await api(MARKET, '/v1/marketplace/browse');
    const ids = (b.body?.items ?? []).map((i) => i.listing_id);
    check('the browse grid excludes the verification-provenance listing',
      !ids.includes(listingId), `${listingId} is in the public grid`);
    const grid = await page('/marketplace');
    check('and its name is not rendered on the marketplace page',
      !text(grid.html).includes(TAG), `${TAG} appears in the grid`);
  });
} finally {
  teardown();
  listingId = agentId = creatorId = null;
}

const code = report();
if (code !== 0) process.exit(code);
console.log('marketplace-flow-verify: a buyer who can pay is shown the address, the amount and the warning.');
