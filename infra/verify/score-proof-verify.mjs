/**
 * score-proof-verify.mjs — a score can be computed again, from inputs that are
 * sealed and on chain, and the creator reputation is derived from those scores.
 *
 * WHAT IS CLAIMED, and what would falsify it:
 *
 *   1. Seals cannot be moved. Falsified by the database accepting an edit or a
 *      deletion of a sealed snapshot or score, a seal added to an old row, or a
 *      changed score input.
 *   2. Every sealed snapshot is exactly what its manifest says, and sealing is
 *      actually happening — a live snapshot written after sealing began with no
 *      seal is the fallback firing, and that is a failure.
 *   3. Every sealed score recomputes, here, with a THIRD implementation of the
 *      formula written from its published steps — exactly, using the manifest's
 *      own constants — and every input it lists is the recorded one.
 *   4. A score joins an anchor only after all of its sealed inputs are in mined
 *      anchors, and nothing sealed waits long.
 *   5. The public endpoints say the same thing this suite computed.
 *   6. Creator reputation is derived from sealed scores and nothing reads the
 *      stored column that nothing ever wrote.
 *   7. The site does not claim AGENT ECONOMY while no payment exists.
 *
 * Writes nothing: every probe rolls back.
 *
 *   node infra/verify/score-proof-verify.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { suite } from './lib/sections.mjs';

const REPO = process.env.REPO || '/home/ubuntu/arcana';
const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const WEB = process.env.WEB_URL || 'http://127.0.0.1:3000';

const { check, section, report, nothingToCheck } = suite('score-proof-verify');

const sql = (q) =>
  execFileSync('docker', ['exec', 'arcana-postgres', 'psql', '-U', 'arcana', '-d', 'arcana', '-v', 'ON_ERROR_STOP=1', '-tAc', q],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).trim();
const json = (q) => { const t = sql(q); return t ? JSON.parse(t) : null; };
const refused = (q) => { try { sql(`BEGIN; ${q} ROLLBACK;`); return null; } catch (e) { return String(e.stderr || e.message); } };
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const get = async (path) => {
  const r = await fetch(`${AGENT}${path}`);
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
};
// The suite's own declaration, so an empty section is listed as unproven rather
// than failing as a section that silently checked nothing.
const nothing = (why) => nothingToCheck(why);

const US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/** key: value manifest lines, after the scheme line. */
const lines = (body, scheme) => {
  const ls = body.replace(/\n$/, '').split('\n');
  if (ls[0] !== scheme) throw new Error(`first line is ${JSON.stringify(ls[0])}, not ${scheme}`);
  const out = {};
  for (const l of ls.slice(1)) {
    const i = l.indexOf(': ');
    out[l.slice(0, i)] = JSON.parse(l.slice(i + 2));
  }
  return out;
};

