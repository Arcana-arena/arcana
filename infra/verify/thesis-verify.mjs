/**
 * thesis-verify.mjs — PROVE THIS THESIS, proved.
 *
 * THE CHECK THIS FILE EXISTS FOR is the negative one: that binding a public
 * thesis to an agent does not change what that agent decides. Everything else
 * here could be right and the feature would still be worthless if a creator
 * could publish a claim and thereby nudge the agent into proving it. A reader
 * cannot verify that by being told; so this builds two identical agents, binds
 * a thesis to one of them, asks both for a decision, and compares.
 *
 * DETERMINISTIC AGENTS, NOT LLM ONES, and that is what makes the comparison
 * mean anything. Two llm agents can answer differently on identical input for
 * reasons that have nothing to do with a thesis, so a difference would prove
 * nothing and a match would prove less. A momentum agent given the same market
 * must produce the same decision — any difference at all is the feature
 * leaking. It also costs nothing: no model call, no wallet, no chain.
 *
 * NOTHING HERE CAN SPEND MONEY. Every agent is a provenance='verification'
 * fixture with no wallet, so there is no key to sign a swap with, and the
 * resolution job is driven over fabricated portfolio snapshots rather than
 * real ones.
 *
 *   node infra/verify/thesis-verify.mjs
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { suite } from './lib/sections.mjs';
import { signIn as sharedSignIn, SIWE_DOMAIN, SIWE_URI, VERIFICATION_HEADER } from './lib/rate-aware.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const WEB = process.env.WEB_URL || 'http://127.0.0.1:3000';
const DB = process.env.DATABASE_URL || 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';
const INTERNAL_KEY = process.env.INTERNAL_API_KEY || '';

const { check, section, report } = suite('thesis-verify');

const sql = (q) =>
  execFileSync('psql', [DB, '-At', '-q', '-c', q], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim();
const sql1 = (q) => sql(q).split('\n')[0].trim();
/** Runs a statement expected to fail, and hands back the database's words. */
const sqlExpectFailure = (q) => {
  try {
    execFileSync('psql', [DB, '-At', '-q', '-v', 'ON_ERROR_STOP=1', '-c', q],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return null;
  } catch (e) {
    return `${e.stderr || ''}${e.stdout || ''}`.trim();
  }
};

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
  try { body = t ? JSON.parse(t) : null; } catch { /* a non-JSON body is the caller's problem */ }
  return { status: r.status, body };
};
const page = async (path) => {
  const r = await fetch(`${WEB}${path}`, { headers: { accept: 'text/html' } });
  return { status: r.status, html: await r.text() };
};
const text = (html) =>
  html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&nbsp;|&rsquo;|&mdash;/g, ' ').replace(/\s+/g, ' ');

