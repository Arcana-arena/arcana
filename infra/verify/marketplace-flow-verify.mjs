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

async function api(base, path, token = null) {
  const r = await fetch(`${base}${path}`, {
    headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
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
    // THE SCANNABLE FORM IS BUILT BY THE SERVICE, and it has to encode the
    // same address and the same amount as the text beside it. A QR is the one
    // control a buyer cannot proofread, so a divergence here would be found by
    // the chain and by nobody else.
    check('it carries an EIP-681 payment URI',
      typeof q.body.eip681 === 'string' && q.body.eip681.startsWith('ethereum:'), String(q.body.eip681));
    if (typeof q.body.eip681 === 'string') {
      check('the URI names the same token as the quote',
        q.body.eip681.includes(q.body.token), q.body.eip681);
      check('the same recipient as the quote',
        q.body.eip681.includes(q.body.pay_to), q.body.eip681);
      check('the same amount in base units as the quote',
        q.body.eip681.includes('uint256=' + q.body.amount_base_units), q.body.eip681);
      check('and a chain id, so a wallet cannot offer it on the wrong network',
        new RegExp('@[0-9]+/').test(q.body.eip681), q.body.eip681);
    }
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

  await section('A stopped agent takes its listing off the market, and the market says so', async () => {
    // WHAT THIS SUITE USED TO PROVE, AND WHY IT WAS NOT ENOUGH. Every check
    // above builds a listing that CAN be bought and confirms it is offered.
    // That is an existence test: it can only fail if something correct stops
    // working. The defect it could never see is the opposite one — a listing
    // that should NOT be offered and is — and that is the defect production
    // actually had. A retired agent stayed on the marketplace until somebody
    // noticed by hand, and the repair was manual: a wallet granted to
    // arcana_labs and the listing moved to an agent that still ran.
    //
    // So this section asks the question the other way round, against LIVE rows
    // rather than a fixture: of everything the marketplace is offering right
    // now, is any of it dead? A fixture cannot answer that — it is excluded by
    // provenance before the status rule is ever consulted.
    const stopped = Number(
      sql(`SELECT count(*) FROM marketplace_listings l JOIN agents a ON a.id = l.agent_id
            WHERE a.provenance = 'live' AND a.status <> 'active'`),
    );

    const b = await api(MARKET, '/v1/marketplace/browse');
    check('the browse grid answers', b.status === 200, `status ${b.status}`);
    const shown = b.body?.items ?? [];
    const dead = shown.filter((i) => i.agent_status !== 'active');
    check('every listing the grid offers belongs to an agent that is still active',
      dead.length === 0,
      dead.map((i) => `${i.agent_name} is ${i.agent_status}`).join('; '));

    // COUNTED, NOT INFERRED FROM A SHORT ARRAY. An empty grid and a grid that
    // withheld everything look identical from the outside, and the page has to
    // tell a shopper which.
    check('and the grid reports how many it withheld, matching the database',
      b.body?.counts?.hidden_unavailable === stopped,
      `grid says ${b.body?.counts?.hidden_unavailable}, the database holds ${stopped}`);
    if (stopped > 0) {
      check('with the reason broken down by status rather than a bare total',
        Object.values(b.body?.counts?.hidden_by_agent_status ?? {}).reduce((a, n) => a + n, 0) === stopped,
        JSON.stringify(b.body?.counts?.hidden_by_agent_status));
      check('and says in words that nothing was deleted',
        typeof b.body?.hidden_note === 'string' && /resumes? it|not shown/i.test(b.body.hidden_note),
        String(b.body?.hidden_note));
    } else {
      nothingToCheck('no live listing currently belongs to a stopped agent, so there is no withheld row to describe');
    }

    // THE ROWS ARE STILL THERE. Hidden is not deleted, and the difference is
    // the whole of the owner's constraint.
    const all = await api(MARKET, '/v1/marketplace/browse?include_unavailable=true');
    check('include_unavailable=true returns the withheld rows rather than having dropped them',
      (all.body?.items ?? []).length === shown.length + stopped,
      `${(all.body?.items ?? []).length} with them, ${shown.length} without, ${stopped} withheld`);
    check('and the response says it is including them',
      all.body?.including_unavailable === true, String(all.body?.including_unavailable));

    // THE LANDING PAGE READS A DIFFERENT QUERY, and it was the one with no
    // status rule at all.
    const disc = await api(MARKET, '/v1/marketplace/agents?sort=score_desc');
    check('the discovery feed the landing page reads answers', disc.status === 200, `status ${disc.status}`);
    const feedIds = (disc.body ?? []).map((r) => r.agent_id).filter(Boolean);
    const feedDead = feedIds.length
      ? sql(`SELECT coalesce(string_agg(name || ' is ' || status, '; '), '') FROM agents
              WHERE id = ANY(ARRAY['${feedIds.join("','")}']::uuid[]) AND status <> 'active'`)
      : '';
    check('and it offers no agent that has stopped trading', feedDead === '', feedDead);
  });

  await section('The money path refuses a stopped agent BEFORE anything is sent', async () => {
    // THE GRID'S HONESTY WAS ADVISORY. It printed "RETIRED" on a card and the
    // quote endpoint went on handing out an address and an amount, so a
    // bookmark, a renewal or an open tab could still pay for a dead agent. A
    // refusal that arrives after the transfer is not a refusal.
    for (const [status, code] of [['paused', 'agent_paused'], ['retired', 'agent_retired']]) {
      sql(`UPDATE agents SET status = '${status}' WHERE id = '${agentId}'`);

      const q = await api(MARKET, `/v1/marketplace/listings/${listingId}/quote`);
      // The marketplace proxies arca's refusal, so the body is the wrapped
      // shape. Read BOTH spellings: the point of the check is that the reason
      // reaches the caller, not which envelope carries it.
      const qCode = q.body?.error?.code ?? q.body?.code;
      const qMessage = String(q.body?.error?.message ?? q.body?.message ?? '');
      check(`a ${status} agent's listing is refused a quote`, q.status === 400, `status ${q.status}`);
      check(`and the refusal names why (${code}) rather than only that a service was unhappy`,
        qCode === code, `${qCode}: ${qMessage}`);
      check('and the refusal tells the buyer not to send anything',
        /should be sent|not (?:be )?sent|Nothing was charged/i.test(qMessage), qMessage);

      // THE DETAIL PAGE STAYS READABLE. A buyer holding a link to something
      // they already paid for must still be able to read the record; what
      // changes is that it cannot be bought.
      const d = await api(MARKET, `/v1/marketplace/listings/${listingId}/detail`);
      check(`the ${status} listing is still readable by direct link`, d.status === 200, `status ${d.status}`);
      check('and states it cannot be bought, with the reason',
        d.body?.buyable === false && d.body?.not_buyable_because === code,
        `buyable=${d.body?.buyable} because=${d.body?.not_buyable_because}`);
    }

    // AND RESUMING PUTS IT BACK, with nobody touching the listing row. This is
    // the reason the rule is derived from the agent instead of written onto the
    // listing: there is no flag to restore, so there is no flag to forget.
    const activeBefore = sql(`SELECT active FROM marketplace_listings WHERE id = '${listingId}'`);
    sql(`UPDATE agents SET status = 'active' WHERE id = '${agentId}'`);
    const back = await api(MARKET, `/v1/marketplace/listings/${listingId}/quote`);
    check('resuming the agent makes its listing quotable again, with no creator action',
      back.status === 200, `status ${back.status} ${JSON.stringify(back.body)}`);
    check('and the listing row was never written to while it was hidden',
      sql(`SELECT active FROM marketplace_listings WHERE id = '${listingId}'`) === activeBefore,
      `active was ${activeBefore} before the pause`);
  });

  await section('A term already paid for outlives the agent that stopped', async () => {
    // THE OWNER'S RULE. Hiding a listing must not reach backwards into what
    // somebody already bought: thirty days were paid for, and a paused agent
    // may yet come back. So access keeps its date, and what changes is that
    // nothing new can be sold and the buyer is TOLD that nothing is arriving.
    // A REAL WALLET, SIGNED IN. The buyer-facing list is JWT-scoped to its own
    // address, so a made-up one can only ever produce a 401 — and a 401 here
    // would be recorded as "not proven", which is not a pass and is not the
    // answer this section exists to give.
    const buyer = privateKeyToAccount(generatePrivateKey());
    const buyerWallet = buyer.address.toLowerCase();
    const s = await sharedSignIn(process.env.AGENT_URL || 'http://127.0.0.1:3001', buyer, {
      chainId: 4663,
      domain: SIWE_DOMAIN,
      uri: SIWE_URI,
    });
    const token = s.status === 200 ? s.body?.access_token : null;
    check('the buyer can sign in', !!token, `status ${s.status} ${JSON.stringify(s.body)}`);

    sql(`INSERT INTO subscriptions (user_wallet, listing_id, agent_id, expires_at, status)
         VALUES ('${buyerWallet}', '${listingId}', '${agentId}', now() + interval '20 days', 'active')`);

    sql(`UPDATE agents SET status = 'retired' WHERE id = '${agentId}'`);
    const after = sql(`SELECT status || ' ' || (expires_at > now())::text FROM subscriptions
                        WHERE listing_id = '${listingId}' AND user_wallet = '${buyerWallet}'`);
    check('retiring the agent does not cancel a running subscription',
      after === 'active true', `the subscription reads '${after}'`);

    // AND THE BUYER IS NOT LEFT TO INFER IT from a wallet that stops moving.
    const acc = await api(ARCA, `/v1/subscriptions/${buyerWallet}`, token);
    check('the buyer can read their own subscriptions', acc.status === 200,
      `status ${acc.status} ${JSON.stringify(acc.body)}`);
    // The rows are TypeORM entities spread into the response, so the listing
    // key is camelCase there while the fields this endpoint adds are snake_case.
    // Matched on either rather than on the one that happened to be guessed.
    const row = Array.isArray(acc.body)
      ? acc.body.find((r) => (r.listingId ?? r.listing_id) === listingId)
      : null;
    check('and the term they paid for is still there, still in its active phase',
      row?.phase === 'active', `phase=${row?.phase ?? 'the subscription is not in the list'}`);
    check('and the card stops claiming the agent is trading for them',
      row?.trading === false, `trading=${row?.trading}`);
    check('and says what happened to the agent, and until when the access runs',
      row?.agent_standing?.status === 'retired' && typeof row?.agent_standing?.note === 'string',
      JSON.stringify(row?.agent_standing ?? null));

    sql(`UPDATE agents SET status = 'active' WHERE id = '${agentId}'`);
  });

  await section('A refusal keeps its WHOLE payload across the service boundary', async () => {
    // WHY THIS IS HERE AND NOT IN claims-verify. That suite starts its own
    // arca-service and asks it directly, so it proves arca BUILDS these
    // payloads — and it has passed every day while no buyer ever saw one,
    // because the marketplace wrapper in front of it kept `code` and `message`
    // and dropped everything else. Each side was right; nothing tested the
    // seam. This asks the running marketplace, through the door a browser uses.
    //
    // The refusal is provoked with a REAL mined transaction that paid somebody
    // else — an anchoring self-send — so nothing is spent and the chain
    // genuinely disagrees with the claim. `no_matching_transfer` carries the
    // address the money was supposed to reach and the transfers it actually
    // made, which is the difference between "you paid the wrong place" and "we
    // could not tell".
    const realHash = sql(
      `SELECT trim(tx_hash) FROM decision_anchors WHERE status = 'mined' ORDER BY id DESC LIMIT 1`,
    );
    if (!realHash || !/^0x[0-9a-f]{64}$/i.test(realHash)) {
      nothingToCheck('no mined anchor transaction exists to claim with, so the refusal cannot be provoked');
      return;
    }

    const buyer = privateKeyToAccount(generatePrivateKey());
    const s = await sharedSignIn(process.env.AGENT_URL || 'http://127.0.0.1:3001', buyer, {
      chainId: 4663,
      domain: SIWE_DOMAIN,
      uri: SIWE_URI,
    });
    if (s.status !== 200 || !s.body?.access_token) {
      check('a buyer can sign in to submit a claim', false, `status ${s.status}`);
      return;
    }

    const r = await fetch(`${MARKET}/v1/marketplace/listings/${listingId}/claim-payment`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${s.body.access_token}`,
      },
      body: JSON.stringify({ txHash: realHash }),
    });
    const body = await r.json().catch(() => null);
    const err = body?.error ?? body ?? {};

    check('claiming a transaction that paid somebody else is refused', r.status >= 400, `status ${r.status}`);
    check('and the refusal is named, not generic',
      err.code === 'no_matching_transfer', `${err.code}: ${err.message ?? ''}`);

    // THE FIELDS THE SCREEN IS BUILT FROM. Without these the page can print
    // the sentence and nothing else — no address to compare, no transfer list.
    check('the address the money should have reached survives the proxy',
      typeof err.expected_recipient === 'string' && err.expected_recipient.startsWith('0x'),
      String(err.expected_recipient));
    check('and the token it should have been paid in',
      typeof err.expected_token === 'string' && err.expected_token.startsWith('0x'),
      String(err.expected_token));
    check('and the transfers the transaction actually made',
      Array.isArray(err.transfers), JSON.stringify(err.transfers ?? null));

    // AND THE WRAPPER STILL SAYS WHICH CALL FAILED, beside the upstream code
    // rather than instead of it.
    check('while the wrapper still records which call it was',
      err.failed === 'arca_claim_payment_failed', String(err.failed));
    check('and attaches its own trace id', typeof err.trace_id === 'string' && err.trace_id.length > 0,
      String(err.trace_id));

    // Nothing was bought by a refused claim.
    const rows = sql(`SELECT count(*) FROM payment_claims WHERE tx_hash = '${realHash.toLowerCase()}'`);
    check('and a refused claim records nothing', rows === '0', `${rows} claim row(s)`);
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