// ---------------------------------------------------------------------------
// THE THIRD IMPLEMENTATION of arcana-score-formula/v1, written from the
// published steps (GET /v1/score-formulas/arcana-score-formula/v1), not copied
// from either the Go engine or agent-service.
// ---------------------------------------------------------------------------
function recompute(m) {
  const k = m.constants;
  const c01 = (x) => Math.min(1, Math.max(0, x));
  const r1 = (x) => (x < 0 ? -Math.round(-x * 10) : Math.round(x * 10)) / 10;
  const num = (s) => (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(String(s).trim()) ? Number(s) : 0);

  const navs = m.nav_series.map((p) => num(p.nav));
  let exSum = 0, exN = 0;
  m.nav_series.forEach((p, i) => {
    if (navs[i] > 0) { exSum += Math.max(0, (navs[i] - num(p.cash)) / navs[i]); exN++; }
  });
  const exposure = exN > 0 ? exSum / exN : 0;
  const n = m.decisions.length;
  const buys = m.decisions.filter((d) => d.action === 'buy').length;
  const sells = m.decisions.filter((d) => d.action === 'sell').length;
  let peer = null;
  if (m.creator_peers.length) { let s = 0; for (const p of m.creator_peers) s += p.performance_score; peer = s / m.creator_peers.length; }

  const ranked = n >= k.min_participation_decisions;
  const prof = k.strategy_profiles[m.strategy_type];
  let strategy = k.neutral, checkable = false;
  if (prof && n >= k.strategy_min_decisions) {
    const fit = (v, lo, hi) => (v < lo ? c01(1 - (lo - v) / k.strategy_fit_tolerance) : v > hi ? c01(1 - (v - hi) / k.strategy_fit_tolerance) : 1);
    const trades = buys + sells;
    const tf = fit(trades / n, prof.turnover_lo, prof.turnover_hi);
    const sf = trades === 0 ? 1 : fit(sells / trades, prof.sell_share_lo, prof.sell_share_hi);
    strategy = r1((k.w_strat_turnover * tf + k.w_strat_sell_share * sf) * 100);
    checkable = true;
  }
  const mult = checkable ? k.strategy_floor + (1 - k.strategy_floor) * (strategy / 100) : 1;
  const longevity = c01(navs.length / k.longevity_ticks) * 100;
  const creator = peer === null ? k.neutral : c01(peer / 100) * 100;
  let performance = k.neutral, risk = k.neutral, consistency = k.neutral;
  if (navs.length) {
    const rets = [];
    for (let i = 1; i < navs.length; i++) if (navs[i - 1] > 0) rets.push((navs[i] - navs[i - 1]) / navs[i - 1]);
    if (navs[0] > 0) performance = c01(0.5 + ((navs[navs.length - 1] - navs[0]) / navs[0]) / k.perf_scale) * 100;
    const ex = exposure < k.min_exposure ? k.min_exposure : exposure;
    if (rets.length) {
      let mu = 0; for (const r of rets) mu += r; mu /= rets.length;
      let ss = 0; for (const r of rets) { const d = r - mu; ss += d * d; }
      const sd = Math.sqrt(ss / rets.length) / ex;
      let peak = navs[0], dd = 0;
      for (const v of navs) { if (v > peak) peak = v; if (peak > 0) dd = Math.max(dd, (peak - v) / peak); }
      risk = r1(0.5 * (c01(1 - sd / k.vol_scale) * 100) + 0.5 * (c01(1 - (dd / ex) / k.dd_scale) * 100));
      consistency = c01(1 - sd / k.consistency_scale) * 100;
    }
  }
  const weighted = k.w_performance * performance + k.w_risk * risk + k.w_regime * k.neutral +
    k.w_consistency * consistency + k.w_creator * creator + k.w_longevity * longevity;
  return {
    performance, risk: ranked ? risk : null, strategy, regime: k.neutral, consistency: ranked ? consistency : null,
    creator, longevity, strategy_multiplier: mult, ranked, arcana: ranked ? r1(weighted * mult) : null,
  };
}

