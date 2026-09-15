/**
 * fills-verify.mjs — every position has a cost basis, and every finished
 * position says what it made (0051).
 *
 * WHAT IS CLAIMED, and what would falsify it:
 *
 *   1. The ledger cannot be edited, and a live book's fills cannot be deleted.
 *   2. Every fill that changed a book is in it: every mined on-chain buy/sell,
 *      and every virtual buy/sell of an agent with no wallet. A gap is a
 *      position with no cost basis again.
 *   3. The accounting on every row adds up: quantity carried, average cost on a
 *      fresh buy, realized = (price - average cost) x quantity.
 *   4. The round trips worked out by hand from the executions on 2026-09-14
 *      (onchain_live_v1: AAPL +0.0053, AAPL +0.0066, MSFT -0.0312) are on the
 *      record as the ledger's own results, not only in somebody's head.
 *   5. The public positions endpoint serves those results, and the owner
 *      portfolio is private and keeps real money, virtual capital and
 *      subscribers' wallets apart.
 *
 * Writes nothing: the refusals are probed inside transactions that roll back.
 *
 *   node infra/verify/fills-verify.mjs
 */
import { execFileSync } from 'node:child_process';
import { suite } from './lib/sections.mjs';

const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const WEB = process.env.WEB_URL || 'http://127.0.0.1:3000';
const DB = process.env.DATABASE_URL || 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';

const { check, section, nothingToCheck, report } = suite('fills-verify');

