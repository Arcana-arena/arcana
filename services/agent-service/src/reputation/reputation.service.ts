import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AnchorsService } from '../intelligence/anchors.service';
import { creatorReputation } from './creator-reputation';
import { FORMULAS, parseScoreManifest, recomputeV1, SCORE_FORMULA_V1, ScoreManifest, ScoreOutputs } from './score-formula';

type Check = { name: string; ok: boolean; detail?: string };

const US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

const SCORE_COLUMNS: Array<[keyof ScoreOutputs, string]> = [
  ['arcana', 'arcana_score'],
  ['performance', 'performance_score'],
  ['risk', 'risk_score'],
  ['strategy', 'strategy_score'],
  ['regime', 'regime_score'],
  ['consistency', 'consistency_score'],
  ['creator', 'creator_score'],
  ['longevity', 'longevity_score'],
];

const HOW_TO_RECOMPUTE = [
  'Fetch the manifest (manifest.body). sha256 of its exact bytes must equal the score\'s seal.',
  'Read it line by line: the first line is arcana-score/v1; every other line is `key: <JSON>`.',
  'Check every input against the record: each nav_series row is a portfolio snapshot of this agent in this season (same ts, nav, cash and seal); each decision exists with that action and commitment; each creator_peers row is a score snapshot with that performance_score and seal.',
  'Check each sealed input against the chain with GET /v1/anchors/leaves/:seal (or the decision anchor endpoint), and the snapshot manifests themselves: sha256 of each snapshot manifest equals its seal.',
  'Follow the steps of the formula version the manifest names (GET /v1/score-formulas/:version) using the manifest\'s constants. Every output must come out equal, not approximately equal.',
  'Check the score\'s own seal against its anchor. That root was written only after every sealed input was already in a mined anchor.',
];

/**
 * A score, with everything needed to compute it again.
 *
 * WHAT THIS DOES NOT ASK YOU TO TRUST. It returns the manifest the scoring
 * engine sealed, recomputes that score here with the manifest's own constants
 * (a second implementation of the formula), checks every input the manifest
 * names against the records it names, and shows where each seal is on chain.
 * The checks are listed one by one; a reader can repeat every one of them
 * without ARCANA, and the steps say how.
 */
