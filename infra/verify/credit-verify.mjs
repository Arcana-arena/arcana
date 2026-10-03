/**
 * credit-verify.mjs — Agent Credit, proved at its edges (architecture.md §18).
 *
 * The arithmetic — cycles, the score, the tier gates, the limit — is proved by
 * the Go tests in services/decision-engine/internal/credit, which run without a
 * chain or a database. What cannot be proved there is what this suite is for:
 *
 *   the database     refuses a reputation or a cycle that contradicts itself,
 *                    and refuses the same liquidation written twice
 *   the API          reports unrated as unrated, a stale reputation as tier 0,
 *                    and a liquidation count of null — not zero — when nothing
 *                    has read the chain
 *   the limit        the API offers is the one the allowlist's tier table gives,
 *                    computed here independently from the same file
 *   the mandate      cannot be saved above that limit
 *   the guard        is actually reading Morpho's Liquidate events, now
 *
 * Fixture agents carry provenance='verification' and have no wallet. Reputation,
 * cycle and liquidation rows are written for them directly: the guard only
 * rebuilds agents that have owed something on chain, so it never touches them.
 *
 *   node infra/verify/credit-verify.mjs
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
const { check, section, report } = suite('credit-verify');

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

// THE EXPECTED LIMIT, FROM THE ALLOWLIST AND NOT FROM THE SERVICE. If this
// suite asked the API what the limit should be and then checked the API said
// so, it would pass on any number at all.
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

const TAG = `verify_credit_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
function purge(like) {
  try {
    sql(`DELETE FROM agents WHERE creator_id IN (SELECT id FROM creators WHERE handle LIKE '${like}');
         DELETE FROM creators WHERE handle LIKE '${like}';`);
  } catch (e) { console.log('  cleanup warning: ' + e.message); }
}
purge('verify_credit_%');
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

const MARKET = lending.markets[0].id;
const repRow = (id, cols) => `INSERT INTO capital_reputation
  (agent_id, rated, unrated_why, score, components, inputs, earned_tier, tier, held_because, limit_usdg)
  VALUES ('${id}', ${cols})`;

try {
  const owner = await signInAs(TAG);
  const a = await api(owner, '/v1/agents', {
    method: 'POST', headers: VERIFICATION_HEADER,
    body: { name: `${TAG}_agent`, strategyType: 'momentum', assetUniverse: 'us_equities', visibility: 'public',
            riskProfile: JSON.stringify({ cash_floor_pct: 0.05 }) },
  });
  const id = a.body?.id;
  if (!id) throw new Error(`fixture agent not made: ${a.status} ${JSON.stringify(a.body)}`);
  const capital = () => api(null, `/v1/agents/${id}/capital`);
  const passport = () => api(null, `/v1/agents/${id}/passport`);

  // =====================================================================
  await section('1. An agent that never borrowed is unrated, not zero', async () => {
    const r = await capital();
    const c = r.body?.credit;
    check('the capital read carries a credit block', r.status === 200 && !!c, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    check('its status is no_record', c?.status === 'no_record', `${c?.status}`);
    check('its score is null, not 0', c?.score === null, `${c?.score}`);
    check('and it says why', /never borrowed/.test(c?.unrated_why ?? ''), `${c?.unrated_why}`);
    check('it holds tier 0', c?.tier === 0 && c?.earned_tier === 0, `${c?.tier}/${c?.earned_tier}`);
    check('whether the tier moves the limit is reported exactly as the allowlist sets it',
      c?.enabled === CREDIT_ON, `${c?.enabled} vs file ${CREDIT_ON}`);
    check(`its limit is what the allowlist gives tier 0 (${expectedLimit(0)} USDG)`,
      c?.limit_usdg === expectedLimit(0), `${c?.limit_usdg}`);
    check('the ceiling is the signer\'s per-agent cap', c?.ceiling_usdg === CEILING, `${c?.ceiling_usdg}`);
    check('the tier table is the allowlist\'s', JSON.stringify(c?.tiers?.map((t) => [t.tier, t.max_debt_usdg])) ===
      JSON.stringify(TIERS.map((t) => [t.tier, t.max])), JSON.stringify(c?.tiers));

    const p = await passport();
    const pc = p.body?.capital;
    check('the Passport carries a capital block beside the score history', p.status === 200 && !!pc && 'score_history' in (p.body ?? {}),
      `${p.status} ${JSON.stringify(pc).slice(0, 160)}`);
    check('with a null credit score', pc?.credit_score === null && pc?.status === 'no_record', JSON.stringify(pc).slice(0, 160));
    check('and no loans', pc?.loans?.total === 0 && pc?.borrowed_usdg === 0, JSON.stringify(pc?.loans));
  });

  // =====================================================================
  await section('2. The database refuses a reputation or a cycle that contradicts itself', async () => {
    const j = `'{}'::jsonb, '{}'::jsonb`;
    check('rated with no score',
      /capital_reputation_score_ck/.test(sqlFails(repRow(id, `true, NULL, NULL, ${j}, 0, 0, NULL, 250`)) ?? ''), 'it was stored');
    check('unrated with a score',
      /capital_reputation_score_ck/.test(sqlFails(repRow(id, `false, 'x', 50, ${j}, 0, 0, NULL, 250`)) ?? ''), 'it was stored');
    check('a score of 101',
      /capital_reputation_score_ck/.test(sqlFails(repRow(id, `true, NULL, 101, ${j}, 3, 3, NULL, 250`)) ?? ''), 'it was stored');
    check('a held tier above the earned one',
      /capital_reputation_tier_ck/.test(sqlFails(repRow(id, `true, NULL, 50, ${j}, 1, 2, NULL, 250`)) ?? ''), 'it was stored');
    const cyc = (cols) => sqlFails(`INSERT INTO capital_cycles
      (agent_id, market_id, opened_at, closed_at, peak_debt_usdg, usdg_days, debt_seconds, seconds_under_floor,
       borrowed_usdg, repaid_usdg, deleverage_steps, liquidations, closed_how)
      VALUES ('${id}', '${MARKET}', now() - interval '9 days', ${cols})`);
    check('a closed cycle that does not say how',
      /capital_cycles_closed_ck/.test(cyc(`now(), 100, 900, 777600, 0, 100, 101, 0, 0, NULL`) ?? ''), 'it was stored');
    check('an open cycle that says how it closed',
      /capital_cycles_closed_ck/.test(cyc(`NULL, 100, 900, 777600, 0, 100, 0, 0, 0, 'repaid'`) ?? ''), 'it was stored');
    check('a way of closing that is not one of the three',
      /capital_cycles_how_ck/.test(cyc(`now(), 100, 900, 777600, 0, 100, 101, 0, 0, 'forgiven'`) ?? ''), 'it was stored');
    const none = await capital();
    check('and after all of that the agent still has no record', none.body?.credit?.status === 'no_record' && none.body?.credit?.cycles?.total === 0,
      JSON.stringify(none.body?.credit?.cycles));
  });

  // =====================================================================
  await section('3. A rated reputation is shown with its working, and its tier gives the allowlist\'s limit', async () => {
    sql(repRow(id, `true, NULL, 72,
      '{"exposure": 30.1, "margin": 25.8, "self_sufficiency": 13.6, "cycles_closed": 2.5}'::jsonb,
      '{"figures": {"usdg_days": 9000, "debt_days": 60, "share_under_floor": 0, "lowest_health_factor_worst": 1.9,
                    "deleverage_steps": 1, "qualifying_cycles": 2, "cycles_repaid": 2, "evidence_fraction": 0.86},
        "scored_days": 120}'::jsonb, 2, 2, NULL, 0`));
    const r = await capital();
    const c = r.body?.credit;
    check('it is rated 72', c?.status === 'rated' && c?.score === 72, `${c?.status} ${c?.score}`);
    check('the four components are returned', c?.components?.exposure === 30.1 && c?.components?.cycles_closed === 2.5, JSON.stringify(c?.components));
    check('and the figures they came from', c?.inputs?.figures?.usdg_days === 9000, JSON.stringify(c?.inputs).slice(0, 160));
    check('it holds tier 2', c?.tier === 2, `${c?.tier}`);
    // The stored row says limit 0. What is returned must come from the
    // allowlist, read now — the stored figure is history, not the rule.
    check(`its limit is ${expectedLimit(2)} USDG, from the allowlist and not from the stored row`,
      c?.limit_usdg === expectedLimit(2), `${c?.limit_usdg}`);
    check('it is not stale', c?.stale === false, `${c?.stale}`);

    const m = await api(owner, `/v1/agents/${id}/capital/mandate`);
    check('the mandate form is offered the same limit', m.body?.limits?.agent_max_debt_usdg === expectedLimit(2),
      `${m.body?.limits?.agent_max_debt_usdg}`);
    check('and the platform cap is still reported as the ceiling', m.body?.limits?.platform_max_debt_usdg === CEILING,
      `${m.body?.limits?.platform_max_debt_usdg}`);

    const p = await passport();
    check('the Passport shows the same score and tier', p.body?.capital?.credit_score === 72 && p.body?.capital?.tier === 2,
      JSON.stringify(p.body?.capital).slice(0, 200));
    check('and the same limit', p.body?.capital?.credit_limit_usdg === expectedLimit(2), `${p.body?.capital?.credit_limit_usdg}`);
  });

  // =====================================================================
  await section('4. A mandate cannot be saved above the limit', async () => {
    const lim = expectedLimit(2);
    const body = (cap) => ({ min_health_factor: 2, max_borrow_rate_bps: 800, liquidity_trigger_usdg: 10, max_borrow_usdg: cap, never_sell: [] });
    const put = (cap) => api(owner, `/v1/agents/${id}/capital/mandate`, { method: 'PUT', body: body(cap) });
    const over = await put(lim + 1);
    const want = lim >= CEILING ? 'borrow_cap_over_platform' : 'borrow_cap_over_credit_limit';
    check(`one USDG over the limit -> ${want}`, over.status === 400 && codeOf(over) === want,
      `${over.status} ${JSON.stringify(over.body).slice(0, 200)}`);
    const none = await api(owner, `/v1/agents/${id}/capital/mandate`);
    check('and nothing was saved', none.body?.mandate === null, JSON.stringify(none.body?.mandate));
    const at = await put(lim);
    check('exactly at the limit saves', at.status === 200 && at.body?.mandate?.max_borrow_usdg === lim,
      `${at.status} ${JSON.stringify(at.body).slice(0, 200)}`);
  });

  // =====================================================================
  await section('5. A reputation nobody has re-checked grants tier 0', async () => {
    sql(`UPDATE capital_reputation SET confirmed_at = now() - interval '49 hours' WHERE agent_id = '${id}'`);
    const c = (await capital()).body?.credit;
    check('it is reported stale', c?.stale === true, `${c?.stale}`);
    check('it holds tier 0 while its earned tier is still shown', c?.tier === 0 && c?.earned_tier === 2, `${c?.tier}/${c?.earned_tier}`);
    check(`its limit is tier 0's (${expectedLimit(0)} USDG)`, c?.limit_usdg === expectedLimit(0), `${c?.limit_usdg}`);
    const m = await api(owner, `/v1/agents/${id}/capital/mandate`);
    check('and the mandate form is offered that', m.body?.limits?.agent_max_debt_usdg === expectedLimit(0),
      `${m.body?.limits?.agent_max_debt_usdg}`);
    sql(`UPDATE capital_reputation SET confirmed_at = now() - interval '47 hours' WHERE agent_id = '${id}'`);
    const fresh = (await capital()).body?.credit;
    check('at 47 hours it is not stale and holds its tier', fresh?.stale === false && fresh?.tier === 2, `${fresh?.stale} ${fresh?.tier}`);
  });

  // =====================================================================
  await section('6. A liquidation is on the record once, with its transaction', async () => {
    const tx = `0x${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
    const ins = () => sqlFails(`INSERT INTO capital_liquidations
      (agent_id, market_id, wallet, ts, block_number, tx_hash, log_index, liquidator, repaid_usdg, seized_qty, bad_debt_usdg)
      VALUES ('${id}', '${MARKET}', '0x0000000000000000000000000000000000000001', now() - interval '1 day', 1, '${tx}', 7,
              '0x0000000000000000000000000000000000000002', 120.5, 0.61, 0)`);
    check('it is written', ins() === null, 'the insert failed');
    check('the same event written again is refused', /capital_liquidations_event_uq/.test(ins() ?? ''), 'it was stored twice');
    const r = await capital();
    const l = r.body?.credit?.liquidations;
    check('it is listed with its transaction', l?.list?.length === 1 && l.list[0].tx_hash === tx, JSON.stringify(l?.list).slice(0, 200));
    check('and what was seized and repaid', l?.list?.[0]?.seized_qty === 0.61 && l?.list?.[0]?.repaid_usdg === 120.5, JSON.stringify(l?.list?.[0]));
    const scanned = sql(`SELECT count(*) FROM capital_scan_cursors`) !== '0';
    check('the count is a number when the chain has been read, and null when it has not',
      scanned ? l?.count === 1 && r.body?.record?.liquidations === 1 : l?.count === null && r.body?.record?.liquidations === null,
      `scanned=${scanned} count=${l?.count} record=${r.body?.record?.liquidations}`);
  });

  // =====================================================================
  await section('7. The guard is reading Morpho\'s Liquidate events, now', async () => {
    const row = sql(`SELECT block_number || '|' || extract(epoch FROM now() - updated_at)::int
                       FROM capital_scan_cursors WHERE lower(market_id) = lower('${MARKET}')`);
    check('the allowlisted market has a scan cursor', row !== '', 'no cursor: the liquidation scan has never finished');
    const [block, age] = row.split('|').map(Number);
    check('it has read past the block the scan starts from', block > Number(lending.liquidations_from_block ?? 0),
      `cursor ${block}, start ${lending.liquidations_from_block}`);
    check('and it moved in the last ten minutes', age >= 0 && age < 600, `${age} s ago`);
  });
} catch (e) {
  check('the suite ran to completion', false, e?.message ?? String(e));
}

process.exit(report());
