import { DataSource } from 'typeorm';

export const CREATOR_REPUTATION_V1 = 'arcana-creator-reputation/v1';

/**
 * CREATOR REPUTATION, DERIVED FROM SEALED SCORES — never a stored number.
 *
 * `creators.reputation_score` was a column that defaulted to 0 and that nothing
 * ever wrote. Every creator showed 0.00 as "creator reputation": a figure with
 * no calculation behind it, the class of number this platform keeps removing.
 * It is no longer read anywhere.
 *
 * What replaces it uses no new weight and no new idea. It is the arithmetic the
 * ARCANA Score already uses for a creator — the mean of performance scores —
 * applied to the creator's own agents and restricted to scores that are SEALED,
 * so every input can be checked against its manifest and its anchor:
 *
 *   for each ACTIVE agent of the creator, take its latest sealed score snapshot;
 *   reputation = mean of their performance_score, added in agent id order;
 *   no active agent with a sealed score -> not measured (null), never 0.
 */
export type CreatorReputation = {
  version: string;
  value: number | null;
  status: 'measured' | 'not_measured';
  note: string;
  agents: Array<{
    agent_id: string;
    name: string;
    score_ts: string;
    season_id: string;
    performance_score: number;
    seal: string;
    anchored: boolean;
    verify: string;
  }>;
  excluded: Array<{ agent_id: string; name: string; status: string; reason: string }>;
  formula: string[];
  how_to_check: string;
};

export const CREATOR_REPUTATION_FORMULA = [
  'Take every agent of the creator whose status is active.',
  'For each, take its latest score snapshot that carries a seal (any season).',
  'reputation = the mean of their performance_score values, added in agent id order.',
  'An agent with no sealed score is left out and listed as excluded. With none left, reputation is not measured: null, never 0.',
];

export async function creatorReputation(db: DataSource, creatorId: string): Promise<CreatorReputation> {
  const rows: Array<{
    agent_id: string;
    name: string;
    status: string;
    score_ts: string | null;
    season_id: string | null;
    performance_score: string | null;
    seal: string | null;
    anchored: boolean | null;
  }> = await db.query(
    `SELECT a.id::text AS agent_id, a.name, a.status,
            to_char(s.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS score_ts,
            s.season_id::text AS season_id, s.performance_score::text AS performance_score,
            trim(s.seal) AS seal,
            EXISTS (SELECT 1 FROM decision_anchor_leaves l JOIN decision_anchors x ON x.id = l.anchor_id
                     WHERE l.commitment = s.seal AND x.status = 'mined') AS anchored
       FROM agents a
       LEFT JOIN LATERAL (
         SELECT ts, season_id, performance_score, seal FROM score_snapshots
          WHERE agent_id = a.id AND seal IS NOT NULL
          ORDER BY ts DESC LIMIT 1) s ON true
      WHERE a.creator_id = $1
      ORDER BY a.id`,
    [creatorId],
  );

  const agents: CreatorReputation['agents'] = [];
  const excluded: CreatorReputation['excluded'] = [];
  for (const r of rows) {
    if (r.status !== 'active') {
      excluded.push({ agent_id: r.agent_id, name: r.name, status: r.status, reason: `not active (${r.status})` });
    } else if (!r.seal || r.performance_score === null || !r.score_ts || !r.season_id) {
      excluded.push({ agent_id: r.agent_id, name: r.name, status: r.status, reason: 'no sealed score yet' });
    } else {
      agents.push({
        agent_id: r.agent_id,
        name: r.name,
        score_ts: r.score_ts,
        season_id: r.season_id,
        performance_score: Number(r.performance_score),
        seal: r.seal,
        anchored: r.anchored === true,
        verify: `/v1/agents/${r.agent_id}/score/verification?season_id=${r.season_id}&ts=${encodeURIComponent(r.score_ts)}`,
      });
    }
  }

  let value: number | null = null;
  if (agents.length > 0) {
    let sum = 0;
    for (const a of agents) sum += a.performance_score;
    value = sum / agents.length;
  }

  return {
    version: CREATOR_REPUTATION_V1,
    value,
    status: value === null ? 'not_measured' : 'measured',
    note:
      value === null
        ? 'Not measured: no active agent of this creator has a sealed score yet. Scores are sealed from the first scoring run after 2026-09-14; nothing earlier is sealed or backfilled.'
        : `The mean performance score of ${agents.length} active agent(s), each from its latest sealed score.`,
    agents,
    excluded,
    formula: CREATOR_REPUTATION_FORMULA,
    how_to_check:
      'For each listed agent, open its verification link: recompute that score from its manifest and check its seal against the anchor. Then add the performance_score values in the order listed and divide by their count.',
  };
}