// ---------------------------------------------------------------------------
await section('Seals cannot be moved', async () => {
  const live = json(`SELECT json_build_object('portfolio', p.id, 'agent', p.agent_id, 'season', p.season_id)
                       FROM portfolios p JOIN agents a ON a.id = p.agent_id AND a.provenance = 'live' LIMIT 1`);
  if (!live) { nothing('no live portfolio to probe against'); return; }
  const far = `'2099-01-01T00:00:0${Math.floor(Math.random() * 9)}.${Math.floor(Math.random() * 1e6)}Z'`;
  const seal = sha(randomUUID());
  const insSnap = (s) => `INSERT INTO portfolio_snapshots (portfolio_id, ts, holdings, nav, cash, seal, seal_scheme)
      VALUES ('${live.portfolio}', ${far}, '{}', 1, 1, ${s ? `'${s}'` : 'NULL'}, ${s ? `'arcana-portfolio-snapshot/v1'` : 'NULL'});`;
  const e1 = refused(`${insSnap(seal)} UPDATE portfolio_snapshots SET nav = 2 WHERE portfolio_id = '${live.portfolio}' AND ts = ${far};`);
  check('a sealed snapshot cannot be edited', !!e1 && /nothing it sealed can be changed/.test(e1), e1 ?? 'the UPDATE succeeded');
  const e2 = refused(`${insSnap(seal)} DELETE FROM portfolio_snapshots WHERE portfolio_id = '${live.portfolio}' AND ts = ${far};`);
  check('a sealed snapshot cannot be deleted', !!e2 && /cannot be deleted/.test(e2), e2 ?? 'the DELETE succeeded');
  const e3 = refused(`${insSnap(null)} UPDATE portfolio_snapshots SET seal = '${seal}', seal_scheme = 'x' WHERE portfolio_id = '${live.portfolio}' AND ts = ${far};`);
  check('a seal cannot be added to an old snapshot', !!e3 && /never added afterwards/.test(e3), e3 ?? 'the UPDATE succeeded');

  const insScore = (s) => `INSERT INTO score_snapshots (agent_id, season_id, ts, arcana_score, seal, seal_scheme)
      VALUES ('${live.agent}', '${live.season}', ${far}, 50, ${s ? `'${s}'` : 'NULL'}, ${s ? `'arcana-score/v1'` : 'NULL'});`;
  const e4 = refused(`${insScore(seal)} UPDATE score_snapshots SET arcana_score = 99 WHERE agent_id = '${live.agent}' AND ts = ${far};`);
  check('a sealed score cannot be edited', !!e4 && /nothing it sealed can be changed/.test(e4), e4 ?? 'the UPDATE succeeded');
  const e5 = refused(`${insScore(seal)} DELETE FROM score_snapshots WHERE agent_id = '${live.agent}' AND ts = ${far};`);
  check('a sealed score cannot be deleted', !!e5 && /cannot be deleted/.test(e5), e5 ?? 'the DELETE succeeded');
  const e6 = refused(`${insScore(null)} UPDATE score_snapshots SET seal = '${seal}' WHERE agent_id = '${live.agent}' AND ts = ${far};`);
  check('a seal cannot be added to an old score', !!e6 && /never added afterwards/.test(e6), e6 ?? 'the UPDATE succeeded');

  const insInput = `INSERT INTO score_input_seals (agent_id, season_id, score_ts, input_kind, seal)
      VALUES ('${live.agent}', '${live.season}', ${far}, 'portfolio_snapshot', '${seal}');`;
  const e7 = refused(`${insInput} DELETE FROM score_input_seals WHERE score_ts = ${far};`);
  check('a score\'s inputs cannot be removed', !!e7 && /cannot be deleted/.test(e7), e7 ?? 'the DELETE succeeded');
  const e8 = refused(`${insInput} UPDATE score_input_seals SET seal = repeat('0', 64) WHERE score_ts = ${far};`);
  check('or changed', !!e8 && /cannot change/.test(e8), e8 ?? 'the UPDATE succeeded');
  check('and no probe left a row behind',
    sql(`SELECT (SELECT count(*) FROM portfolio_snapshots WHERE ts > '2098-01-01') + (SELECT count(*) FROM score_snapshots WHERE ts > '2098-01-01') + (SELECT count(*) FROM score_input_seals WHERE score_ts > '2098-01-01')`) === '0');
});