const sql = (q) => execFileSync('psql', [DB, '-At', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
  { input: q, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
const json = (q) => { const t = sql(q); return t ? JSON.parse(t) : null; };
const refused = (q) => { try { sql(`BEGIN; ${q} ROLLBACK;`); return null; } catch (e) { return String(e.stderr || e.message); } };

await section('The ledger is append-only', async () => {
  const exists = sql(`SELECT to_regclass('public.position_fills') IS NOT NULL AND to_regclass('public.position_episodes') IS NOT NULL`);
  check('position_fills and position_episodes exist', exists === 't', exists);
  const live = sql(`SELECT f.id FROM position_fills f JOIN agents a ON a.id = f.agent_id AND a.provenance = 'live' ORDER BY f.id LIMIT 1`);
  if (!live) { nothingToCheck('no live fill exists yet to probe the refusals against'); return; }
  const u = refused(`UPDATE position_fills SET price = price + 1 WHERE id = ${live};`);
  check('an edit to a live fill is refused', !!u && /cannot be changed/.test(u), u ?? 'the update went through');
  const d = refused(`DELETE FROM position_fills WHERE id = ${live};`);
  check('deleting a live fill while its book exists is refused', !!d && /cannot be deleted/.test(d), d ?? 'the delete went through');
});

await section('Every fill that changed a book is in the ledger', async () => {
  const chainMissing = json(`SELECT coalesce(json_agg(json_build_object('id', e.id, 'ts', e.ts, 'symbol', e.symbol, 'action', e.intent_action)), '[]')
      FROM executions e JOIN agents a ON a.id = e.agent_id AND a.provenance = 'live'
     WHERE e.status = 'mined' AND e.intent_action IN ('buy','sell') AND e.amount_in > 0 AND e.filled_out > 0
       AND NOT EXISTS (SELECT 1 FROM position_fills f WHERE f.execution_id = e.id)`);
  const chainTotal = sql(`SELECT count(*) FROM executions e JOIN agents a ON a.id = e.agent_id AND a.provenance = 'live'
     WHERE e.status = 'mined' AND e.intent_action IN ('buy','sell') AND e.amount_in > 0 AND e.filled_out > 0`);
  check(`every mined on-chain buy/sell has a fill (${chainTotal} on record)`, chainMissing.length === 0,
    `${chainMissing.length} missing: ${JSON.stringify(chainMissing.slice(0, 5))}`);

  // raw-by-design: coverage is of every fill that changed a book, including rows later marked as artefacts
  const virtMissing = json(`SELECT coalesce(json_agg(json_build_object('id', d.id, 'ts', d.ts, 'symbol', d.symbol)), '[]')
      FROM decisions d JOIN agents a ON a.id = d.agent_id AND a.provenance = 'live'
      JOIN portfolios p ON p.agent_id = d.agent_id AND p.season_id = d.season_id
     WHERE d.action IN ('buy','sell') AND d.quantity > 0
       AND NOT EXISTS (SELECT 1 FROM agent_wallets w WHERE w.agent_id = d.agent_id)
       AND NOT EXISTS (SELECT 1 FROM position_fills f WHERE f.decision_id = d.id AND f.book = 'agent')`);
  const virtTotal = sql(`SELECT count(*) FROM decisions d JOIN agents a ON a.id = d.agent_id AND a.provenance = 'live'
     WHERE d.action IN ('buy','sell') AND d.quantity > 0
       AND NOT EXISTS (SELECT 1 FROM agent_wallets w WHERE w.agent_id = d.agent_id)`);
  check(`every virtual buy/sell has a fill (${virtTotal} on record)`, virtMissing.length === 0,
    `${virtMissing.length} missing: ${JSON.stringify(virtMissing.slice(0, 5))}`);
});

await section('The accounting on every row adds up', async () => {
  const n = sql(`SELECT count(*) FROM position_fills`);
  if (n === '0') { nothingToCheck('the ledger is empty'); return; }
  const carried = sql(`SELECT count(*) FROM position_fills
     WHERE abs(qty_after - CASE WHEN side = 'buy' THEN qty_before + quantity ELSE greatest(qty_before - quantity, 0) END) > 1e-8`);
  check(`quantity is carried through all ${n} fills`, carried === '0', `${carried} row(s) do not add up`);
  const fresh = sql(`SELECT count(*) FROM position_fills
     WHERE side = 'buy' AND qty_before = 0 AND (avg_cost_after IS NULL OR abs(avg_cost_after - price) > 1e-9)`);
  check('a buy from flat has the fill price as its cost basis', fresh === '0', `${fresh} row(s) do not`);
  const realized = sql(`SELECT count(*) FROM position_fills
     WHERE side = 'sell' AND avg_cost_before IS NOT NULL
       AND (realized_pnl IS NULL OR abs(realized_pnl - (price - avg_cost_before) * least(quantity, qty_before)) > 1e-6)`);
  check('realized = (price - average cost) x quantity on every sell with a basis', realized === '0', `${realized} row(s) differ`);
  const unknownButRealized = sql(`SELECT count(*) FROM position_fills WHERE side = 'sell' AND avg_cost_before IS NULL AND realized_pnl IS NOT NULL`);
  check('no sell without a basis claims a result', unknownButRealized === '0', `${unknownButRealized} row(s)`);
});

await section('The hand-computed round trips are on the record', async () => {
  const rows = json(`SELECT coalesce(json_agg(json_build_object('symbol', pe.symbol, 'realized', pe.realized_pnl::float8,
        'closed', pe.closed_at)), '[]')
      FROM position_episodes pe JOIN agents a ON a.id = pe.agent_id AND a.name = 'onchain_live_v1' AND a.provenance = 'live'
     WHERE pe.book = 'agent' AND pe.closed_at BETWEEN '2026-09-14 09:00+00' AND '2026-09-14 22:00+00'`);
  if (rows.length === 0) { nothingToCheck('onchain_live_v1 has no closed position in that window on this deployment'); return; }
  const want = [['AAPL', 0.0053], ['AAPL', 0.0066], ['MSFT', -0.0312]];
  for (const [sym, v] of want) {
    check(`${sym} ${v > 0 ? '+' : ''}${v} is a closed position's realized result`,
      rows.some((r) => r.symbol === sym && r.realized !== null && Math.abs(r.realized - v) < 0.0006),
      JSON.stringify(rows));
  }
});

await section('The results are served, and the portfolio keeps books apart', async () => {
  const id = sql(`SELECT id FROM agents WHERE name = 'onchain_live_v1' AND provenance = 'live' LIMIT 1`);
  if (!id) { nothingToCheck('no onchain_live_v1 on this deployment'); } else {
    const r = await fetch(`${AGENT}/v1/agents/${id}/positions`).then((x) => x.json()).catch(() => null);
    check('the public positions endpoint lists closed positions with their results',
      Array.isArray(r?.trades) && r.trades.length > 0 && r.trades.some((t) => typeof t.net_pnl === 'number'),
      JSON.stringify(r?.trades?.slice?.(0, 2)));
    check('with totals that say which results they leave out', typeof r?.trade_totals?.note === 'string', JSON.stringify(r?.trade_totals));
    const unexplained = (r?.open ?? []).filter((o) => !o.entry_known && !o.entry_note);
    check('an open position with no basis says why', unexplained.length === 0, JSON.stringify(unexplained));
    const p = await fetch(`${WEB}/agents/${id}?tab=positions`).then((x) => x.text()).catch(() => '');
    check('and the Positions tab prints what each closed position made', /what each made/.test(p), 'the closed-positions results section is missing');
  }

  const creator = sql(`SELECT id FROM creators WHERE provenance = 'live' LIMIT 1`);
  if (creator) {
    const unauth = await fetch(`${AGENT}/v1/creators/${creator}/portfolio`);
    check('the owner portfolio refuses a caller with no session', unauth.status === 401, `status ${unauth.status}`);
  }
  const src = (await import('node:fs')).readFileSync(new URL('../../services/agent-service/src/creators/portfolio.service.ts', import.meta.url), 'utf8');
  check('real money and virtual capital are totalled apart', /real:\s*totalsFor\('real'\)/.test(src) && /virtual:\s*totalsFor\('virtual'\)/.test(src),
    'the portfolio totals are not split by money');
  check('subscribers are reported outside the totals', /subscribers,/.test(src) && !/totalsFor[\s\S]{0,400}subRows/.test(src),
    'subscriber books appear to be summed into a total');
});

const code = report();
if (code !== 0) process.exit(code);
console.log('fills-verify: every position has a cost, and every finished one says what it made.');
