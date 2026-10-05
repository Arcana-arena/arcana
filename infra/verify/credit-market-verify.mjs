/**
 * credit-market-verify.mjs — Agent Credit Markets, first step, proved at its
 * edges (architecture.md §19, docs/credit-market.md).
 *
 * The market holds no money, so what there is to prove is that it says so and
 * that what it does record cannot be made to say more than happened:
 *
 *   the list         an agent with no capital record is not in it; one with a
 *                    record is, and is qualified only when rated at tier 1+
 *   the limit        beside each agent is the one the allowlist's tier table
 *                    gives, computed here independently from the same file
 *   an indication    needs a session and no creator profile, is refused on
 *                    one's own agent and outside its bounds, and is counted
 *                    once however often it is changed
 *   the database     refuses a second standing indication, and a row that
 *                    contradicts itself
 *   the public list  does not count what a verification run wrote
 *   nothing moved    no capital action exists for the agent afterwards
 *
 * Fixture agents carry provenance='verification' and have no wallet. Their
 * reputation rows are written directly: the guard only rebuilds agents that
 * have owed something on chain, so it never touches them.
 *
 *   node infra/verify/credit-market-verify.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { suite } from './lib/sections.mjs';
import { signIn, SIWE_DOMAIN, SIWE_URI, VERIFICATION_HEADER } from './lib/rate-aware.mjs';

const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const DB = process.env.DATABASE_URL || 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';
const REPO = process.env.REPO || '/home/ubuntu/arcana';
const { check, section, report } = suite('credit-market-verify');

const sql = (q) => execFileSync('psql', [DB, '-At', '-q', '-c', q], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sqlFails = (q) => {
  try { execFileSync('psql', [DB, '-At', '-q', '-v', 'ON_ERROR_STOP=1', '-c', q], { stdio: ['ignore', 'pipe', 'pipe'] }); return null; }
  catch (e) { return `${e.stderr || ''}${e.stdout || ''}`.trim(); }
};

const api = async (token, path, init = {}) => {
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
  try { body = t ? JSON.parse(t) : null; } catch { /* non-JSON is the caller's problem */ }
  return { status: r.status, body };
};
const codeOf = (r) => r.body?.code ?? r.body?.error?.code ?? r.body?.message?.code ?? '';

// THE EXPECTED LIMIT, FROM THE ALLOWLIST AND NOT FROM THE SERVICE.
const lending = JSON.parse(readFileSync(`${REPO}/services/signer/allowlist/robinhood-mainnet.json`, 'utf8')).lending;
const CEILING = Number(lending.limits.max_debt_per_agent_usdg);
const CREDIT_ON = lending.credit?.enabled === true;
const TIERS = (lending.credit?.tiers ?? []).map((t) => ({ tier: t.tier, max: Number(t.max_debt_usdg) }));
const expectedLimit = (tier) => {
  if (!CREDIT_ON || TIERS.length === 0) return CEILING;
  const own = TIERS.find((t) => t.tier === tier)?.max ?? 0;
  const base = TIERS.find((t) => t.tier === 0)?.max ?? 0;
  return Math.min(Math.max(own, base), CEILING);
};