// ---------------------------------------------------------------------------
await section('Every sealed snapshot is what its manifest says, and sealing is happening', async () => {
  const rows = json(`SELECT coalesce(json_agg(x), '[]') FROM (
      SELECT ps.portfolio_id::text AS portfolio, p.agent_id::text AS agent, p.season_id::text AS season,
             to_char(ps.ts AT TIME ZONE 'UTC', ${US}) AS ts, ps.nav::text AS nav, ps.cash::text AS cash,
             ps.holdings::text AS holdings, trim(ps.seal) AS seal, e.body,
             (SELECT trim(q.seal) FROM portfolio_snapshots q WHERE q.portfolio_id = ps.portfolio_id AND q.seal IS NOT NULL
                AND q.ts < ps.ts ORDER BY q.ts DESC LIMIT 1) AS prev
        FROM portfolio_snapshots ps JOIN portfolios p ON p.id = ps.portfolio_id
        JOIN agents a ON a.id = p.agent_id AND a.provenance = 'live'
        LEFT JOIN decision_evidence e ON e.hash = ps.seal
       WHERE ps.seal IS NOT NULL ORDER BY ps.ts DESC LIMIT 60) x`);
  if (rows.length === 0) { nothing('no live snapshot has been sealed yet — the first tick after 0049 writes one'); return; }
  let bad = [];
  for (const r of rows) {
    const why = [];
    if (!r.body) why.push('no manifest stored');
    else {
      if (sha(r.body) !== r.seal) why.push('sha256 of manifest is not the seal');
      try {
        const m = lines(r.body, 'arcana-portfolio-snapshot/v1');
        if (m.portfolio_id !== r.portfolio || m.agent_id !== r.agent || m.season_id !== r.season) why.push('names another portfolio');
        if (m.ts !== r.ts) why.push(`ts ${m.ts} vs ${r.ts}`);
        if (m.nav !== r.nav || m.cash !== r.cash) why.push('nav/cash differ');
        const h = JSON.parse(r.holdings);
        const hm = m.holdings ?? {};
        const keys = new Set([...Object.keys(h), ...Object.keys(hm)]);
        for (const key of keys) if (Number(h[key]) !== Number(hm[key])) why.push(`holding ${key} differs`);
        if ((m.previous_seal ?? null) !== (r.prev ?? null)) why.push('previous_seal is not the prior sealed snapshot');
      } catch (e) { why.push(e.message); }
    }
    if (why.length) bad.push(`${r.portfolio.slice(0, 8)}@${r.ts}: ${why.join(', ')}`);
  }
  check(`the ${rows.length} newest sealed snapshots match their manifests and chain`, bad.length === 0, bad.slice(0, 5).join(' | '));
  const unsealed = sql(`SELECT count(*) FROM portfolio_snapshots ps JOIN portfolios p ON p.id = ps.portfolio_id
                          JOIN agents a ON a.id = p.agent_id AND a.provenance = 'live'
                         WHERE ps.seal IS NULL AND ps.ts > (SELECT min(ts) FROM portfolio_snapshots WHERE seal IS NOT NULL)`);
  check('no live snapshot written since sealing began lacks a seal', unsealed === '0', `${unsealed} written without one — the sealed write is failing`);
});

