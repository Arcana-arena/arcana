/**
 * subscription-verify.mjs — what a marketplace subscription actually buys,
 * driven rather than read.
 *
 * WHAT A SUBSCRIPTION IS NOW. One agent, one mandate, several wallets: the
 * creator's and one per buyer. Ownership does not move, the decision stays
 * singular, and each wallet resolves that decision against its own money under
 * its own limits for thirty days.
 *
 * WHAT THIS SUITE COVERS AND WHAT IT CANNOT.
 *
 * It covers everything that does not need funds: who the agent would trade for,
 * who it would not, what a buyer can reach and what they cannot, whose wallet a
 * protective level watches, and what happens to that level when the mandate
 * ends. The chain-side proof — ONE decision producing TWO transactions in TWO
 * wallets — is subscription-chain-verify.mjs, because it spends real money and
 * must not run on every commit.
 *
 * THIS SUITE CANNOT SPEND MONEY, AND NOT BECAUSE ITS WALLETS ARE EMPTY.
 *
 * That distinction is the point. On 2026-09-11 a suite bought $5.96 of MSFT
 * because a lever it depended on had been retired; the answer was not to
 * remember harder but to move the refusal into the engine. Every request here
 * carries X-Arcana-Verification, and the ENGINE then refuses to act on an agent
 * that holds a wallet OR that has a subscriber wallet. The first section proves
 * the fan-out is inside that rule by pointing a fixture subscription at a wallet
 * that really does hold funds — reading a balance costs nothing, and the
 * refusal happens before anything is signed.
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { req, signInToken, bearer, ok2xx } from './lib/rate-aware.mjs';

const REPO = process.env.REPO || '/home/ubuntu/arcana';
const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const PORT = Number(process.env.TEST_SUB_PORT || 8094);
const GO = process.env.GO_BIN || '/usr/local/go/bin/go';
const PG = process.env.PG_CONTAINER || 'arcana-postgres';
const DB = process.env.DATABASE_URL || 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';
const SEASON = process.env.SEASON_ID || '00000002-0000-4000-8000-000000000002';

const env = Object.fromEntries(
  readFileSync(`${REPO}/.env.auth`, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const KEY = env.INTERNAL_API_KEY;
const llmEnv = Object.fromEntries(
  execFileSync('sudo', ['cat', `${REPO}/.env.llm`], { encoding: 'utf8' })
    .split('\n').filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

let pass = 0, fail = 0, exitCode = 0;
const failures = [];
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; failures.push(`${n} — ${d}`); console.log(`  FAIL  ${n} — ${d}`); }
};
// FIRST LINE ONLY. With -tAc an INSERT ... RETURNING prints the value and then
// the command tag ('INSERT 0 1'), and the tag travelled into the next query as
// part of a uuid. Trimming is not enough; the split is.
const psql = (s) => execFileSync('docker', ['exec', PG, 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc', s], { encoding: 'utf8' }).trim().split(/\r?\n/)[0].trim();

const MARK = 'subscription-verify fixture';
const agents = [];
const handles = [];
const subs = [];
let engineLog = '';
let proc = null;

const ENGINE_BIN = `/tmp/subscription-verify-engine.${process.pid}`;
const SUBCHECK = `/tmp/subscription-verify-subcheck.${process.pid}`;

// --- the engine under test, built and spawned rather than `go run` ----------
// `go run` execs the server as a CHILD, so a SIGKILL to the parent leaves the
// port held — and the next run then measures that orphan instead of the process
// it configured. cost-budget-verify learned this the expensive way.
function build() {
  execFileSync(GO, ['build', '-o', ENGINE_BIN, './cmd/server'],
    { cwd: `${REPO}/services/decision-engine`, stdio: 'inherit' });
  execFileSync(GO, ['build', '-o', SUBCHECK, './cmd/subcheck'],
    { cwd: `${REPO}/services/decision-engine`, stdio: 'inherit' });
}

async function assertPortFree() {
  try { execFileSync('bash', ['-lc', `fuser -k ${PORT}/tcp 2>/dev/null || true`]); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    if (r.ok) throw new Error(
      `something is already listening on ${PORT} and answering /healthz. This suite would have ` +
      'measured that process instead of the one it configures. Refusing to run.');
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('something is already')) throw e;
  }
}

function start() {
  const pr = spawn(ENGINE_BIN, [], {
    cwd: `${REPO}/services/decision-engine`,
    env: {
      ...process.env, ...llmEnv,
      DATABASE_URL: DB, PORT: String(PORT),
      MARKET_DATA_URL: 'http://127.0.0.1:8083', INTERNAL_API_KEY: KEY,
      INFERENCE_TOKENS_PER_AGENT_PER_DAY: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pr.stdout.on('data', (c) => (engineLog += c));
  pr.stderr.on('data', (c) => (engineLog += c));
  return pr;
}
async function up(ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (proc && proc.exitCode !== null) {
      console.log(`  engine exited with code ${proc.exitCode}:\n${engineLog.slice(-600)}`);
      return false;
    }
    try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
async function stop() {
  if (!proc) return;
  proc.kill('SIGKILL');
  try { execFileSync('bash', ['-lc', `fuser -k ${PORT}/tcp 2>/dev/null || true`]); } catch {}
  proc = null;
  await new Promise((r) => setTimeout(r, 1000));
}

async function cycle(agentId, ref) {
  const r = await fetch(`http://127.0.0.1:${PORT}/internal/v1/decisions/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'X-Internal-Key': KEY,
      // THIS is what stops the suite spending, not the emptiness of any wallet.
      'X-Arcana-Verification': '1',
    },
    body: JSON.stringify({ agent_id: agentId, season_id: SEASON, market_snapshot_ref: ref }),
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: r.status, text, body };
}

const subcheck = (...args) => JSON.parse(
  execFileSync(SUBCHECK, args, { encoding: 'utf8', env: { ...process.env, DATABASE_URL: DB } }));

// --- fixtures ---------------------------------------------------------------
async function freshWallet() {
  const acct = privateKeyToAccount(generatePrivateKey());
  const tk = await signInToken(AGENT, acct, { chainId: 4663, domain: 'arcana.local', uri: 'https://arcana.local' });
  return { acct, tk, address: acct.address };
}

async function freshAgent(label) {
  const { acct, tk } = await freshWallet();
  const h = `sub_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const c = await req(`${AGENT}/v1/creators`, { method: 'POST', headers: bearer(tk), body: JSON.stringify({ handle: h }) });
  if (!ok2xx(c.status)) throw new Error('creator: ' + JSON.stringify(c.body));
  handles.push(h);
  const a = await req(`${AGENT}/v1/agents`, {
    method: 'POST', headers: bearer(tk),
    body: JSON.stringify({
      name: `sub ${label} ${Date.now().toString(36)}`,
      assetUniverse: 'stock_tokens',
      // DETERMINISTIC ON PURPOSE. This suite is about whose wallet a decision
      // reaches, not about who decides; an LLM tick costs tokens and takes long
      // enough to hit the engine's own deadline on a cold start.
      strategyType: 'momentum',
    }),
  });
  if (!ok2xx(a.status)) throw new Error('agent: ' + JSON.stringify(a.body));
  agents.push(a.body.id);
  const act = await req(`${AGENT}/v1/agents/${a.body.id}/activate`, { method: 'POST', headers: bearer(tk) });
  if (!ok2xx(act.status)) throw new Error('activate: ' + JSON.stringify(act.body));
  return { id: a.body.id, creator: acct.address, token: tk };
}

/** A subscription row, in whatever state the case needs. */
function makeSub(agentId, buyerWallet, opts = {}) {
  const status = opts.status || 'active';
  const days = opts.days === undefined ? 30 : opts.days;
  const wallet = opts.wallet ? `'${opts.wallet}'` : 'NULL';
  const risk = opts.risk || '{}';
  const paused = opts.paused ? 'true' : 'false';
  const id = psql(
    `INSERT INTO subscriptions (user_wallet, agent_id, status, expires_at, wallet_address,
                                risk_profile, trading_paused)
     VALUES ('${buyerWallet}', '${agentId}', '${status}', now() + interval '${days} days',
             ${wallet}, '${risk}'::jsonb, ${paused})
     RETURNING id::text`);
  subs.push(id);
  return id;
}

