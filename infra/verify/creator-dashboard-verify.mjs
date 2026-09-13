/**
 * creator-dashboard-verify.mjs — the creator surface, driven as a creator.
 *
 * WHY A FIXTURE CREATOR RATHER THAN A REAL ONE. Every creator on this
 * deployment belongs to somebody, and the only way to exercise pause, risk
 * edits and retirement is to perform them. Doing that to a live agent would be
 * a verification that changes the thing it measures. So this signs in as a
 * fresh wallet, builds a creator and an agent through the real endpoints, does
 * the whole lifecycle to it, and removes it.
 *
 * THE CHECK THIS FILE EXISTS FOR is that pausing an agent tells its owner the
 * truth. `ArmedGuards` in the engine reads
 * `WHERE g.status = 'armed' AND a.status = 'active'`, so pausing stops the
 * guard watcher from seeing that agent's levels — the rows still say "armed"
 * and nothing is checking them. The design this platform was built from says
 * the opposite. A pause response that did not say so would send somebody away
 * from an open position believing it had a stop.
 *
 *   node infra/verify/creator-dashboard-verify.mjs
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { suite } from './lib/sections.mjs';
import { signIn as sharedSignIn, SIWE_DOMAIN, SIWE_URI } from './lib/rate-aware.mjs';

const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const WEB = process.env.WEB_URL || 'http://127.0.0.1:3000';
const DB = process.env.DATABASE_URL || 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';

const { check, section, nothingToCheck, report } = suite('creator-dashboard-verify');

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
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

// Lowercase alphanumeric and underscore only — the handle validator's rule,
// matched here rather than discovered from a 400 halfway through a run.
const TAG = `verify_dash_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
let creatorId = null;
let agentId = null;

function teardown() {
  try {
    if (agentId) {
      sql(`DELETE FROM position_guards WHERE agent_id = '${agentId}'`);
      sql(`DELETE FROM agent_wallets WHERE agent_id = '${agentId}'`);
      sql(`DELETE FROM portfolio_snapshots WHERE portfolio_id IN (SELECT id FROM portfolios WHERE agent_id = '${agentId}')`);
      sql(`DELETE FROM portfolios WHERE agent_id = '${agentId}'`);
      sql(`DELETE FROM agents WHERE id = '${agentId}'`);
    }
    if (creatorId) sql(`DELETE FROM creators WHERE id = '${creatorId}'`);
  } catch (e) {
    console.log('  cleanup warning: ' + e.message);
  }
}
try {
  const stale = sql(`SELECT count(*) FROM creators WHERE handle LIKE 'verify_dash_%'`);
  if (stale !== '0') {
    console.log(`  (clearing ${stale} fixture creator(s) left by an interrupted run)`);
    sql(`DELETE FROM agents WHERE creator_id IN (SELECT id FROM creators WHERE handle LIKE 'verify_dash_%')`);
    sql(`DELETE FROM creators WHERE handle LIKE 'verify_dash_%'`);
  }
} catch (e) {
  console.log('  stale-cleanup warning: ' + e.message);
}
process.on('exit', teardown);
process.on('SIGINT', () => { teardown(); process.exit(130); });

try {
  const owner = privateKeyToAccount(generatePrivateKey());
  const s = await sharedSignIn(AGENT, owner, { chainId: 4663, domain: SIWE_DOMAIN, uri: SIWE_URI });
  if (s.status !== 200 || !s.body?.access_token) {
    check('a fresh wallet can sign in', false, `status ${s.status} ${JSON.stringify(s.body)}`);
    throw new Error('cannot continue without a session');
  }
  token = s.body.access_token;

  await section('A wallet with no creator profile is offered one, not an empty dashboard', async () => {
    check('a fresh wallet signs in', true);
    const p = await page('/me');
    const t = text(p.html);
    check('the dashboard renders for it', p.status === 200, `status ${p.status}`);
    check('and says a creator profile is a separate, deliberate act',
      /no creator profile yet/i.test(t), 'the page does not explain the missing profile');
    check('rather than reporting a failure', !/could not be read/i.test(t), 'it reports a read failure');
  });

  // --- the fixture ---------------------------------------------------------
  const c = await api('/v1/creators', { method: 'POST', body: { handle: TAG } });
  if (c.status >= 300) throw new Error('creator: ' + JSON.stringify(c.body));
  creatorId = c.body.id;

  const made = await api('/v1/agents', {
    method: 'POST',
    body: {
      name: `${TAG}_agent`,
      assetUniverse: 'us_equities',
      mandate: 'Buy strength and exit any position that falls 0.0150 (= 1.50%) below entry.',
      // ONE KEY THAT WORKS, ONE THAT IS NEVER READ, ONE WHOSE NAME LIES ABOUT
      // ITS SCALE. All three warnings have to reach the owner, and this is the
      // shape that produces all three at once.
      riskProfile: JSON.stringify({
        max_position_pct: 0.4,
        stoploss_pct: 0.05,
        stop_loss_pct: 0.05,
      }),
    },
  });
  if (made.status >= 300) throw new Error('agent: ' + JSON.stringify(made.body));
  agentId = made.body.id;

  await section('Creating an agent names what will never be read, and what is misnamed', async () => {
    check('the agent was created as a draft', made.body.status === 'draft', String(made.body.status));
    const unread = made.body.risk_profile_unrecognised ?? [];
    check('a key the engine never reads is named back',
      unread.includes('stoploss_pct'), JSON.stringify(unread));
    check('and the key that DOES work is not named as unread',
      !unread.includes('stop_loss_pct'), JSON.stringify(unread));
    const amb = made.body.risk_profile_ambiguous ?? [];
    check('the fraction-named-pct key is named as ambiguous', amb.includes('stop_loss_pct'), JSON.stringify(amb));
    // THE CONVERSION, WHICH WAS WRONG BY A HUNDREDFOLD.
    const note = made.body.risk_profile_ambiguous_note ?? '';
    check('and its note converts the fraction correctly: 0.05 is 5%',
      /0\.05 means 5%/.test(note), note);
  });

  await section('The dashboard publishes the slot cap it is enforcing', async () => {
    const d = await api(`/v1/creators/${creatorId}/dashboard`);
    check('the dashboard endpoint answers', d.status === 200, `status ${d.status}`);
    check('it states the cap', typeof d.body?.slots?.cap === 'number' && d.body.slots.cap > 0,
      JSON.stringify(d.body?.slots));
    check('and that the cap counts ACTIVE agents, not every agent ever made',
      /active/i.test(d.body?.slots?.counts ?? '') && /Retired ones do not count/i.test(d.body?.slots?.note ?? ''),
      JSON.stringify(d.body?.slots));
    check('the new draft is listed', (d.body?.agents ?? []).some((a) => a.id === agentId),
      `${(d.body?.agents ?? []).length} agent(s) returned`);

    const p = await page('/me');
    const t = text(p.html);
    check('and the page prints the cap rather than a number of its own',
      t.includes(`of ${d.body.slots.cap}`), `expected "of ${d.body.slots.cap}" on the page`);
  });

  await section('Risk limits can be changed on a live agent, and removal is named', async () => {
    const act = await api(`/v1/agents/${agentId}/activate`, { method: 'POST' });
    check('the draft activates', act.status < 300, `${act.status} ${JSON.stringify(act.body)}`);

    // The endpoint that did not exist: an owner could not move a stop at all.
    const r = await api(`/v1/agents/${agentId}/risk`, {
      method: 'PATCH',
      body: { riskProfile: { max_position_pct: 0.25, stop_loss_fraction: 0.002 } },
    });
    check('risk limits can be set on an ACTIVE agent', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
    check('the change is named', (r.body?.changed ?? []).includes('max_position_pct'),
      JSON.stringify(r.body?.changed));
    // REMOVAL IS THE ONE A MERGE CANNOT EXPRESS.
    check('and so is every limit that was removed',
      (r.body?.removed ?? []).includes('stop_loss_pct') && (r.body?.removed ?? []).includes('stoploss_pct'),
      JSON.stringify(r.body?.removed));
    check('with a note saying it replaces rather than merges',
      /replaces the profile rather than merging/i.test(r.body?.removed_note ?? ''), r.body?.removed_note ?? '');
    check('an already-open position keeps the level it was armed with',
      /does not move a level that is already on the chain/i.test(r.body?.applies_note ?? ''),
      r.body?.applies_note ?? '');

    const stored = sql(`SELECT risk_profile::text FROM agents WHERE id = '${agentId}'`);
    check('and the stored profile is the one that was sent',
      stored.includes('0.25') && !stored.includes('stoploss_pct'), stored);
  });

  await section('A mandate cannot be edited once active, and the refusal says what to do', async () => {
    const r = await api(`/v1/agents/${agentId}`, { method: 'PATCH', body: { mandate: 'something else entirely' } });
    check('the edit is refused', r.status >= 400, `status ${r.status}`);
    const msg = r.body?.message?.message ?? r.body?.message ?? JSON.stringify(r.body);
    check('and the refusal names evolve as the way to change intent',
      /evolve/i.test(String(msg)), String(msg).slice(0, 200));

    // AND THE PAGE SAYS IT BEFORE ANYBODY TRIES.
    const p = await page(`/me/agents/${agentId}`);
    const t = text(p.html);
    check('the manage page renders', p.status === 200, `status ${p.status}`);
    check('and states the mandate is immutable rather than offering a field',
      /immutable for v/i.test(t) && /cannot be edited once an agent has started/i.test(t),
      'the page does not say the mandate is fixed');
  });

  await section('Pausing says that protective exits stop — which is what the engine does', async () => {
    // An armed guard, so the pause has something to leave unwatched. Inserted
    // directly: arming one for real needs a fill, and the claim under test is
    // about what the WATCHER reads, not about how the row got there.
    sql(`INSERT INTO position_guards (agent_id, symbol, status, entry_price, entry_qty, stop_loss, stop_loss_pct, set_at)
         VALUES ('${agentId}', 'AAPL', 'armed', 100, 1, 98.5, 0.015, now())`);

    const r = await api(`/v1/agents/${agentId}/pause`, { method: 'POST', body: { because: 'verification' } });
    check('an active agent can be paused', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
    check('the status is paused', r.body?.status === 'paused', String(r.body?.status));

    // THE POINT OF THIS SUITE.
    check('the response leads with the fact that protection stops',
      r.body?.protection_stops === true, JSON.stringify(r.body?.protection_stops));
    check('and names the levels left unwatched',
      (r.body?.guards_left_unwatched ?? []).includes('AAPL'),
      JSON.stringify(r.body?.guards_left_unwatched));
    check('saying the rows still read armed while nothing checks them',
      /still say "armed"|STOP BEING CHECKED/i.test(r.body?.protection_note ?? ''),
      r.body?.protection_note ?? '');

    // THE ENGINE'S OWN QUERY, RUN HERE. If this ever stops being true the
    // warning above becomes a lie, and a suite that only checked the wording
    // would go on passing.
    const visible = sql(
      `SELECT count(*) FROM position_guards g JOIN agents a ON a.id = g.agent_id
        WHERE g.status = 'armed' AND a.status = 'active' AND g.agent_id = '${agentId}'`,
    );
    check('and the guard watcher genuinely cannot see them while paused', visible === '0',
      `the watcher's own query returns ${visible} row(s) for a paused agent`);

    const resumed = await api(`/v1/agents/${agentId}/resume`, { method: 'POST' });
    check('resuming restores it', resumed.status === 200 && resumed.body?.status === 'active',
      `${resumed.status} ${JSON.stringify(resumed.body?.status)}`);
    const back = sql(
      `SELECT count(*) FROM position_guards g JOIN agents a ON a.id = g.agent_id
        WHERE g.status = 'armed' AND a.status = 'active' AND g.agent_id = '${agentId}'`,
    );
    check('and the watcher can see the level again', back === '1', `${back} row(s)`);
  });

  await section('Triggers show what is armed, and refuse to offer what nothing evaluates', async () => {
    const r = await api(`/v1/agents/${agentId}/triggers`);
    check('the triggers endpoint answers', r.status === 200, `status ${r.status}`);
    check('the armed level is listed', (r.body?.armed ?? []).some((g) => g.symbol === 'AAPL'),
      JSON.stringify((r.body?.armed ?? []).map((g) => g.symbol)));
    // BOTH SCALES. This is the platform where 0.15 was armed as 15%.
    const g = (r.body?.armed ?? []).find((x) => x.symbol === 'AAPL');
    check('with the level in both the fraction and the percent',
      g?.stop_loss_fraction === 0.015 && g?.stop_loss_percent === 1.5,
      JSON.stringify({ f: g?.stop_loss_fraction, p: g?.stop_loss_percent }));
    check('and whether anything is actually watching it', g?.watched === true, String(g?.watched));

    // THE EDITOR THAT IS NOT OFFERED, AND THE REASON.
    const na = r.body?.not_available ?? [];
    check('the conditions this platform cannot evaluate are named', na.length > 0, JSON.stringify(na));
    check('each says what is missing rather than appearing as an empty slot',
      na.every((n) => typeof n.missing === 'string' && n.missing.length > 20), JSON.stringify(na));
    check('and the note explains why a stored-but-unevaluated condition is not offered',
      /stored and never evaluated|looks exactly like one that works/i.test(r.body?.not_available_note ?? ''),
      r.body?.not_available_note ?? '');
  });

  await section('The wallet page separates the money from the gas', async () => {
    const w = await api(`/v1/agents/${agentId}/wallet`);
    check('a wallet can be derived', w.status === 200 && /^0x[0-9a-fA-F]{40}$/.test(w.body?.address ?? ''),
      `${w.status} ${w.body?.address}`);

    const b = await api(`/v1/agents/${agentId}/wallet/balances`);
    check('balances answer', b.status === 200, `status ${b.status}`);
    check('the token and the native balance are reported separately',
      !!b.body?.token && !!b.body?.native, JSON.stringify({ t: !!b.body?.token, n: !!b.body?.native }));
    check('each carries its own availability, so one failing is not the other reading zero',
      typeof b.body?.token?.available === 'boolean' && typeof b.body?.native?.available === 'boolean',
      JSON.stringify({ t: b.body?.token?.available, n: b.body?.native?.available }));
    // A FRESH AGENT HAS NO PRICED FILLS, so the runway must say unknown rather
    // than offering a default that would warn the wrong agents.
    check('a gas runway with nothing to measure says so rather than defaulting',
      b.body?.gas?.known === false && /median needs at least three/i.test(b.body?.gas?.reason ?? ''),
      JSON.stringify(b.body?.gas));

    const t = await api(`/v1/agents/${agentId}/wallet/transactions`);
    check('transactions answer', t.status === 200, `status ${t.status}`);
    check('and state the completeness they do NOT have',
      /never pass through this platform|block explorer/i.test(t.body?.completeness ?? ''),
      t.body?.completeness ?? '');
  });

  await section('Retiring says what it does not do', async () => {
    const r = await api(`/v1/agents/${agentId}/retire`, { method: 'POST' });
    check('the agent retires', r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);
    const status = sql(`SELECT status FROM agents WHERE id = '${agentId}'`);
    check('and is recorded as retired', status === 'retired', status);

    // THE DESIGN SAYS RETIRING CLOSES POSITIONS AT MARKET AND RETURNS FUNDS.
    // It does neither, and the page must not repeat the claim.
    const p = await page(`/me/agents/${agentId}`);
    const t = text(p.html);
    check('the manage page renders for a retired agent', p.status === 200, `status ${p.status}`);
    check('and does not claim the positions were sold',
      !/closes positions at market|returns funds to you/i.test(t),
      'the page repeats a claim about selling out that this platform does not do');
    check('it says the record is frozen instead',
      /record is frozen/i.test(t), 'the retired banner did not render');

    const rr = await api(`/v1/agents/${agentId}/risk`, { method: 'PATCH', body: { riskProfile: { max_position_pct: 0.1 } } });
    check('and a retired agent\'s limits can no longer be edited',
      rr.status >= 400, `status ${rr.status}`);
  });
} finally {
  teardown();
  agentId = creatorId = null;
}

const code = report();
if (code !== 0) process.exit(code);
console.log('creator-dashboard-verify: an owner is told what pausing costs, and what retiring does not do.');
