/**
 * Seating: how an active agent gets into the competition that is running.
 *
 * WHY THIS EXISTS. Every path that took a seat away had been written —
 * retirement hands one back, succession hands one over, withdrawal gives one up
 * — and no path ever GAVE one out except a competition being created with the
 * agent already listed. The result was an agent that was `active`, held a
 * funded wallet, had a mandate and a strategy, and made no decisions at all,
 * forever, because the cadence iterates `participant_ids` and it was not in
 * one. Nothing logged an error: from the cadence's point of view the agent did
 * not exist, and from the owner's point of view the platform was broken with no
 * explanation available anywhere in the product.
 *
 * So a seat is no longer something an owner has to go and ask for. Activation
 * takes one (agents.service.activate), the running competition reconciles the
 * rest before every tick (reconcileSeats), and both go through here so there is
 * one answer to "which competition does a new agent join" rather than two that
 * drift.
 *
 * WHAT WAS GIVEN UP FOR IT, stated plainly because it was a real rule and not
 * an oversight: entry used to close at a competition's FIRST TICK, so that
 * standings never compared an agent with three hours of record against one with
 * three days. Under a continuous cadence on a three-month season that rule
 * means every agent created after the season's first four hours can never
 * compete — the arena closes permanently a few hours after it opens, which is
 * not a competition anyone can enter. The comparison problem is real, so it is
 * RECORDED instead of prevented: `competition_entries.joined_tick_index` says
 * which tick each agent's record starts at, and the standings carry it.
 */

/** Anything that can run SQL: a repository manager, or a transaction. */
export interface Querier {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

const rows = async <T>(db: Querier, sql: string, params?: unknown[]): Promise<T[]> =>
  ((await db.query(sql, params)) ?? []) as T[];

export interface Seat {
  competitionId: string;
  /** How many ticks the competition had already run when this agent joined. */
  joinedTickIndex: number;
  /** False when the agent already held this seat and nothing was written. */
  seated: boolean;
}

/**
 * The competition a new agent joins.
 *
 * `running`, and its season must contain NOW. Both conditions, because either
 * alone admits the wrong thing: a competition left at `running` after its
 * season ended would collect agents that can never be scored, and a season that
 * is current says nothing about whether its competition has been stood up.
 *
 * AI-vs-AI wins the tie. A human-vs-AI competition also runs on the cadence,
 * which skips human-managed agents with a log line — an AI agent seated there
 * competes, but it is the wrong room to put it in by default. Deterministic
 * after that (season start, then id) so two concurrent activations pick the
 * same competition rather than splitting the field by timing.
 */
export async function liveCompetitionId(db: Querier): Promise<string | null> {
  const found = await rows<{ id: string }>(
    db,
    `SELECT c.id
       FROM competitions c
       JOIN seasons s ON s.id = c.season_id
      WHERE c.status = 'running'
        AND now() >= s.start_at
        AND now() <  s.end_at
      ORDER BY (c.type = 'ai_vs_ai') DESC, s.start_at DESC, c.id
      LIMIT 1`,
  );
  return found[0]?.id ?? null;
}

/**
 * Put one agent in one competition, and record when it got there.
 *
 * The array is appended IN THE DATABASE, never read into memory and written
 * back: two activations landing together would each write the array they read
 * and the later write would silently drop the earlier agent. The same reason
 * joinParticipant has always done it this way.
 *
 * The entry row records the FIRST time this agent entered this competition and
 * is never rewritten — a re-entry after a withdrawal keeps the original index,
 * because that is when this agent's record in this contest starts.
 */
export async function seatAgent(db: Querier, agentId: string, competitionId: string): Promise<Seat> {
  const ticks = await rows<{ ticks: string }>(
    db,
    `SELECT count(*)::text AS ticks FROM competition_ticks WHERE competition_id = $1::uuid`,
    [competitionId],
  );
  const joinedTickIndex = Number(ticks[0]?.ticks ?? 0);

  await db.query(
    `INSERT INTO competition_entries (competition_id, agent_id, joined_tick_index)
          VALUES ($1::uuid, $2::uuid, $3)
     ON CONFLICT (competition_id, agent_id) DO NOTHING`,
    [competitionId, agentId, joinedTickIndex],
  );

  const seated = await rows<{ id: string }>(
    db,
    `UPDATE competitions
        SET participant_ids = array_append(coalesce(participant_ids, '{}'::uuid[]), $2::uuid)
      WHERE id = $1::uuid
        AND NOT ($2::uuid = ANY(coalesce(participant_ids, '{}'::uuid[])))
      RETURNING id`,
    [competitionId, agentId],
  );

  return { competitionId, joinedTickIndex, seated: seated.length > 0 };
}

/**
 * Seat an agent in whatever competition is live. Null means there is none.
 *
 * Null is returned rather than thrown so each caller decides: activation
 * refuses (an agent that cannot compete must not be told it is live), while the
 * reconciler logs and moves on (a competition that has finished is not a fault
 * of the agent's).
 */
export async function seatInLiveCompetition(db: Querier, agentId: string): Promise<Seat | null> {
  const competitionId = await liveCompetitionId(db);
  if (!competitionId) return null;
  return seatAgent(db, agentId, competitionId);
}

/**
 * Verification fixtures are not seated, and this is the one exception.
 *
 * It is not a loophole in "every agent competes" — it is the same rule the
 * engine already enforces from the other end. A row marked `verification` is
 * refused by the decision engine by design (engine/verification.go), so seating
 * one would write a guaranteed failure into every tick for as long as the
 * fixture existed, and the suites mint fixtures by the dozen. The competition
 * would fill with agents that cannot decide, the leaderboard would show them,
 * and the cadence would log a failure per fixture per four hours forever.
 *
 * The mark cannot be acquired by accident: a production client never sends the
 * header, and sending it deliberately marks only your own new row. See
 * common/verification.ts.
 */
export const seatable = (provenance?: string | null): boolean => provenance !== 'verification';

/**
 * Every active agent that holds no seat anywhere still open.
 *
 * "Anywhere still open" rather than "in this competition": an agent competing in
 * the human-vs-AI room must not be seated in the AI-vs-AI one as well, or its
 * decisions would be attributed to two contests and its NAV would be read
 * twice.
 *
 * Retired and draft agents are excluded, and that is not the exception it looks
 * like. A retired agent has stood down; a draft is a saved intention that the
 * engine refuses by design (`agent is not active`), so seating one would put a
 * guaranteed failure into every tick forever — the permanent journal noise this
 * repository has already had to clean up twice. Verification fixtures are
 * excluded for exactly that reason; see `seatable`.
 */
export async function unseatedActiveAgentIds(db: Querier): Promise<string[]> {
  const found = await rows<{ id: string }>(
    db,
    `SELECT a.id
       FROM agents a
      WHERE a.status = 'active'
        AND a.provenance <> 'verification'
        AND NOT EXISTS (
              SELECT 1 FROM competitions c
               WHERE c.status <> 'completed'
                 AND a.id = ANY(coalesce(c.participant_ids, '{}'::uuid[])))
      ORDER BY a.created_at, a.id`,
  );
  return found.map((r) => r.id);
}