const TAG = `verify_cmkt_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
// Indications go with their agent (ON DELETE CASCADE), so removing the fixture
// creators and agents removes everything this suite wrote.
function purge(like) {
  try {
    sql(`DELETE FROM agents WHERE creator_id IN (SELECT id FROM creators WHERE handle LIKE '${like}');
         DELETE FROM creators WHERE handle LIKE '${like}';`);
  } catch (e) { console.log('  cleanup warning: ' + e.message); }
}
purge('verify_cmkt_%');
process.on('exit', () => purge(`${TAG}%`));
process.on('SIGINT', () => { purge(`${TAG}%`); process.exit(130); });

const session = async () => {
  const acct = privateKeyToAccount(generatePrivateKey());
  const s = await signIn(AGENT, acct, { chainId: 4663, domain: SIWE_DOMAIN, uri: SIWE_URI });
  if (s.status !== 200 || !s.body?.access_token) throw new Error(`sign-in failed: ${s.status}`);
  return { token: s.body.access_token, wallet: acct.address.toLowerCase() };
};

const repRow = (id, cols) => `INSERT INTO capital_reputation
  (agent_id, rated, unrated_why, score, components, inputs, earned_tier, tier, held_because, limit_usdg)
  VALUES ('${id}', ${cols})`;
const J = `'{}'::jsonb, '{}'::jsonb`;

try {
  // The owner has a creator profile and an agent. The provider has neither:
  // a capital provider is a wallet.
  const owner = await session();
  const c = await api(owner.token, '/v1/creators', { method: 'POST', body: { handle: TAG }, headers: VERIFICATION_HEADER });
  if (!c.body?.id) throw new Error(`creator not made: ${c.status} ${JSON.stringify(c.body)}`);
  const a = await api(owner.token, '/v1/agents', {
    method: 'POST', headers: VERIFICATION_HEADER,
    body: { name: `${TAG}_agent`, strategyType: 'momentum', assetUniverse: 'us_equities', visibility: 'public',
            riskProfile: JSON.stringify({ cash_floor_pct: 0.05 }) },
  });
  const id = a.body?.id;
  if (!id) throw new Error(`fixture agent not made: ${a.status} ${JSON.stringify(a.body)}`);
  // A draft is not listed whatever its record; the fixture is made active the
  // way credit-verify's rows are made, without a seat or a wallet.
  sql(`UPDATE agents SET status = 'active' WHERE id = '${id}'`);
  const provider = await session();

  const market = (prov = 'verification') => api(null, `/v1/credit-market?provenance=${prov}`);
  const row = async () => (await market()).body?.agents?.find((x) => x.agent_id === id);
  const put = (who, body, agentId = id) =>
    api(who.token, `/v1/credit-market/agents/${agentId}/indication`, { method: 'PUT', body, headers: VERIFICATION_HEADER });
  const del = (who) => api(who.token, `/v1/credit-market/agents/${id}/indication`, { method: 'DELETE' });
  const openRows = () => Number(sql(`SELECT count(*) FROM credit_market_indications WHERE agent_id = '${id}' AND ended_at IS NULL`));

  const liveBefore = (await market('live')).body?.totals;

  // =====================================================================
  await section('1. An agent with no capital record is not in the market', async () => {
    const m = await market();
    check('the market answers and says it is not funded', m.status === 200 && m.body?.funded === false, `${m.status} ${m.body?.funded}`);
    check('the agent is not listed', !(await row()), 'it is listed');
    const r = await put(provider, { amount_usdg: 100 });
    check('and an indication on it is refused -> agent_not_listed', r.status === 400 && codeOf(r) === 'agent_not_listed',
      `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    check('whether tiers are in force is reported exactly as the allowlist sets it', m.body?.credit_enabled === CREDIT_ON,
      `${m.body?.credit_enabled} vs file ${CREDIT_ON}`);
    check('the ceiling is the signer\'s per-agent cap', m.body?.ceiling_usdg === CEILING, `${m.body?.ceiling_usdg}`);
    const bad = await api(null, '/v1/credit-market?provenance=everything');
    check('an unknown provenance is refused, not read as live', bad.status === 400 && codeOf(bad) === 'invalid_provenance', `${bad.status}`);
  });

  // =====================================================================
  await section('2. An unrated agent is listed as building a record, not as qualified', async () => {
    sql(repRow(id, `false, 'less than 30 days since its first borrow', NULL, ${J}, 0, 0, NULL, 250`));
    const r = await row();
    check('it is listed', !!r, 'not listed');
    check('unrated, with a null score', r?.capital?.status === 'unrated' && r?.capital?.score === null, JSON.stringify(r?.capital));
    check('not qualified', r?.qualified === false, `${r?.qualified}`);
    check('and it says why, in the guard\'s words', /less than 30 days/.test(r?.not_qualified_why ?? ''), `${r?.not_qualified_why}`);
    check(`its limit is tier 0's (${expectedLimit(0)} USDG)`, r?.capital?.limit_usdg === expectedLimit(0), `${r?.capital?.limit_usdg}`);
    check('no interest is recorded in it', r?.interest?.providers === 0 && r?.interest?.indicated_usdg === 0, JSON.stringify(r?.interest));
  });

  // =====================================================================
  await section('3. An indication needs a session, no profile, and stays inside its bounds', async () => {
    const anon = await api(null, `/v1/credit-market/agents/${id}/indication`, { method: 'PUT', body: { amount_usdg: 100 } });
    check('without a session -> 401', anon.status === 401, `${anon.status}`);
    const anonMine = await api(null, '/v1/credit-market/indications/mine');
    check('and one\'s own list is not readable without one', anonMine.status === 401, `${anonMine.status}`);

    const own = await put(owner, { amount_usdg: 100 });
    check('on one\'s own agent -> 403 own_agent', own.status === 403 && codeOf(own) === 'own_agent', `${own.status} ${codeOf(own)}`);
    const cases = [
      ['an amount of zero', { amount_usdg: 0 }, 'amount_out_of_range'],
      ['a negative amount', { amount_usdg: -5 }, 'amount_out_of_range'],
      ['an amount over the most one indication may be', { amount_usdg: 1000001 }, 'amount_out_of_range'],
      ['a rate of zero', { amount_usdg: 100, rate_bps: 0 }, 'rate_out_of_range'],
      ['a rate over 100% a year', { amount_usdg: 100, rate_bps: 10001 }, 'rate_out_of_range'],
    ];
    for (const [what, body, code] of cases) {
      const r = await put(provider, body);
      check(`${what} -> ${code}`, r.status === 400 && codeOf(r) === code, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    }
    check('and after every refusal nothing was stored', openRows() === 0, `${openRows()} row(s)`);

    const ok = await put(provider, { amount_usdg: 500, rate_bps: 900 });
    check('a wallet with no creator profile can record one', ok.status === 200 && ok.body?.open?.length === 1,
      `${ok.status} ${JSON.stringify(ok.body).slice(0, 200)}`);
    const i = ok.body?.open?.[0];
    check('it is stored as given', i?.amount_usdg === 500 && i?.rate_bps === 900 && i?.agent_id === id, JSON.stringify(i));
    check('with the agent\'s standing at that moment: unrated, tier 0',
      i?.agent_at?.status === 'unrated' && i?.agent_at?.score === null && i?.agent_at?.tier === 0, JSON.stringify(i?.agent_at));
    check('the provider\'s list says none of it is funded', ok.body?.funded === false && ok.body?.open_total_usdg === 500, JSON.stringify(ok.body).slice(0, 120));
    const r = await row();
    check('the market shows one provider and 500 USDG', r?.interest?.providers === 1 && r?.interest?.indicated_usdg === 500, JSON.stringify(r?.interest));
    check('and the rate asked', r?.interest?.rate_bps_low === 900 && r?.interest?.rate_bps_high === 900, JSON.stringify(r?.interest));
    check('no wallet address is published with it', !JSON.stringify(r).toLowerCase().includes(provider.wallet), 'the provider wallet is in the public row');
  });

  // =====================================================================
  await section('4. A rated agent at tier 2 is qualified, at the allowlist\'s limit', async () => {
    sql(repRow(id, `true, NULL, 72,
      '{"exposure": 30.1, "margin": 25.8, "self_sufficiency": 13.6, "cycles_closed": 2.5}'::jsonb,
      '{"figures": {"usdg_days": 9000, "share_under_floor": 0.02}, "scored_days": 120}'::jsonb, 2, 2, NULL, 0`));
    const r = await row();
    check('it is rated 72 at tier 2', r?.capital?.status === 'rated' && r?.capital?.score === 72 && r?.capital?.tier === 2, JSON.stringify(r?.capital));
    check(`its limit is ${expectedLimit(2)} USDG, from the allowlist and not from the stored row`,
      r?.capital?.limit_usdg === expectedLimit(2), `${r?.capital?.limit_usdg}`);
    check('it is qualified exactly when tiers are in force', r?.qualified === CREDIT_ON, `${r?.qualified} vs credit ${CREDIT_ON}`);
    check('the share of debt-time under the floor comes from the reputation\'s own figures', r?.risk?.share_under_floor === 0.02, `${r?.risk?.share_under_floor}`);
    const m = await market();
    check('the totals count it', m.body?.totals?.qualified >= (CREDIT_ON ? 1 : 0) && m.body?.totals?.agents >= 1, JSON.stringify(m.body?.totals));
  });

  // =====================================================================
  await section('5. Changing an indication replaces it; it is never counted twice', async () => {
    const ch = await put(provider, { amount_usdg: 800 });
    check('the change is accepted', ch.status === 200 && ch.body?.open?.length === 1 && ch.body.open[0].amount_usdg === 800,
      `${ch.status} ${JSON.stringify(ch.body?.open)}`);
    check('with no rate named this time', ch.body?.open?.[0]?.rate_bps === null, `${ch.body?.open?.[0]?.rate_bps}`);
    check('and the agent\'s standing as it is now: rated 72, tier 2',
      ch.body?.open?.[0]?.agent_at?.status === 'rated' && ch.body.open[0].agent_at.score === 72 && ch.body.open[0].agent_at.tier === 2,
      JSON.stringify(ch.body?.open?.[0]?.agent_at));
    check('the earlier one is kept, ended as replaced',
      ch.body?.ended?.length === 1 && ch.body.ended[0].ended_how === 'replaced' && ch.body.ended[0].amount_usdg === 500,
      JSON.stringify(ch.body?.ended));
    const r = await row();
    check('the market shows 800 USDG from one provider, not 1,300 from two',
      r?.interest?.providers === 1 && r?.interest?.indicated_usdg === 800, JSON.stringify(r?.interest));
    check('and no rate, since none is named', r?.interest?.rate_bps_low === null, JSON.stringify(r?.interest));
  });

  // =====================================================================
  await section('6. The database refuses an indication that contradicts itself', async () => {
    const ins = (cols, vals) => sqlFails(`INSERT INTO credit_market_indications
      (agent_id, provider_wallet, amount_usdg, agent_status_at, agent_score_at, agent_tier_at${cols})
      VALUES ('${id}', ${vals})`);
    const other = '0x00000000000000000000000000000000000000aa';
    check('a second standing indication from the same wallet',
      /credit_market_indications_open_uq/.test(ins('', `'${provider.wallet}', 10, 'rated', 72, 2`) ?? ''), 'it was stored');
    check('a wallet that is not lowercase hex',
      /credit_market_indications_wallet_ck/.test(ins('', `'0x00000000000000000000000000000000000000AA', 10, 'rated', 72, 2`) ?? ''), 'it was stored');
    check('an amount of zero', /credit_market_indications_amount_ck/.test(ins('', `'${other}', 0, 'rated', 72, 2`) ?? ''), 'it was stored');
    check('a rate of zero', /credit_market_indications_rate_ck/.test(ins(', rate_bps', `'${other}', 10, 'rated', 72, 2, 0`) ?? ''), 'it was stored');
    check('rated with no score', /credit_market_indications_score_ck/.test(ins('', `'${other}', 10, 'rated', NULL, 2`) ?? ''), 'it was stored');
    check('a score of 101', /credit_market_indications_score_ck/.test(ins('', `'${other}', 10, 'rated', 101, 2`) ?? ''), 'it was stored');
    check('unrated with a score',/credit_market_indications_score_ck/.test(ins('', `'${other}', 10, 'unrated', 50, 0`) ?? ''), 'it was stored');
    check('ended without saying how',
      /credit_market_indications_ended_ck/.test(ins(', ended_at', `'${other}', 10, 'rated', 72, 2, now()`) ?? ''), 'it was stored');
    check('a way of ending that is not one of the two',
      /credit_market_indications_how_ck/.test(ins(', ended_at, ended_how', `'${other}', 10, 'rated', 72, 2, now(), 'funded'`) ?? ''), 'it was stored');
    check('and after all of that one indication stands', openRows() === 1, `${openRows()}`);
  });

  // =====================================================================
  await section('7. A reputation nobody has re-checked does not qualify', async () => {
    sql(`UPDATE capital_reputation SET confirmed_at = now() - interval '49 hours' WHERE agent_id = '${id}'`);
    const r = await row();
    check('it is reported stale, at tier 0 with its earned tier still shown',
      r?.capital?.stale === true && r?.capital?.tier === 0 && r?.capital?.earned_tier === 2, JSON.stringify(r?.capital));
    check('it is not qualified, and says the reputation was not re-checked',
      r?.qualified === false && /not been re-checked/.test(r?.not_qualified_why ?? ''), `${r?.qualified} ${r?.not_qualified_why}`);
    check(`its limit is tier 0's (${expectedLimit(0)} USDG)`, r?.capital?.limit_usdg === expectedLimit(0), `${r?.capital?.limit_usdg}`);
    sql(`UPDATE capital_reputation SET confirmed_at = now() WHERE agent_id = '${id}'`);
  });

  // =====================================================================
  await section('8. The public market does not count what a verification run wrote', async () => {
    const live = await market('live');
    check('the fixture agent is not in the public list', !live.body?.agents?.some((x) => x.agent_id === id), 'it is listed publicly');
    check('and the public totals did not move',
      live.body?.totals?.indicated_usdg === liveBefore?.indicated_usdg && live.body?.totals?.providers === liveBefore?.providers &&
      live.body?.totals?.indications === liveBefore?.indications,
      `${JSON.stringify(liveBefore)} -> ${JSON.stringify(live.body?.totals)}`);
    const def = await api(null, '/v1/credit-market');
    check('the default read is the public one', !def.body?.agents?.some((x) => x.agent_id === id), 'the default lists fixtures');
  });

  // =====================================================================
  await section('9. Withdrawing ends it, and nothing was ever moved', async () => {
    const w = await del(provider);
    check('the withdrawal is accepted', w.status === 200 && w.body?.open?.length === 0, `${w.status} ${JSON.stringify(w.body?.open)}`);
    check('the row is kept, ended as withdrawn',
      w.body?.ended?.some((e) => e.ended_how === 'withdrawn' && e.amount_usdg === 800), JSON.stringify(w.body?.ended));
    const r = await row();
    check('the market shows no interest again', r?.interest?.providers === 0 && r?.interest?.indicated_usdg === 0, JSON.stringify(r?.interest));
    const again = await del(provider);
    check('withdrawing what is not there -> no_indication', again.status === 400 && codeOf(again) === 'no_indication', `${again.status} ${codeOf(again)}`);
    check('two rows are on the record and none stands',
      sql(`SELECT count(*) FROM credit_market_indications WHERE agent_id = '${id}'`) === '2' && openRows() === 0, 'the record is not two ended rows');
    // The whole suite recorded interest in this agent. None of it may have
    // reached the engine: the agent has no capital action of any kind.
    check('no capital action exists for the agent', sql(`SELECT count(*) FROM capital_actions WHERE agent_id = '${id}'`) === '0', 'a capital action was written');
    check('and its mandate limits are untouched by the interest recorded',
      (await api(owner.token, `/v1/agents/${id}/capital/mandate`)).body?.limits?.agent_max_debt_usdg === expectedLimit(2), 'the limit moved');
  });
} catch (e) {
  check('the suite ran to completion', false, e?.message ?? String(e));
}

process.exit(report());
