/**
 * capital-verify.mjs — ARCANA CAPITAL's mandate, proved by refusal.
 *
 * architecture.md §17.7 names the phrasing that matters: this project shipped a
 * nonce gate that never rejected a single replay, because what was tested was
 * its existence rather than its refusal. So every rule here is exercised by
 * breaking it and reading the refusal back, in each layer that enforces it:
 *
 *   the API          refuses with a code naming the rule, and a sentence
 *   the database     refuses the same row written directly, past the API
 *   ownership        a second wallet can neither read nor write the mandate
 *   privacy          a private agent's capital log withholds its reasons and
 *                    evidence while what it DID stays public
 *
 * The engine's half — capital.Validate refusing a plausible borrow that
 * breaches the mandate — is proved by the Go tests in
 * services/decision-engine/internal/capital, which run without a chain.
 *
 * Fixture agents carry provenance='verification' and have no wallet, so
 * nothing here can sign, spend or move a position.
 *
 *   node infra/verify/capital-verify.mjs
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { suite } from './lib/sections.mjs';
import { signIn, SIWE_DOMAIN, SIWE_URI, VERIFICATION_HEADER } from './lib/rate-aware.mjs';

const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const DB = process.env.DATABASE_URL || 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';
const { check, section, report } = suite('capital-verify');

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

const TAG = `verify_capital_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
function purge(like) {
  try {
    sql(`DELETE FROM agents WHERE creator_id IN (SELECT id FROM creators WHERE handle LIKE '${like}');
         DELETE FROM creators WHERE handle LIKE '${like}';`);
  } catch (e) { console.log('  cleanup warning: ' + e.message); }
}
purge('verify_capital_%');
process.on('exit', () => purge(`${TAG}%`));
process.on('SIGINT', () => { purge(`${TAG}%`); process.exit(130); });

const signInAs = async (handle) => {
  const acct = privateKeyToAccount(generatePrivateKey());
  const s = await signIn(AGENT, acct, { chainId: 4663, domain: SIWE_DOMAIN, uri: SIWE_URI });
  if (s.status !== 200 || !s.body?.access_token) throw new Error(`sign-in failed: ${s.status}`);
  const token = s.body.access_token;
  const c = await api(token, '/v1/creators', { method: 'POST', body: { handle }, headers: VERIFICATION_HEADER });
  if (!c.body?.id) throw new Error(`creator not made: ${c.status} ${JSON.stringify(c.body)}`);
  return token;
};

const VALID = { min_health_factor: 2, max_borrow_rate_bps: 800, liquidity_trigger_usdg: 50, max_borrow_usdg: 150, never_sell: ['NVDA'] };

try {
  const owner = await signInAs(TAG);
  const stranger = await signInAs(`${TAG}_x`);
  const a = await api(owner, '/v1/agents', {
    method: 'POST', headers: VERIFICATION_HEADER,
    body: { name: `${TAG}_agent`, strategyType: 'momentum', assetUniverse: 'us_equities', visibility: 'public',
            riskProfile: JSON.stringify({ cash_floor_pct: 0.05 }) },
  });
  const id = a.body?.id;
  if (!id) throw new Error(`fixture agent not made: ${a.status} ${JSON.stringify(a.body)}`);
  const put = (body, token = owner) => api(token, `/v1/agents/${id}/capital/mandate`, { method: 'PUT', body });

  // =====================================================================
  await section('1. What a mandate may be comes from the signer\'s allowlist', async () => {
    const g = await api(owner, `/v1/agents/${id}/capital/mandate`);
    check('the owner can read it', g.status === 200, `status ${g.status}`);
    check('there is none yet', g.body?.mandate === null, JSON.stringify(g.body?.mandate));
    const lim = g.body?.limits ?? {};
    check('the market is the one allowlisted', /^0x66306c08/.test(lim.market?.id ?? ''), JSON.stringify(lim.market));
    check('the platform cap is the signer\'s 250 USDG', lim.platform_max_debt_usdg === 250, `${lim.platform_max_debt_usdg}`);
    check('the floor offered is 1.5', lim.min_health_factor === 1.5, `${lim.min_health_factor}`);
    check('lending is reported as it ships: disabled', lim.lending_enabled === false, `${lim.lending_enabled}`);
  });

  // =====================================================================
  await section('2. Each rule refuses, and says which', async () => {
    const cases = [
      ['a floor at liquidation, 1.0', { ...VALID, min_health_factor: 1.0 }, 'health_floor_too_low'],
      ['a floor just under the margin, 1.49', { ...VALID, min_health_factor: 1.49 }, 'health_floor_too_low'],
      ['a borrow cap over the platform\'s', { ...VALID, max_borrow_usdg: 251 }, 'borrow_cap_over_platform'],
      ['a borrow cap of zero', { ...VALID, max_borrow_usdg: 0, liquidity_trigger_usdg: 0 }, 'borrow_cap_not_positive'],
      ['a trigger above the cap', { ...VALID, liquidity_trigger_usdg: 151 }, 'trigger_out_of_range'],
      ['a never-sell symbol nobody can hold', { ...VALID, never_sell: ['NVDA', 'ZZZZ'] }, 'never_sell_not_holdable'],
    ];
    for (const [name, body, code] of cases) {
      const r = await put(body);
      check(`${name} -> ${code}`, r.status === 400 && codeOf(r) === code, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    }
    const bad = await put({ ...VALID, max_borrow_rate_bps: 0 });
    check('a rate of 0 bps is refused by the shape check', bad.status === 400, `${bad.status}`);
    const none = await api(owner, `/v1/agents/${id}/capital/mandate`);
    check('and after all of that, nothing was saved', none.body?.mandate === null, JSON.stringify(none.body?.mandate));
  });

  // =====================================================================
  await section('3. The database refuses the same rows written past the API', async () => {
    const ins = (cols) => sqlFails(
      `INSERT INTO capital_mandates (agent_id, market_id, min_health_factor, max_borrow_rate_bps, liquidity_trigger_usdg, max_borrow_usdg)
       VALUES ('${id}', '0x00', ${cols})`);
    check('a floor of 1.2', /capital_mandates_hf_ck/.test(ins('1.2, 800, 50, 150') ?? ''), 'it was stored');
    check('a rate of 0', /capital_mandates_rate_ck/.test(ins('2, 0, 50, 150') ?? ''), 'it was stored');
    check('a cap of 0', /capital_mandates_borrow_ck/.test(ins('2, 800, 0, 0') ?? ''), 'it was stored');
    check('a trigger above the cap', /capital_mandates_trigger_ck/.test(ins('2, 800, 200, 150') ?? ''), 'it was stored');
    const refusal = sqlFails(
      `INSERT INTO capital_actions (agent_id, market_id, decider, kind, amount, reason_code, why, evidence, status)
       VALUES ('${id}', '0x00', 'deterministic', 'borrow', 1, 'x', 'x', '{}'::jsonb, 'refused')`);
    check('a refused capital action with no refusal code', /capital_actions_refusal_ck/.test(refusal ?? ''), 'it was stored');
  });

  // =====================================================================
  await section('4. A valid mandate saves as a draft, and activation checks the agent', async () => {
    const r = await put(VALID);
    check('it saves', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    check('as a draft', r.body?.mandate?.status === 'draft', `${r.body?.mandate?.status}`);
    check('never-sell is stored upper-case and de-duplicated',
      JSON.stringify(r.body?.mandate?.never_sell) === '["NVDA"]', JSON.stringify(r.body?.mandate?.never_sell));
    const act = await api(owner, `/v1/agents/${id}/capital/mandate/activate`, { method: 'POST', body: {} });
    check('a draft agent cannot run one -> agent_not_active', codeOf(act) === 'agent_not_active',
      `${act.status} ${JSON.stringify(act.body).slice(0, 200)}`);
    await api(owner, `/v1/agents/${id}/activate`, { method: 'POST' });
    const act2 = await api(owner, `/v1/agents/${id}/capital/mandate/activate`, { method: 'POST', body: {} });
    check('an active agent with no wallet cannot either -> no_wallet', codeOf(act2) === 'no_wallet',
      `${act2.status} ${JSON.stringify(act2.body).slice(0, 200)}`);
    const still = await api(owner, `/v1/agents/${id}/capital/mandate`);
    check('so it is still a draft', still.body?.mandate?.status === 'draft', `${still.body?.mandate?.status}`);
  });

  // =====================================================================
  await section('5. Somebody else\'s mandate is not theirs to read or write', async () => {
    const r = await api(stranger, `/v1/agents/${id}/capital/mandate`);
    check('a second wallet cannot read it', r.status === 403, `status ${r.status}`);
    const w = await put({ ...VALID, max_borrow_usdg: 10 }, stranger);
    check('nor write it', w.status === 403, `status ${w.status}`);
    const s = await api(stranger, `/v1/agents/${id}/capital/mandate/stop`, { method: 'POST', body: {} });
    check('nor stop it', s.status === 403, `status ${s.status}`);
    const anon = await api(null, `/v1/agents/${id}/capital/mandate`);
    check('and nobody signed out can read it', anon.status === 401, `status ${anon.status}`);
    const back = await api(owner, `/v1/agents/${id}/capital/mandate`);
    check('the owner\'s cap is unchanged', back.body?.mandate?.max_borrow_usdg === 150, `${back.body?.mandate?.max_borrow_usdg}`);
  });

  // =====================================================================
  await section('6. The capital log is public; a private agent\'s reasons are not', async () => {
    sql(`INSERT INTO capital_actions (agent_id, market_id, decider, kind, amount, reason_code, why, evidence, status, refusal_code, refusal_detail)
         VALUES ('${id}', '0x66306c08', 'deterministic', 'borrow', 40, 'liquidity_below_trigger',
                 'the wallet holds 10.00 USDG against a trigger of 50.00; borrowing 40.00',
                 '{"mandate":{"MinHealthFactor":2}}'::jsonb, 'refused', 'lending_not_enabled', 'lending is not enabled')`);
    const pub = await api(null, `/v1/agents/${id}/capital`);
    const act = pub.body?.actions?.[0];
    check('the log reads without a session', pub.status === 200 && act?.kind === 'borrow', `${pub.status} ${JSON.stringify(act)}`);
    check('with the refusal named', act?.refusal_code === 'lending_not_enabled', `${act?.refusal_code}`);
    check('and the reason and inputs of a public agent', /trigger of 50/.test(act?.why ?? '') && act?.evidence?.mandate,
      JSON.stringify(act).slice(0, 200));
    check('the mandate status is shown beside it', pub.body?.mandate?.status === 'draft', JSON.stringify(pub.body?.mandate));

    // A SECOND AGENT, private from creation: visibility cannot be changed on an
    // existing agent (private-agent-verify proves the database refuses it).
    const p = await api(owner, '/v1/agents', {
      method: 'POST', headers: VERIFICATION_HEADER,
      body: { name: `${TAG}_private`, strategyType: 'momentum', assetUniverse: 'us_equities', visibility: 'private',
              riskProfile: JSON.stringify({ cash_floor_pct: 0.05 }) },
    });
    const pid = p.body?.id;
    check('a private fixture agent is made', !!pid, `${p.status} ${JSON.stringify(p.body).slice(0, 160)}`);
    sql(`INSERT INTO capital_actions (agent_id, market_id, decider, kind, amount, reason_code, why, evidence, status, refusal_code, refusal_detail)
         VALUES ('${pid}', '0x66306c08', 'deterministic', 'borrow', 40, 'liquidity_below_trigger',
                 'the wallet holds 10.00 USDG against a trigger of 50.00; borrowing 40.00',
                 '{"mandate":{"MinHealthFactor":2}}'::jsonb, 'refused', 'lending_not_enabled', 'lending is not enabled')`);
    const priv = await api(null, `/v1/agents/${pid}/capital`);
    const pa = priv.body?.actions?.[0];
    check('a private agent still shows what it did', pa?.kind === 'borrow' && pa?.amount === 40 && pa?.status === 'refused',
      JSON.stringify(pa));
    check('but not why, which carries its mandate\'s levels', pa?.why === null && pa?.evidence === 'withheld',
      JSON.stringify(pa));
  });
} catch (e) {
  check('the suite ran to completion', false, e?.message ?? String(e));
}

process.exit(report());