const idsOf = (r) => r.would_trade_for.map((s) => s.id).sort();

// A RUN THAT DIED LEAVES ROWS, and the next run then fails on a unique index
// rather than on anything it was testing. The sweep is keyed on this suite's
// own fixture agents — every one is named `sub <label> <base36>` — so it can
// only ever remove what this file created.
function sweepLeftovers() {
  const raw = execFileSync('docker',
    ['exec', PG, 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc',
      "SELECT s.id::text FROM subscriptions s JOIN agents a ON a.id = s.agent_id WHERE a.name LIKE 'sub %'"],
    { encoding: 'utf8' });
  const stale = raw.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const id of stale) {
    for (const t of ['position_guards', 'executions', 'subscription_snapshots']) {
      try { psql(`DELETE FROM ${t} WHERE subscription_id = '${id}'`); } catch {}
    }
    try { psql(`DELETE FROM subscriptions WHERE id = '${id}'`); } catch {}
  }
  if (stale.length) console.log(`  swept ${stale.length} subscription row(s) left by an earlier run`);
}

try {
  sweepLeftovers();
  build();
  await assertPortFree();
  proc = start();
  if (!(await up())) throw new Error('the engine under test never became healthy');

  const ref = psql('SELECT ref FROM market_snapshots ORDER BY tick_time DESC LIMIT 1');
  console.log(`  snapshot: ${ref}`);

  // A wallet that really holds funds, borrowed only as an ADDRESS to read.
  // Nothing here can sign for it; the point is that the engine refuses before
  // anything would be signed.
  const fundedWallet = psql(`SELECT address FROM agent_wallets ORDER BY created_at LIMIT 1`);
  if (!fundedWallet) throw new Error('no chain wallet exists to point the refusal at');

  // =====================================================================
  console.log('\n=== 1. A verification cannot spend, and the FAN-OUT is inside that rule ===');
  {
    const a = await freshAgent('verif');
    const buyer = await freshWallet();

    // CONTROL FIRST, and it is part of the result. If the flag refused
    // everything, the section below would prove nothing at all.
    const clean = await cycle(a.id, ref);
    check('an agent with no wallet and no subscribers is NOT refused by the flag',
      clean.status < 400 && !/could broadcast a transaction/.test(clean.text),
      `the control tick was refused (${clean.status}): ${clean.text.slice(0, 200)}. The flag must ` +
      'only ever refuse MORE — if it refuses an agent that holds nothing, the next two checks ' +
      'would pass for the wrong reason');

    const s = makeSub(a.id, buyer.address, { wallet: fundedWallet });
    const withSub = await cycle(a.id, ref);
    check('the same agent IS refused once a subscriber wallet exists',
      withSub.status >= 400 && /could broadcast a transaction|verification/i.test(withSub.text),
      `the tick was allowed (${withSub.status}) even though this agent can now move a ` +
      `subscriber's funds: ${withSub.text.slice(0, 300)}`);
    check('the refusal names the SUBSCRIBER wallet, not the agent\'s',
      withSub.text.toLowerCase().includes(fundedWallet.toLowerCase()),
      `the refusal does not name ${fundedWallet}. This agent has no wallet of its own, so a ` +
      'refusal that named one would mean the fan-out is being checked by accident rather than ' +
      `on purpose: ${withSub.text.slice(0, 300)}`);

    // AND THE REFUSAL GOES AWAY AGAIN. A check that cannot stop failing is not
    // a check: this proves the subscription wallet is what produced it.
    psql(`UPDATE subscriptions SET wallet_address = NULL WHERE id = '${s}'`);
    const after = await cycle(a.id, ref);
    check('removing the subscriber wallet removes the refusal',
      after.status < 400,
      `still refused (${after.status}) with no funded wallet anywhere: ${after.text.slice(0, 200)}`);
    psql(`UPDATE subscriptions SET wallet_address = '${fundedWallet}' WHERE id = '${s}'`);
  }

  // =====================================================================
  console.log('\n=== 2. Who the agent would trade for, asked of the code that decides ===');
  {
    const a = await freshAgent('fanout');
    const other = await freshAgent('fanout-other');
    const b = await freshWallet();

    const active = makeSub(a.id, b.address, { wallet: '0x' + '11'.repeat(20) });
    const grace = makeSub(a.id, b.address, { wallet: '0x' + '22'.repeat(20), status: 'grace' });
    const expired = makeSub(a.id, b.address, { wallet: '0x' + '33'.repeat(20), days: -1 });
    const paused = makeSub(a.id, b.address, { wallet: '0x' + '44'.repeat(20), paused: true });
    const nowallet = makeSub(a.id, b.address, {});
    const elsewhere = makeSub(other.id, b.address, { wallet: '0x' + '55'.repeat(20) });

    const r = subcheck('-fanout', a.id);
    const got = idsOf(r);
    check('an active subscription with a wallet is traded for',
      got.includes(active), `${JSON.stringify(got)} does not contain ${active}`);
    check('GRACE is not traded for',
      !got.includes(grace),
      'a lapsed subscriber kept spending money. Grace keeps you READING the record, which costs ' +
      'nothing; it does not keep buying on your behalf');
    check('an expiry that has passed is not traded for even while status says active',
      !got.includes(expired),
      'the thirty days are real; a status column that has not been swept yet is not a licence');
    check('a subscriber who paused is not traded for',
      !got.includes(paused), 'the buyer\'s own stop was ignored');
    check('a subscription with no derived wallet is not traded for',
      !got.includes(nowallet), 'there is nowhere to execute, and it was included anyway');
    check('another agent\'s subscriber is not traded for',
      !got.includes(elsewhere), 'one agent reached into another agent\'s customer list');

    // ONE WALLET FAILING MUST NOT FAIL THE OTHERS.
    //
    // risk_profile is JSONB, so it can hold a value that is valid JSON and is
    // not an object. The first version of this read returned an error for the
    // WHOLE list when it met one, which meant a single malformed profile
    // stopped the agent trading for every other buyer. Triggered here for real
    // rather than reasoned about.
    const broken = makeSub(a.id, b.address, { wallet: '0x' + '66'.repeat(20), risk: '[1,2,3]' });
    const r2 = subcheck('-fanout', a.id);
    const got2 = idsOf(r2);
    check('a malformed risk_profile excludes ONLY that subscriber',
      !got2.includes(broken) && got2.includes(active),
      `with one unreadable profile the fan-out returned ${JSON.stringify(got2)}. It must exclude ` +
      `${broken} and still contain ${active}: one wallet failing may never fail the others`);
  }

  // =====================================================================
  console.log('\n=== 3. Grace and expiry: reading survives, trading does not ===');
  {
    const a = await freshAgent('grace');
    const buyer = await freshWallet();
    const g = makeSub(a.id, buyer.address, { wallet: '0x' + 'aa'.repeat(20), status: 'grace' });
    const x = makeSub(a.id, buyer.address, { wallet: '0x' + 'bb'.repeat(20), days: -3 });

    const traded = idsOf(subcheck('-fanout', a.id));
    check('neither a grace nor an expired subscription is traded for',
      !traded.includes(g) && !traded.includes(x), JSON.stringify(traded));

    const gb = await req(`${AGENT}/v1/subscriptions/${g}/book`, { headers: bearer(buyer.tk) });
    check('a GRACE subscriber can still read their book',
      ok2xx(gb.status) && gb.body && gb.body.trading === false,
      `status ${gb.status}, trading=${gb.body && gb.body.trading}: grace must keep the record ` +
      'readable while it stops the spending');

    const xb = await req(`${AGENT}/v1/subscriptions/${x}/book`, { headers: bearer(buyer.tk) });
    check('an EXPIRED subscriber can still read their book',
      ok2xx(xb.status) && xb.body && xb.body.trading === false, `status ${xb.status}`);
    check('and is told the positions stay where they are',
      typeof xb.body?.note === 'string' && /stays where it is|positions are yours/i.test(xb.body.note),
      `the note was: ${JSON.stringify(xb.body?.note)}. An expired subscription stops the agent ` +
      'trading; it does not close positions, and a buyer must be told that rather than left to ' +
      'discover it');
    check('the book states what is watching, even when nothing is',
      xb.body && xb.body.protection && Array.isArray(xb.body.protection.armed)
        && Array.isArray(xb.body.protection.unprotected),
      'protection was omitted. An absent field is not the same as an empty one: the first means ' +
      'nobody looked');
  }

  // =====================================================================
  console.log('\n=== 4. A buyer can reach their own wallet and nobody else\'s ===');
  {
    const a = await freshAgent('own');
    const buyer = await freshWallet();
    const stranger = await freshWallet();
    const s1 = makeSub(a.id, buyer.address, {});
    const s2 = makeSub(a.id, buyer.address, {});

    const w1 = await req(`${AGENT}/v1/subscriptions/${s1}/wallet`, { method: 'POST', headers: bearer(buyer.tk) });
    check('a subscriber can derive their trading wallet',
      ok2xx(w1.status) && /^0x[0-9a-fA-F]{40}$/.test(w1.body?.wallet_address || ''),
      `status ${w1.status}: ${JSON.stringify(w1.body).slice(0, 200)}`);

    const again = await req(`${AGENT}/v1/subscriptions/${s1}/wallet`, { method: 'POST', headers: bearer(buyer.tk) });
    check('asking twice returns the same address',
      /^0x[0-9a-fA-F]{40}$/.test(again.body?.wallet_address || '')
      && again.body?.wallet_address === w1.body?.wallet_address,
      `${w1.body?.wallet_address} then ${again.body?.wallet_address}: the signer derives from the ` +
      'subscription id, so there is no second wallet to end up with. The address pattern is ' +
      'asserted as well as the equality, because two absent addresses are equal to each other and ' +
      'this check passed on a pair of 404s');

    // THE REQUEST CANNOT NAME A RECIPIENT. Not because the field is rejected —
    // because there is no field. The signer COMPUTES the address from the id.
    const w2 = await req(`${AGENT}/v1/subscriptions/${s2}/wallet`, {
      method: 'POST', headers: bearer(buyer.tk),
      body: JSON.stringify({ walletAddress: stranger.address, wallet_address: stranger.address }),
    });
    check('a buyer cannot choose which wallet the agent executes into',
      ok2xx(w2.status)
      && w2.body?.wallet_address?.toLowerCase() !== stranger.address.toLowerCase()
      && w2.body?.wallet_address?.toLowerCase() !== w1.body?.wallet_address?.toLowerCase(),
      `asked for ${stranger.address} and got ${w2.body?.wallet_address}`);

    for (const [what, path, method] of [
      ['book', `${AGENT}/v1/subscriptions/${s1}/book`, 'GET'],
      ['wallet', `${AGENT}/v1/subscriptions/${s1}/wallet`, 'POST'],
      ['key export', `${AGENT}/v1/subscriptions/${s1}/wallet/export`, 'POST'],
      ['limits', `${AGENT}/v1/subscriptions/${s1}`, 'PATCH'],
    ]) {
      const r = await req(path, {
        method, headers: bearer(stranger.tk),
        body: method === 'GET' ? undefined : JSON.stringify({ tradingPaused: true }),
      });
      check(`a stranger cannot reach somebody else's ${what}`,
        r.status === 403 && r.body?.code === 'not_your_subscription',
        `status ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    }

    const ex = await req(`${AGENT}/v1/subscriptions/${s1}/wallet/export`, { method: 'POST', headers: bearer(buyer.tk) });
    check('the owner can take the key, and is told what that means',
      ok2xx(ex.status) && /^0x[0-9a-f]{64}$/i.test(ex.body?.private_key || '')
      && /after the subscription ends/i.test(ex.body?.warning || ''),
      `status ${ex.status}: ${JSON.stringify(ex.body).slice(0, 160)}`);
  }

  // =====================================================================
  console.log('\n=== 5. Protective levels watch the wallet they belong to ===');
  {
    const a = await freshAgent('guards');
    const buyer = await freshWallet();
    const s = makeSub(a.id, buyer.address, {
      wallet: '0x' + 'cc'.repeat(20), risk: '{"cost_budget_monthly_pct": 7}',
    });
    psql(`INSERT INTO agent_wallets (agent_id, address, provenance, key_custody)
          VALUES ('${a.id}', '0x${'de'.repeat(20)}', 'derived', 'shared')`);

    const armed = (subId, sl, note) => psql(
      `INSERT INTO position_guards (agent_id, subscription_id, symbol, entry_price, entry_qty,
                                    stop_loss, stop_loss_pct, status, note)
       VALUES ('${a.id}', ${subId ? `'${subId}'` : 'NULL'}, 'MSFT', 100, 1, ${sl}, 0.05, 'armed', '${note}')
       RETURNING id`);

    const creatorGuard = armed(null, 95, MARK);
    const buyerGuard = armed(s, 47.5, MARK);
    check('a creator\'s guard and a subscriber\'s coexist on the same symbol',
      psql(`SELECT count(*) FROM position_guards WHERE agent_id = '${a.id}' AND status = 'armed'`) === '2',
      'one of them was stood down. Before migration 0039 the unique index was (agent_id, symbol), ' +
      'so one customer buying the same stock disarmed the owner\'s stop loss');

    let second = null;
    try {
      armed(s, 48, MARK + ' duplicate');
      second = 'accepted';
    } catch (e) { second = String(e.stderr || e.message); }
    check('but one subscription cannot have two armed guards on one symbol',
      /uq_position_guards_armed_subscription/.test(second),
      `the duplicate was ${second}: two stop losses over one position is two transactions from ` +
      'one intent');

    const cg = subcheck('-guard', String(creatorGuard));
    const bg = subcheck('-guard', String(buyerGuard));
    check('the creator\'s guard resolves to the creator\'s wallet',
      cg.stands_down === false && cg.wallet?.toLowerCase() === `0x${'de'.repeat(20)}`,
      JSON.stringify(cg));
    check('the subscriber\'s guard resolves to the SUBSCRIBER\'s wallet',
      bg.stands_down === false && bg.wallet?.toLowerCase() === `0x${'cc'.repeat(20)}`,
      `${JSON.stringify(bg)} — a level priced against the wrong balance is a stop loss watching a ` +
      'position it does not protect');
    check('and signs as the subscription, so the signature cap is that buyer\'s',
      bg.signer_id === s, `signer_id ${bg.signer_id}, want ${s}`);
    check('and is metered against the BUYER\'s budget, not the creator\'s',
      bg.cost_budget_monthly_pct === 7, `budget ${bg.cost_budget_monthly_pct}, want 7`);

    // PAUSED IS NOT ENDED. The level stays armed and waits.
    psql(`UPDATE subscriptions SET trading_paused = true WHERE id = '${s}'`);
    const paused = subcheck('-guard', String(buyerGuard));
    check('a paused subscription stands the level DOWN without taking it down',
      paused.stands_down === true && paused.permanent === false && /paused/i.test(paused.reason),
      JSON.stringify(paused));

    // ENDED IS PERMANENT. The level comes down and the absence becomes a fact.
    psql(`UPDATE subscriptions SET trading_paused = false, expires_at = now() - interval '1 day' WHERE id = '${s}'`);
    const ended = subcheck('-guard', String(buyerGuard));
    check('an expired subscription stands the level down PERMANENTLY',
      ended.stands_down === true && ended.permanent === true && /expired/i.test(ended.reason),
      `${JSON.stringify(ended)} — an agent nobody is paying must not keep signing, and a level ` +
      'that will never fire must not keep looking like protection');

    // The creator's own guard is untouched by any of it.
    const still = subcheck('-guard', String(creatorGuard));
    check('none of that touched the creator\'s guard',
      still.stands_down === false, JSON.stringify(still));
  }

  // =====================================================================
  console.log('\n=== 6. A level the pool refused is visible to the buyer who lost it ===');
  {
    const a = await freshAgent('refusal');
    const buyer = await freshWallet();
    const s = makeSub(a.id, buyer.address, { wallet: '0x' + 'ee'.repeat(20) });
    psql(
      `INSERT INTO position_guards (agent_id, subscription_id, symbol, entry_price, entry_qty,
                                    status, min_acceptable_pct, note)
       VALUES ('${a.id}', '${s}', 'TSLA', 250, 0.5, 'refused', 0.006,
               'stop loss of 0.300% refused: this pool charges 0.30% each way')`);

    const b = await req(`${AGENT}/v1/subscriptions/${s}/book`, { headers: bearer(buyer.tk) });
    const un = b.body?.protection?.unprotected || [];
    check('the refusal reaches the buyer\'s book',
      un.length === 1 && un[0].symbol === 'TSLA',
      `protection.unprotected was ${JSON.stringify(un)}. A buyer who asked for a stop and did not ` +
      'get one must be told; the choice has to be taken, not discovered');
    check('and it names the smallest level that pool would have accepted',
      un[0]?.min_acceptable_pct === 0.006
      && /0\.600%/.test(b.body?.protection?.note || ''),
      `note: ${JSON.stringify(b.body?.protection?.note)}. Naming what to ask for instead is the ` +
      'difference between a refusal you can act on and one you can only read');
    check('an unprotected position is not reported as protected',
      (b.body?.protection?.armed || []).length === 0
      && /OPEN AND UNPROTECTED/.test(b.body?.protection?.note || ''),
      JSON.stringify(b.body?.protection));
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  if (fail > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    exitCode = 1;
  } else {
    console.log('subscription-verify: one mandate, several wallets, and each one on its own.');
  }
} catch (e) {
  console.log(`\nsubscription-verify DIED: ${e && e.message}`);
  console.log((e && e.stack) || '');
  exitCode = 1;
} finally {
  await stop();
  // ORDER MATTERS: guards and executions reference subscriptions, which
  // reference agents.
  for (const id of subs) {
    try { psql(`DELETE FROM position_guards WHERE subscription_id = '${id}'`); } catch {}
    try { psql(`DELETE FROM executions WHERE subscription_id = '${id}'`); } catch {}
    try { psql(`DELETE FROM subscription_snapshots WHERE subscription_id = '${id}'`); } catch {}
    try { psql(`DELETE FROM subscriptions WHERE id = '${id}'`); } catch {}
  }
  for (const id of agents) {
    try { psql(`DELETE FROM position_guards WHERE agent_id = '${id}'`); } catch {}
    try { psql(`DELETE FROM executions WHERE agent_id = '${id}'`); } catch {}
    try { psql(`DELETE FROM decisions WHERE agent_id = '${id}'`); } catch {}
    try { psql(`DELETE FROM agent_wallets WHERE agent_id = '${id}'`); } catch {}
    try { psql(`DELETE FROM agent_execution_leases WHERE agent_id = '${id}'`); } catch {}
    try { psql(`DELETE FROM portfolio_snapshots WHERE portfolio_id IN (SELECT id FROM portfolios WHERE agent_id = '${id}')`); } catch {}
    try { psql(`DELETE FROM portfolios WHERE agent_id = '${id}'`); } catch {}
    try { psql(`DELETE FROM agents WHERE id = '${id}'`); } catch {}
  }
  for (const h of handles) { try { psql(`DELETE FROM creators WHERE handle = '${h}'`); } catch {} }
  try { psql(`DELETE FROM position_guards WHERE note LIKE '${MARK}%'`); } catch {}
  try { execFileSync('rm', ['-f', ENGINE_BIN, SUBCHECK]); } catch {}
  console.log('subscription-verify: fixtures removed');
}
process.exit(exitCode);