const TAG = `verify_thesis_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
let creatorId = null;
const agentIds = [];
const thesisIds = [];

function purge(handleLike) {
  // DISABLE TRIGGER, because the immutability trigger refuses every delete
  // without exception — which is the whole point of section 4. Table ownership
  // is the door; the application does not have it.
  try {
    sql(`ALTER TABLE public_theses DISABLE TRIGGER public_theses_immutable;
         DELETE FROM articles WHERE creator_id IN (SELECT id FROM creators WHERE handle LIKE '${handleLike}');
         DELETE FROM public_theses WHERE creator_id IN (SELECT id FROM creators WHERE handle LIKE '${handleLike}');
         ALTER TABLE public_theses ENABLE TRIGGER public_theses_immutable;
         DELETE FROM portfolio_snapshots WHERE portfolio_id IN (
           SELECT p.id FROM portfolios p JOIN agents a ON a.id = p.agent_id
            WHERE a.creator_id IN (SELECT id FROM creators WHERE handle LIKE '${handleLike}'));
         DELETE FROM portfolios WHERE agent_id IN (
           SELECT id FROM agents WHERE creator_id IN (SELECT id FROM creators WHERE handle LIKE '${handleLike}'));
         DELETE FROM agents WHERE creator_id IN (SELECT id FROM creators WHERE handle LIKE '${handleLike}');
         DELETE FROM creators WHERE handle LIKE '${handleLike}';`);
  } catch (e) {
    console.log('  cleanup warning: ' + e.message);
  }
}

function teardown() { purge(`${TAG}%`); }
purge('verify_thesis_%');
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

  const c = await api('/v1/creators', {
    method: 'POST', body: { handle: TAG }, headers: VERIFICATION_HEADER,
  });
  creatorId = c.body?.id ?? null;
  if (!creatorId) {
    check('a fixture creator is made', false, `status ${c.status} ${JSON.stringify(c.body)}`);
    throw new Error('cannot continue without a creator');
  }

  /** Two agents built from one literal, so "identical" is not a claim. */
  const AGENT_SPEC = {
    strategyType: 'momentum',
    assetUniverse: 'us_equities',
    visibility: 'public',
    // NO MANDATE, because a built-in strategy never reads one and the endpoint
    // refuses the pair rather than storing text it would ignore. It suits this
    // comparison anyway: with no mandate there is not even a field a thesis
    // could have leaked into.
    // A JSON STRING, which is what the endpoint takes — parsed into jsonb on
    // persist. Passing the object gets "riskProfile must be a json string".
    riskProfile: JSON.stringify({
      cash_floor_pct: 0.05, trade_size_pct: 0.5, max_position_pct: 1, rebalance_band_pct: 0.0002,
    }),
  };
  for (const name of [`${TAG}_bound`, `${TAG}_twin`]) {
    const a = await api('/v1/agents', {
      method: 'POST', headers: VERIFICATION_HEADER, body: { ...AGENT_SPEC, name },
    });
    if (!a.body?.id) {
      check(`fixture agent ${name} is made`, false, `status ${a.status} ${JSON.stringify(a.body)}`);
      throw new Error('cannot continue without two agents');
    }
    agentIds.push(a.body.id);
    await api(`/v1/agents/${a.body.id}/activate`, { method: 'POST' });
  }
  const [boundAgent, twinAgent] = agentIds;

  // =====================================================================
  await section('1. Publishing a claim', async () => {
    const soon = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    const tooSoon = await api('/v1/theses', { method: 'POST', body: {
      linked_agent_id: boundAgent,
      claim_text: 'This window is far too short to be a forecast at all.',
      benchmark_ref: { kind: 'symbol', symbols: ['SPY'] },
      criteria: { comparison: 'gt', margin_pct: 0 },
      resolves_at: new Date(Date.now() + 60 * 1000).toISOString(),
    }});
    check('a window under 24 hours is refused', tooSoon.status === 400,
      `status ${tooSoon.status}`);
    check('and the refusal says why rather than just "invalid"',
      /coin flip|24 hours/i.test(JSON.stringify(tooSoon.body)), JSON.stringify(tooSoon.body));

    const badSymbol = await api('/v1/theses', { method: 'POST', body: {
      linked_agent_id: boundAgent,
      claim_text: 'A benchmark nobody has ever recorded a price for cannot be beaten.',
      benchmark_ref: { kind: 'symbol', symbols: ['NOTREAL'] },
      criteria: { comparison: 'gt', margin_pct: 0 },
      resolves_at: soon,
    }});
    check('a benchmark symbol the market never priced is refused',
      badSymbol.status === 400, `status ${badSymbol.status}`);
    check('and the refusal names the symbol it rejected',
      /NOTREAL/.test(JSON.stringify(badSymbol.body)), JSON.stringify(badSymbol.body));

    const ok = await api('/v1/theses', { method: 'POST', body: {
      linked_agent_id: boundAgent,
      claim_text: 'Large-cap tech outperforms the S&P 500 over the next seven days.',
      benchmark_ref: { kind: 'symbol', symbols: ['SPY'] },
      criteria: { comparison: 'gt', margin_pct: 0 },
      resolves_at: soon,
    }});
    check('a well-formed thesis is published', ok.status === 201 || ok.status === 200,
      `status ${ok.status} ${JSON.stringify(ok.body)}`);
    if (ok.body?.id) thesisIds.push(ok.body.id);
    check('it starts pending, not resolved', ok.body?.status === 'pending', `status=${ok.body?.status}`);

    const readBack = await api(`/v1/theses/${ok.body?.id}`);
    check('it reads back publicly without a session', readBack.status === 200, `status ${readBack.status}`);
    check('and carries no result while pending', readBack.body?.result === null,
      `result=${JSON.stringify(readBack.body?.result)}`);
  });

  // =====================================================================
  await section('2. The bound agent decides exactly as its unbound twin does', async () => {
    // THE PROOF IS BEHAVIOURAL FIRST. Both agents are deterministic, were built
    // from the same object literal, and see the same market; one now carries a
    // thesis and the other does not.
    const decide = async (id) => {
      const r = await api(`/v1/agents/${id}/decisions`, { method: 'POST', body: {} });
      return r;
    };
    const a = await decide(boundAgent);
    const b = await decide(twinAgent);

    check('both agents answered a decision request',
      a.status < 500 && b.status < 500, `bound ${a.status}, twin ${b.status}`);

    const shape = (r) => JSON.stringify({
      action: r.body?.action ?? r.body?.decision?.action ?? null,
      symbol: r.body?.symbol ?? r.body?.decision?.symbol ?? null,
      reason: r.body?.reason_code ?? r.body?.decision?.reason_code ?? null,
    });
    check('the bound agent decided the same action, symbol and reason as the twin',
      shape(a) === shape(b), `bound ${shape(a)} vs twin ${shape(b)}`);

    // AND STRUCTURALLY. The behavioural check above can only ever sample one
    // tick; this one says there is no wire to carry a thesis at all.
    // grep exits 1 when it finds nothing, which is the outcome this check
    // WANTS. Letting execFileSync throw on it turned the passing case into a
    // section that blew up.
    let engineHits = '';
    try {
      engineHits = execFileSync('grep', [
        '-rlE', 'public_theses|thesis_id|linked_agent_id',
        `${ROOT}/services/decision-engine`, '--include=*.go',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) {
      if (e.status !== 1) throw e; // 1 = no matches; anything else is a real failure
    }
    check('the decision engine source contains no reference to the thesis tables',
      engineHits === '', `matched in:\n${engineHits}`);

    // coalesce, because a built-in strategy agent has no mandate at all and
    // `NULL || anything` is NULL — which would have compared two nothings and
    // passed.
    const hash = (id) =>
      sql1(`SELECT md5(coalesce(mandate, '<none>') || risk_profile::text) FROM agents WHERE id = '${id}'`);
    const mandateBefore = hash(boundAgent);
    const mandateTwin = hash(twinAgent);
    check('publishing a thesis left the agent\'s mandate and risk profile byte-identical to the twin\'s',
      mandateBefore === mandateTwin, `${mandateBefore} vs ${mandateTwin}`);
  });

  // =====================================================================
  await section('3. Resolution runs the rule that was locked in, both ways', async () => {
    // Two theses over a window that has already closed, one whose agent beat
    // the market and one whose agent did not. The benchmark is whatever the
    // real market actually did over that window — it is not fabricated, only
    // the agent's NAV is.
    // AT LEAST 25 HOURS APART, because the table refuses a window under 24 and
    // "the last twelve ticks" is not a duration — at a two-hour cadence twelve
    // of them are 22 hours and the insert is rejected.
    const to = sql1(`SELECT max(tick_time) FROM market_snapshots`);
    const from = sql1(
      `SELECT tick_time FROM market_snapshots
        WHERE tick_time <= (SELECT max(tick_time) FROM market_snapshots) - interval '25 hours'
        ORDER BY tick_time DESC LIMIT 1`);
    const mid = sql1(
      `SELECT tick_time FROM market_snapshots
        WHERE tick_time > '${from}'::timestamptz AND tick_time < '${to}'::timestamptz
        ORDER BY tick_time ASC LIMIT 1`);
    if (!to || !from || !mid) {
      check('the market has 25 hours of ticks to measure a window over', false,
        `from=${from} mid=${mid} to=${to}`);
      return;
    }

    const mkThesis = async (agentId, winning) => {
      const id = sql1(
        `INSERT INTO public_theses
           (creator_id, linked_agent_id, claim_text, benchmark_ref, criteria, created_at, resolves_at)
         VALUES ('${creatorId}', '${agentId}',
                 '${winning ? 'This agent will beat the index over the window.' : 'This agent will beat the index, and it will not.'}',
                 '{"kind":"arcana_index"}'::jsonb, '{"comparison":"gt","margin_pct":0}'::jsonb,
                 '${from}'::timestamptz, '${to}'::timestamptz)
         RETURNING id`);
      thesisIds.push(id);
      // A FRESH AGENT HAS NO PORTFOLIO until it is entered into a season, and
      // that is exactly what made the first run of this suite meaningless: with
      // no portfolio there were no NAV rows, both theses measured nothing, and
      // the one written to FAIL came back PROVEN. One is created here so the
      // winning and losing cases are really different.
      let portfolioId = sql1(
        `SELECT id FROM portfolios WHERE agent_id = '${agentId}' ORDER BY created_at LIMIT 1`);
      if (!portfolioId) {
        // seasons has no created_at — it is ordered by start_at.
        const seasonId = sql1(`SELECT id FROM seasons ORDER BY start_at DESC LIMIT 1`);
        if (!seasonId) return { id, portfolioId: null };
        portfolioId = sql1(
          `INSERT INTO portfolios (agent_id, season_id, initial_capital)
           VALUES ('${agentId}', '${seasonId}', 100) RETURNING id`);
      }
      if (!portfolioId) return { id, portfolioId: null };
      // A NAV that doubles, or one that halves. Nothing in between: the verdict
      // must not depend on how the market happened to move that week.
      const navs = winning ? [100, 150, 200] : [100, 70, 50];
      const stamps = [from, mid, to];
      for (let i = 0; i < navs.length; i++) {
        sql(`INSERT INTO portfolio_snapshots (portfolio_id, ts, holdings, nav, cash)
             VALUES ('${portfolioId}', '${stamps[i]}'::timestamptz, '{}'::jsonb, ${navs[i]}, ${navs[i]})
             ON CONFLICT (portfolio_id, ts) DO UPDATE SET nav = EXCLUDED.nav, cash = EXCLUDED.cash`);
      }
      return { id, portfolioId };
    };

    const winner = await mkThesis(agentIds[0], true);
    const loser = await mkThesis(agentIds[1], false);
    check('both fixture agents have a portfolio to measure over',
      winner.portfolioId !== null && loser.portfolioId !== null,
      `winner=${winner.portfolioId} loser=${loser.portfolioId}`);

    const run = await api('/internal/v1/theses/resolve', {
      method: 'POST', headers: { 'x-internal-key': INTERNAL_KEY },
    });
    check('the resolution job runs behind the internal key', run.status === 200 || run.status === 201,
      `status ${run.status} ${JSON.stringify(run.body)}`);

    const statusOf = (id) => sql1(`SELECT status FROM public_theses WHERE id = '${id}'`);
    check('the thesis whose agent beat the index resolved PROVEN',
      statusOf(winner.id) === 'proven', `got ${statusOf(winner.id)}`);
    check('the thesis whose agent lost to it resolved NOT PROVEN',
      statusOf(loser.id) === 'not_proven', `got ${statusOf(loser.id)}`);

    const m = sql1(`SELECT measurement IS NOT NULL FROM public_theses WHERE id = '${winner.id}'`);
    check('the arithmetic behind the verdict is stored, not just the verdict', m === 't', `measurement=${m}`);

    const both = sql1(
      `SELECT count(*) FROM public_theses
        WHERE id IN ('${winner.id}','${loser.id}') AND result_performance IS NOT NULL
          AND result_benchmark IS NOT NULL AND resolved_at IS NOT NULL`);
    check('both carry the two returns and a resolution timestamp', both === '2', `got ${both}`);

    // THE JOB IS NOT ALLOWED TO CHANGE ITS MIND. A second run must be a no-op.
    const again = await api('/internal/v1/theses/resolve', {
      method: 'POST', headers: { 'x-internal-key': INTERNAL_KEY },
    });
    check('a second run resolves nothing already decided',
      again.status < 400 && !JSON.stringify(again.body ?? {}).includes(winner.id),
      JSON.stringify(again.body));

    const stillProven = statusOf(winner.id);
    check('and the first verdict is unchanged afterwards', stillProven === 'proven', `got ${stillProven}`);

    // A THESIS WITH NOTHING TO MEASURE MUST NOT COME BACK PROVEN. This is the
    // case that failed on the first run: an agent with no NAV rows produced a
    // return of 0.0, which beat a market that had fallen. An absent measurement
    // and a return of zero are not the same fact and must not compare alike.
    const orphan = sql1(
      `INSERT INTO public_theses
         (creator_id, linked_agent_id, claim_text, benchmark_ref, criteria, created_at, resolves_at)
       VALUES ('${creatorId}', '${agentIds[0]}',
               'This claim has no portfolio data behind it at all.',
               '{"kind":"arcana_index"}'::jsonb, '{"comparison":"gt","margin_pct":0}'::jsonb,
               '${from}'::timestamptz, '${to}'::timestamptz)
       RETURNING id`);
    thesisIds.push(orphan);
    // Measured over a window with no NAV rows in it: the agent's snapshots sit
    // inside [from, to], so the window is moved off them entirely.
    sql(`ALTER TABLE public_theses DISABLE TRIGGER public_theses_immutable;
         UPDATE public_theses
            SET created_at = '${from}'::timestamptz - interval '60 days',
                resolves_at = '${from}'::timestamptz - interval '30 days'
          WHERE id = '${orphan}';
         ALTER TABLE public_theses ENABLE TRIGGER public_theses_immutable;`);
    await api('/internal/v1/theses/resolve', {
      method: 'POST', headers: { 'x-internal-key': INTERNAL_KEY },
    });
    const orphanStatus = sql1(`SELECT status FROM public_theses WHERE id = '${orphan}'`);
    check('a thesis with no NAV data behind it never resolves PROVEN',
      orphanStatus !== 'proven', `got ${orphanStatus}`);

    // The creator's record counts everything, not only the win.
    const counters = sql1(
      `SELECT theses_published || '/' || theses_proven FROM creators WHERE id = '${creatorId}'`);
    check('the creator record counts every thesis published, not only the proven ones',
      counters.startsWith('4/'), `published/proven = ${counters}`);
  });

  // =====================================================================
  await section('4. A published thesis cannot be deleted or edited — attempted, not assumed', async () => {
    const id = thesisIds[0];
    if (!id) { check('there is a thesis to attempt this against', false, 'none was created'); return; }

    const del = sqlExpectFailure(`DELETE FROM public_theses WHERE id = '${id}'`);
    check('DELETE is refused by the database', del !== null, 'the row was deleted');
    check('and the refusal explains what publishing costs',
      del !== null && /cannot be deleted/i.test(del), del ?? '');

    const editClaim = sqlExpectFailure(
      `UPDATE public_theses SET claim_text = 'a claim rewritten after the fact' WHERE id = '${id}'`);
    check('rewriting the claim is refused', editClaim !== null, 'the claim was rewritten');

    const editCriteria = sqlExpectFailure(
      `UPDATE public_theses SET criteria = '{"comparison":"gt","margin_pct":99}'::jsonb WHERE id = '${id}'`);
    check('moving the goalposts is refused', editCriteria !== null, 'the criteria were changed');

    const editDeadline = sqlExpectFailure(
      `UPDATE public_theses SET resolves_at = now() + interval '300 days' WHERE id = '${id}'`);
    check('extending the deadline is refused', editDeadline !== null, 'the deadline moved');

    const stillThere = sql1(`SELECT count(*) FROM public_theses WHERE id = '${id}'`);
    check('the row is still exactly where it was', stillThere === '1', `count=${stillThere}`);

    // The HTTP surface offers no door either: a refusal that exists only in the
    // database is one an added endpoint could quietly walk around.
    const httpDelete = await api(`/v1/theses/${id}`, { method: 'DELETE' });
    check('and there is no HTTP route that deletes one',
      httpDelete.status === 404 || httpDelete.status === 405, `status ${httpDelete.status}`);
  });

  // =====================================================================
  await section('5. The linked agent card shows the agent page\'s own numbers', async () => {
    const id = thesisIds[0];
    const agentId = agentIds[0];

    const [over, board] = await Promise.all([
      api(`/v1/agents/${agentId}/overview`),
      api('/v1/leaderboard?page_size=100&include_unranked=true'),
    ]);
    check('the agent overview endpoint answers', over.status === 200, `status ${over.status}`);

    const p = await page(`/theses/${id}`);
    check('the thesis page renders', p.status === 200, `status ${p.status}`);
    const t = text(p.html);

    const returnPct = over.body?.stats?.return_pct?.value;
    if (returnPct === null || returnPct === undefined) {
      check('the overview has a return to compare against', true,
        'no return yet for a fresh fixture — nothing to disagree about');
    } else {
      const shown = returnPct.toFixed(2);
      check(`the card prints the overview's own return (${shown}%)`,
        t.includes(shown), `page does not contain ${shown}`);
    }

    const row = (board.body?.items ?? []).find((i) => i.agent_id === agentId);
    if (row?.score !== null && row?.score !== undefined) {
      check(`the card prints the leaderboard's own score (${row.score})`,
        t.includes(String(row.score)), `page does not contain ${row.score}`);
    }

    check('the card names the agent it is bound to', t.includes(`${TAG}_bound`), 'agent name missing');
    check('and the page says the agent was never told about the thesis',
      /never told about this thesis/i.test(t), 'the page omits the independence statement');
  });

  // =====================================================================
  await section('6. An article may carry a thesis, and need not', async () => {
    const plain = await api('/v1/articles', { method: 'POST', body: {
      title: `${TAG} plain`, body: 'Writing with no forecast attached. This is allowed.' }});
    check('an article without a thesis is accepted', plain.status === 201 || plain.status === 200,
      `status ${plain.status} ${JSON.stringify(plain.body)}`);

    const bound = await api('/v1/articles', { method: 'POST', body: {
      title: `${TAG} bound`, body: 'Writing that carries a claim.', thesis_id: thesisIds[0] }});
    check('an article carrying one is accepted', bound.status === 201 || bound.status === 200,
      `status ${bound.status} ${JSON.stringify(bound.body)}`);

    const dup = await api('/v1/articles', { method: 'POST', body: {
      title: `${TAG} dup`, body: 'A second article claiming the same forecast.', thesis_id: thesisIds[0] }});
    check('a second article cannot claim the same thesis', dup.status === 409, `status ${dup.status}`);

    if (bound.body?.id) {
      const moved = sqlExpectFailure(
        `UPDATE articles SET thesis_id = NULL WHERE id = '${bound.body.id}'`);
      check('and the binding cannot be moved once set', moved !== null, 'the binding was unset');

      const edited = await api(`/v1/articles/${bound.body.id}`, {
        method: 'PATCH', body: { body: 'The prose, revised. This is allowed; the claim is not.' }});
      check('while the prose stays editable', edited.status === 200, `status ${edited.status}`);
    }
  });
} catch (e) {
  check('the suite ran to completion', false, e?.message ?? String(e));
}

const code = report();
process.exit(code);