@Injectable()
export class ReputationService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly anchors: AnchorsService,
  ) {}

  formula(version: string) {
    const f = FORMULAS[version];
    if (!f) {
      throw new NotFoundException({
        code: 'unknown_formula_version',
        message: `No score formula '${version}'. Published: ${Object.keys(FORMULAS).join(', ')}.`,
      });
    }
    return { ...f, how_to_recompute: HOW_TO_RECOMPUTE };
  }

  async creatorReputation(creatorId: string) {
    const c = await this.db.query(`SELECT id::text, handle FROM creators WHERE id = $1`, [creatorId]);
    if (c.length === 0) throw new NotFoundException(`Creator ${creatorId} not found`);
    return { creator: { id: c[0].id, handle: c[0].handle }, ...(await creatorReputation(this.db, creatorId)) };
  }

  async scoreVerification(agentId: string, seasonId?: string, ts?: string) {
    const agent = await this.db.query(`SELECT id::text, name FROM agents WHERE id = $1`, [agentId]);
    if (agent.length === 0) throw new NotFoundException(`Agent ${agentId} not found`);

    const params: unknown[] = [agentId];
    let where = 'agent_id = $1 AND seal IS NOT NULL';
    if (seasonId) {
      params.push(seasonId);
      where += ` AND season_id = $${params.length}`;
    }
    if (ts) {
      params.push(ts);
      where += ` AND ts = $${params.length}::timestamptz`;
    }
    const rows: Array<Record<string, string | null>> = await this.db.query(
      `SELECT season_id::text, to_char(ts AT TIME ZONE 'UTC', ${US}) AS ts, trim(seal) AS seal, seal_scheme,
              arcana_score::text, performance_score::text, risk_score::text, strategy_score::text,
              regime_score::text, consistency_score::text, creator_score::text, longevity_score::text
         FROM score_snapshots WHERE ${where} ORDER BY ts DESC LIMIT 1`,
      params,
    );
    const recent: Array<{ season_id: string; ts: string; arcana_score: string | null }> = await this.db.query(
      `SELECT season_id::text, to_char(ts AT TIME ZONE 'UTC', ${US}) AS ts, arcana_score::text
         FROM score_snapshots WHERE agent_id = $1 AND seal IS NOT NULL ORDER BY ts DESC LIMIT 10`,
      [agentId],
    );

    if (rows.length === 0) {
      const latest = await this.db.query(
        `SELECT to_char(ts AT TIME ZONE 'UTC', ${US}) AS ts FROM score_snapshots WHERE agent_id = $1 ORDER BY ts DESC LIMIT 1`,
        [agentId],
      );
      return {
        agent: agent[0],
        status: 'not_sealed' as const,
        note: latest.length
          ? `This agent has no sealed score${ts || seasonId ? ' matching that request' : ''}. Its latest score (${latest[0].ts}) was written before scores were sealed, so there is no manifest to recompute it from. Scores are sealed from the first scoring run after 2026-09-14; nothing earlier is sealed or backfilled.`
          : 'This agent has never been scored.',
        other_sealed_scores: recent,
      };
    }

    const row = rows[0];
    const seal = row.seal as string;
    const bodyRows = await this.db.query(`SELECT body FROM decision_evidence WHERE hash = $1`, [seal]);
    const body: string | null = bodyRows[0]?.body ?? null;

    const checks: Check[] = [];
    const push = (name: string, ok: boolean, detail?: string) => checks.push(ok ? { name, ok } : { name, ok, detail });

    push('the manifest is stored', body !== null, 'no body is stored under this seal');
    if (body === null) {
      return { agent: agent[0], status: 'broken' as const, seal, checks, other_sealed_scores: recent };
    }
    const bodySha = createHash('sha256').update(body, 'utf8').digest('hex');
    push('sha256 of the manifest equals the seal', bodySha === seal, `sha256 ${bodySha}`);

    let m: ScoreManifest;
    try {
      m = parseScoreManifest(body);
    } catch (e) {
      push('the manifest reads as arcana-score/v1', false, e instanceof Error ? e.message : String(e));
      return { agent: agent[0], status: 'broken' as const, seal, checks, manifest: { body }, other_sealed_scores: recent };
    }
    push('the manifest names this agent, season and time',
      m.agent_id === agentId && m.season_id === row.season_id && m.ts === row.ts,
      `${m.agent_id} ${m.season_id} ${m.ts}`);

    const published = FORMULAS[m.formula];
    push(`the formula version ${m.formula} is published`, !!published);
    if (published) {
      push('the constants in the manifest are the published constants of that version',
        JSON.stringify(sortKeys(m.constants)) === JSON.stringify(sortKeys(published.constants)),
        JSON.stringify(m.constants));
    }

    // ---- recompute, with the manifest's own constants
    const recomputed = m.formula === SCORE_FORMULA_V1 ? recomputeV1(m) : null;
    if (recomputed) {
      for (const [key] of SCORE_COLUMNS) {
        push(`recomputed ${key} equals the manifest`, recomputed.outputs[key] === m.outputs[key],
          `recomputed ${recomputed.outputs[key]}, manifest ${m.outputs[key]}`);
      }
      push('recomputed strategy multiplier and ranked equal the manifest',
        recomputed.outputs.strategy_multiplier === m.outputs.strategy_multiplier && recomputed.outputs.ranked === m.outputs.ranked);
    }
    for (const [key, col] of SCORE_COLUMNS) {
      const stored = row[col];
      const out = m.outputs[key] as number | null;
      const ok = stored === null ? out === null : out !== null && Math.abs(Number(stored) - out) <= 0.005 + 1e-9;
      push(`the stored ${col} is the manifest's ${key} at two decimals`, ok, `stored ${stored}, manifest ${out}`);
    }

    // ---- every input against the record
    const snaps: Array<{ ts: string; nav: string; cash: string; seal: string | null }> = await this.db.query(
      `SELECT to_char(ps.ts AT TIME ZONE 'UTC', ${US}) AS ts, ps.nav::text, ps.cash::text, trim(ps.seal) AS seal
         FROM portfolio_snapshots ps JOIN portfolios p ON p.id = ps.portfolio_id
        WHERE p.agent_id = $1 AND p.season_id = $2 AND ps.ts <= $3::timestamptz
        ORDER BY ps.ts`,
      [agentId, m.season_id, m.ts],
    );
    const navMismatch = m.nav_series.filter((p, i) => {
      const s = snaps[i];
      return !s || s.ts !== p.ts || s.nav !== p.nav || s.cash !== p.cash || (s.seal ?? null) !== (p.seal ?? null);
    }).length;
    push('every snapshot in the NAV series is the recorded snapshot, in order', navMismatch === 0, `${navMismatch} differ`);
    push('and no snapshot recorded before the score is missing from it', snaps.length === m.nav_series.length,
      `${snaps.length} recorded, ${m.nav_series.length} listed`);

    const ids = m.decisions.map((d) => d.id);
    const decs: Array<{ id: string; ts: string; action: string; commitment: string | null }> = ids.length
      ? await this.db.query(
          `SELECT id::text, to_char(ts AT TIME ZONE 'UTC', ${US}) AS ts, action, trim(commitment) AS commitment
             FROM decisions -- raw-by-design: listed decisions later marked as artefacts still exist and are still checked
            WHERE agent_id = $1 AND season_id = $2 AND id = ANY($3::bigint[])`,
          [agentId, m.season_id, ids],
        )
      : [];
    const byId = new Map(decs.map((d) => [Number(d.id), d]));
    const decMismatch = m.decisions.filter((d) => {
      const r = byId.get(d.id);
      return !r || r.ts !== d.ts || r.action !== d.action || (r.commitment ?? null) !== (d.commitment ?? null);
    }).length;
    push('every counted decision exists with that time, action and commitment', decMismatch === 0, `${decMismatch} differ or are missing`);
    const missed = await this.db.query(
      `SELECT count(*)::int AS n FROM decisions_counted
        WHERE agent_id = $1 AND season_id = $2 AND ts <= $3::timestamptz AND NOT (id = ANY($4::bigint[]))`,
      [agentId, m.season_id, m.ts, ids],
    );
    push('no decision counted today before the score is missing from it', missed[0].n === 0, `${missed[0].n} not listed`);

    // ONE QUERY FOR EVERY PEER ROW, in listed order. The creator factor averages
    // every score snapshot of the creator's other active agents, which is
    // hundreds of rows for a long-running creator; a query per row made this
    // endpoint as slow as the list is long.
    let peerMismatch = 0;
    if (m.creator_peers.length) {
      const found: Array<{ performance_score: string | null; seal: string | null }> = await this.db.query(
        `SELECT ss.performance_score::text AS performance_score, trim(ss.seal) AS seal
           FROM unnest($1::uuid[], $2::uuid[], $3::timestamptz[]) WITH ORDINALITY AS x(agent_id, season_id, ts, n)
           LEFT JOIN score_snapshots ss ON ss.agent_id = x.agent_id AND ss.season_id = x.season_id AND ss.ts = x.ts
          ORDER BY x.n`,
        [m.creator_peers.map((p) => p.agent_id), m.creator_peers.map((p) => p.season_id), m.creator_peers.map((p) => p.ts)],
      );
      m.creator_peers.forEach((p, i) => {
        const r = found[i];
        if (!r || r.performance_score === null || Number(r.performance_score) !== p.performance_score || (r.seal ?? null) !== (p.seal ?? null)) {
          peerMismatch++;
        }
      });
    }
    push('every creator peer score exists with that performance score and seal', peerMismatch === 0, `${peerMismatch} differ or are missing`);

    // ---- which inputs are sealed, and which of those are on chain
    const navSeals = m.nav_series.map((p) => p.seal).filter((s): s is string => !!s);
    const decSeals = m.decisions.map((d) => d.commitment).filter((s): s is string => !!s);
    const peerSeals = m.creator_peers.map((p) => p.seal).filter((s): s is string => !!s);
    const mined = await this.anchors.minedSeals([...new Set([...navSeals, ...decSeals, ...peerSeals])]);
    const coverage = (label: string, total: number, sealed: string[]) => ({
      input: label,
      total,
      sealed: sealed.length,
      anchored: sealed.filter((s) => mined.has(s)).length,
      unsealed_note:
        total - sealed.length > 0
          ? `${total - sealed.length} ${label} predate sealing. They are listed and recomputed, but only the database vouches for them; nothing is sealed afterwards.`
          : null,
    });

    const scoreAnchor = await this.anchors.proofBySeal(seal, 'this score\'s seal');
    const failed = checks.filter((c) => !c.ok);

    return {
      agent: agent[0],
      status: failed.length === 0 ? ('verified' as const) : ('mismatch' as const),
      summary: `${checks.length - failed.length} of ${checks.length} checks pass`,
      score: {
        season_id: row.season_id,
        ts: row.ts,
        seal,
        seal_scheme: row.seal_scheme,
        stored: Object.fromEntries(SCORE_COLUMNS.map(([, col]) => [col, row[col] === null ? null : Number(row[col])])),
      },
      formula: { version: m.formula, url: `/v1/score-formulas/${m.formula}` },
      outputs: m.outputs,
      recomputed: recomputed?.outputs ?? null,
      working: recomputed?.working ?? null,
      coverage: [
        coverage('portfolio snapshots', m.nav_series.length, navSeals),
        coverage('decisions', m.decisions.length, decSeals),
        coverage('creator peer scores', m.creator_peers.length, peerSeals),
      ],
      checks,
      anchor: scoreAnchor,
      manifest: { sha256: bodySha, bytes: Buffer.byteLength(body, 'utf8'), body, parsed: m },
      how_to_recompute: HOW_TO_RECOMPUTE,
      other_sealed_scores: recent,
    };
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}