// ---------------------------------------------------------------------------
let sampleScore = null;
await section('Every sealed score recomputes here, a third time, from inputs that are the recorded ones', async () => {
  const published = await get('/v1/score-formulas/arcana-score-formula/v1');
  check('the formula is published', published.status === 200 && !!published.body?.constants, `status ${published.status}`);
  const scores = json(`SELECT coalesce(json_agg(x), '[]') FROM (
      SELECT DISTINCT ON (s.agent_id, s.season_id) s.agent_id::text AS agent, s.season_id::text AS season,
             to_char(s.ts AT TIME ZONE 'UTC', ${US}) AS ts, trim(s.seal) AS seal, e.body,
             s.arcana_score::text AS arcana_score, s.performance_score::text AS performance_score, s.risk_score::text AS risk_score,
             s.strategy_score::text AS strategy_score, s.regime_score::text AS regime_score, s.consistency_score::text AS consistency_score,
             s.creator_score::text AS creator_score, s.longevity_score::text AS longevity_score,
             (SELECT trim(q.seal) FROM score_snapshots q WHERE q.agent_id = s.agent_id AND q.season_id = s.season_id
                AND q.seal IS NOT NULL AND q.ts < s.ts ORDER BY q.ts DESC LIMIT 1) AS prev
        FROM score_snapshots s JOIN agents a ON a.id = s.agent_id AND a.provenance = 'live'
        LEFT JOIN decision_evidence e ON e.hash = s.seal
       WHERE s.seal IS NOT NULL ORDER BY s.agent_id, s.season_id, s.ts DESC) x`);
  if (scores.length === 0) { nothing('no live score has been sealed yet — the next scoring run (23:30 UTC) writes the first'); return; }
  sampleScore = scores[0];
  const unsealedSince = sql(`SELECT count(*) FROM score_snapshots s JOIN agents a ON a.id = s.agent_id AND a.provenance = 'live'
                              WHERE s.seal IS NULL AND s.ts > (SELECT min(ts) FROM score_snapshots WHERE seal IS NOT NULL)`);
  check('no live score written since sealing began lacks a seal', unsealedSince === '0', `${unsealedSince} written without one`);

  for (const s of scores) {
    const tag = `${s.agent.slice(0, 8)}@${s.ts}`;
    if (!s.body) { check(`${tag}: its manifest is stored`, false); continue; }
    check(`${tag}: sha256 of the manifest is the seal`, sha(s.body) === s.seal);
    let m;
    try { m = lines(s.body, 'arcana-score/v1'); } catch (e) { check(`${tag}: the manifest reads`, false, e.message); continue; }
    check(`${tag}: it names this agent, season and time`, m.agent_id === s.agent && m.season_id === s.season && m.ts === s.ts);
    check(`${tag}: its constants are the published constants of ${m.formula}`,
      m.formula === 'arcana-score-formula/v1' && JSON.stringify(sortKeys(m.constants)) === JSON.stringify(sortKeys(published.body?.constants)));
    check(`${tag}: previous_seal is the prior sealed score`, (m.previous_seal ?? null) === (s.prev ?? null));

    const again = recompute(m);
    const diffs = Object.keys(again).filter((k) => again[k] !== m.outputs[k]);
    check(`${tag}: every output recomputes exactly (third implementation)`, diffs.length === 0,
      diffs.map((k) => `${k}: here ${again[k]}, manifest ${m.outputs[k]}`).join('; '));
    const cols = { arcana: 'arcana_score', performance: 'performance_score', risk: 'risk_score', strategy: 'strategy_score',
      regime: 'regime_score', consistency: 'consistency_score', creator: 'creator_score', longevity: 'longevity_score' };
    const colBad = Object.entries(cols).filter(([k, col]) =>
      s[col] === null ? m.outputs[k] !== null : m.outputs[k] === null || Math.abs(Number(s[col]) - m.outputs[k]) > 0.005 + 1e-9);
    check(`${tag}: the stored columns are its outputs`, colBad.length === 0, colBad.map(([k]) => k).join(', '));

    const snaps = json(`SELECT coalesce(json_agg(x ORDER BY x.ts), '[]') FROM (
        SELECT to_char(ps.ts AT TIME ZONE 'UTC', ${US}) AS ts, ps.nav::text AS nav, ps.cash::text AS cash, trim(ps.seal) AS seal
          FROM portfolio_snapshots ps JOIN portfolios p ON p.id = ps.portfolio_id
         WHERE p.agent_id = '${s.agent}' AND p.season_id = '${s.season}' AND ps.ts <= '${s.ts}') x`);
    const navBad = m.nav_series.length !== snaps.length ||
      m.nav_series.some((p, i) => p.ts !== snaps[i].ts || p.nav !== snaps[i].nav || p.cash !== snaps[i].cash || (p.seal ?? null) !== (snaps[i].seal ?? null));
    check(`${tag}: its NAV series is the recorded series, complete and in order`, !navBad, `${m.nav_series.length} listed, ${snaps.length} recorded`);

    const ids = m.decisions.map((d) => d.id);
    const decs = ids.length ? json(`SELECT coalesce(json_object_agg(id, json_build_object('ts', to_char(ts AT TIME ZONE 'UTC', ${US}), 'action', action, 'commitment', trim(commitment))), '{}')
                                        FROM decisions WHERE agent_id = '${s.agent}' AND id IN (${ids.join(',')})`) : {};
    const decBad = m.decisions.filter((d) => { const r = decs[d.id]; return !r || r.ts !== d.ts || r.action !== d.action || (r.commitment ?? null) !== (d.commitment ?? null); });
    check(`${tag}: every decision it counted is the recorded decision`, decBad.length === 0, `${decBad.length} differ`);

    // ONE QUERY FOR EVERY PEER ROW. A manifest lists every score snapshot the
    // creator factor averaged — hundreds for a creator with long-running agents —
    // and one psql call per row ran this suite past its timeout.
    const peerBad = [];
    if (m.creator_peers.length) {
      const want = JSON.stringify(m.creator_peers.map((p) => ({ a: p.agent_id, s: p.season_id, t: p.ts }))).replace(/'/g, "''");
      const found = json(`SELECT coalesce(json_agg(json_build_object('p', ss.performance_score::text, 'seal', trim(ss.seal)) ORDER BY x.n), '[]')
                            FROM jsonb_array_elements('${want}'::jsonb) WITH ORDINALITY AS x(v, n)
                            LEFT JOIN score_snapshots ss ON ss.agent_id = (x.v->>'a')::uuid AND ss.season_id = (x.v->>'s')::uuid
                                                        AND ss.ts = (x.v->>'t')::timestamptz`);
      m.creator_peers.forEach((p, i) => {
        const r = found[i];
        if (!r || r.p === null || Number(r.p) !== p.performance_score || (r.seal ?? null) !== (p.seal ?? null)) peerBad.push(p.agent_id.slice(0, 8));
      });
    }
    check(`${tag}: every peer score it averaged is the recorded score`, peerBad.length === 0, peerBad.join(', '));
  }
});

// ---------------------------------------------------------------------------
await section('A score is anchored only after its inputs, and nothing sealed waits long', async () => {
  const early = sql(`SELECT count(*) FROM decision_anchor_leaves l
                       JOIN decision_anchors a ON a.id = l.anchor_id AND a.status IN ('mined', 'broadcast', 'signed')
                       JOIN score_input_seals i ON i.agent_id = l.agent_id AND i.season_id = l.season_id AND i.score_ts = l.record_ts
                      WHERE l.kind = 'score'
                        AND NOT EXISTS (SELECT 1 FROM decision_anchor_leaves il JOIN decision_anchors ia ON ia.id = il.anchor_id
                                         WHERE il.commitment = i.seal AND ia.status = 'mined' AND ia.id < a.id)`);
  check('no score was anchored before every sealed input it names was in an earlier mined anchor', early === '0', `${early} input(s) were not`);
  const lateSnaps = sql(`SELECT count(*) FROM portfolio_snapshots ps JOIN portfolios p ON p.id = ps.portfolio_id
                           JOIN agents a ON a.id = p.agent_id AND a.provenance = 'live'
                          WHERE ps.seal IS NOT NULL AND ps.ts < now() - interval '45 minutes'
                            AND NOT EXISTS (SELECT 1 FROM decision_anchor_leaves l JOIN decision_anchors x ON x.id = l.anchor_id
                                             WHERE l.kind = 'portfolio_snapshot' AND l.portfolio_id = ps.portfolio_id AND l.record_ts = ps.ts AND x.status = 'mined')`);
  check('every sealed snapshot older than 45 minutes is in a mined anchor', lateSnaps === '0', `${lateSnaps} are not`);
  const lateScores = sql(`SELECT count(*) FROM score_snapshots s JOIN agents a ON a.id = s.agent_id AND a.provenance = 'live'
                           WHERE s.seal IS NOT NULL AND s.ts < now() - interval '90 minutes'
                             AND NOT EXISTS (SELECT 1 FROM score_input_seals i WHERE i.agent_id = s.agent_id AND i.season_id = s.season_id AND i.score_ts = s.ts
                                              AND NOT EXISTS (SELECT 1 FROM decision_anchor_leaves l JOIN decision_anchors x ON x.id = l.anchor_id
                                                               WHERE l.commitment = i.seal AND x.status = 'mined' AND x.mined_at < now() - interval '30 minutes'))
                             AND NOT EXISTS (SELECT 1 FROM decision_anchor_leaves l JOIN decision_anchors x ON x.id = l.anchor_id
                                              WHERE l.kind = 'score' AND l.commitment = s.seal AND x.status = 'mined')`);
  check('every sealed score whose inputs have been on chain for 30 minutes is itself on chain', lateScores === '0', `${lateScores} are not`);
});

// ---------------------------------------------------------------------------
await section('The public endpoints say what this suite computed', async () => {
  if (!sampleScore) { nothing('no sealed score to ask about'); }
  else {
    const v = await get(`/v1/agents/${sampleScore.agent}/score/verification?season_id=${sampleScore.season}&ts=${encodeURIComponent(sampleScore.ts)}`);
    check('the score verification endpoint answers', v.status === 200, `status ${v.status}`);
    check('and verifies the score, every check passing', v.body?.status === 'verified' && (v.body?.checks ?? []).every((c) => c.ok),
      JSON.stringify((v.body?.checks ?? []).filter((c) => !c.ok)).slice(0, 300));
    check('its recomputation equals the manifest', JSON.stringify(v.body?.recomputed) === JSON.stringify(v.body?.outputs));
    check('it lists how much of each input is sealed and on chain', Array.isArray(v.body?.coverage) && v.body.coverage.length === 3);
  }
  const snap = json(`SELECT json_build_object('seal', trim(l.commitment), 'root', trim(a.root)) FROM decision_anchor_leaves l
                       JOIN decision_anchors a ON a.id = l.anchor_id WHERE l.kind = 'portfolio_snapshot' AND a.status = 'mined'
                      ORDER BY a.id DESC LIMIT 1`);
  if (!snap) { nothing('no portfolio snapshot has been anchored yet'); return; }
  const p = await get(`/v1/anchors/leaves/${snap.seal}`);
  check('a snapshot seal\'s proof endpoint answers anchored', p.status === 200 && p.body?.status === 'anchored', `${p.status} ${p.body?.status}`);
  const h = (...parts) => { const x = createHash('sha256'); for (const b of parts) x.update(b); return x.digest(); };
  let cur = h(Buffer.from([0]), Buffer.from(snap.seal, 'hex'));
  for (const s of p.body?.proof ?? []) {
    const sib = Buffer.from(s.sibling, 'hex');
    cur = s.position === 'left' ? h(Buffer.from([1]), sib, cur) : h(Buffer.from([1]), cur, sib);
  }
  check('and its proof, walked here, reaches the anchored root', cur.toString('hex') === snap.root);
});

// ---------------------------------------------------------------------------
await section('Creator reputation is derived from sealed scores, and the stored column is read nowhere', async () => {
  const creators = json(`SELECT coalesce(json_agg(id::text), '[]') FROM creators WHERE provenance = 'live'`);
  for (const id of creators) {
    const r = await get(`/v1/creators/${id}/reputation`);
    const rows = json(`SELECT coalesce(json_agg(x ORDER BY x.agent), '[]') FROM (
        SELECT a.id::text AS agent, (SELECT performance_score::text FROM score_snapshots s WHERE s.agent_id = a.id AND s.seal IS NOT NULL ORDER BY s.ts DESC LIMIT 1) AS perf
          FROM agents a WHERE a.creator_id = '${id}' AND a.status = 'active') x`);
    const used = rows.filter((x) => x.perf !== null);
    let expected = null;
    if (used.length) { let sum = 0; for (const u of used) sum += Number(u.perf); expected = sum / used.length; }
    check(`creator ${id.slice(0, 8)}: reputation is the mean of its active agents' latest sealed performance`,
      r.status === 200 && r.body?.value === expected && (expected === null ? r.body?.status === 'not_measured' : r.body?.status === 'measured'),
      `endpoint ${r.body?.value}, recomputed ${expected}`);
  }
  const offenders = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(f) && !/creator\.entity\.ts$/.test(f)) {
        // Comments that NAME the old column (to say it is no longer read) are not
        // reads; only code is scanned.
        const code = readFileSync(p, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
        if (/(c|creators)\.reputation_score|reputation_score::|reputation_score AS/.test(code)) offenders.push(p.replace(`${REPO}/`, ''));
      }
    }
  };
  walk(`${REPO}/services/agent-service/src`);
  check('no agent-service query reads creators.reputation_score', offenders.length === 0, offenders.join(', '));
});

// ---------------------------------------------------------------------------
await section('The site claims no agent economy while no payment exists', async () => {
  const payments = Number(sql(`SELECT (SELECT count(*) FROM payment_events) + (SELECT count(*) FROM payment_claims)`));
  const home = await (await fetch(`${WEB}/`)).text();
  const claims = /AGENT ECONOMY/i.test(home);
  check(`the landing page ${claims ? 'names' : 'does not name'} AGENT ECONOMY, with ${payments} recorded payment(s)`,
    payments > 0 || !claims, 'the chain on the site claims an economy that zero payments support');
});

const code = report();
if (code !== 0) process.exit(code);
console.log('score-proof-verify: a score can be computed again, from inputs that are sealed and on chain.');
process.exit(0);

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
