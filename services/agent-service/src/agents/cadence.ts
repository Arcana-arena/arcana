/**
 * Each agent's own clock, and who is due to decide right now.
 *
 * WHAT CHANGED AND WHY. Deciding used to be a per-COMPETITION act: a systemd
 * unit held `CADENCE_INTERVAL`, the binary opened a tick, and every participant
 * decided against it. One interval, chosen by an operator, for every strategy in
 * the room — four hours for an agent whose edge lasts an hour and four hours for
 * one that wants a week. An owner could not ask for anything else, and nothing
 * in the product let them say so.
 *
 * The policy argument for a shared floor was retired before this (see
 * cmd/cadence's header): it assumed deciding is trading, when most decisions are
 * holds and the measured rate was one trade in five. What bounds cost is
 * measured directly instead — the signer's per-agent daily signature cap and the
 * engine's per-agent daily token budget — and the fees an agent does pay are its
 * owner's to spend.
 *
 * So the interval sits on the agent, the pacer reads it here, and the
 * competition tick goes back to being what the leaderboard needs: a marked
 * window with a snapshot, not a gate on anybody's strategy.
 */

/**
 * The floor, and it is the DATA MODEL rather than a preference.
 *
 * A pool snapshot is identified by `pool-` + UTC `YYYYMMDDTHHMMZ` — minute
 * resolution — and `decisions.market_snapshot_ref` is a foreign key into
 * `market_snapshots`. Two decisions inside one minute are two decisions claiming
 * the same immutable description of the market, so below a minute the record
 * stops being able to say what the agent saw. Raising this means changing the
 * snapshot ref format first.
 */
export const MIN_CADENCE_SECONDS = 60;

/**
 * A month. Past this an agent is not being paced, it is parked, and `retire` is
 * the word the product already has for that.
 */
export const MAX_CADENCE_SECONDS = 2592000;

/**
 * What an agent is given when its owner never said: THE FLOOR.
 *
 * It was 14400 for one hour on 2026-09-20, carried over from the interval that
 * used to live in a competition's unit file — and it was the wrong default for
 * the same reason the competition-wide interval was the wrong mechanism. An agent
 * created in the afternoon and funded by its owner sat waiting for the
 * platform's four hours without having been asked anything: a wait its owner did
 * not choose, produced by a number nobody had told them about.
 *
 * So the default is the shortest interval the record can describe. An agent looks
 * every minute from the moment it goes active, and what keeps it from trading is
 * the market not having moved beyond its own rebalance band — a fact about prices
 * that its decision log states — rather than a clock it cannot see.
 *
 * AN OWNER WHO WANTS PATIENCE ASKS FOR IT. Four hours, a day, a week: all
 * settable, and now visible as a choice on the row rather than invisible as a
 * platform habit.
 */
export const DEFAULT_CADENCE_SECONDS = MIN_CADENCE_SECONDS;

/**
 * How early an agent counts as due, and why it is not a fudge.
 *
 * WITHOUT IT, EVERY CADENCE ROUNDS UP TO THE NEXT TIMER TICK. Measured on
 * 2026-09-20, an hour after per-agent cadence shipped: agents set to 60 seconds
 * were deciding every TWO minutes. The pacer fires at :01, reaches the agent and
 * writes its decision at :04 — so at the next fire the age is 57 seconds, three
 * short, and the agent waits a whole further minute. A one-minute cadence became
 * two, a five-minute cadence would become six, and nothing in the record would
 * have said why: every decision was correctly spaced by more than its cadence.
 *
 * So the question is not "has the cadence elapsed" but "will it have elapsed by
 * the time this run reaches the agent". Ten seconds is the run's own latency with
 * room — today's runs take three to five seconds for the whole field — and it is
 * deliberately far below the sixty-second floor, so it can never make two
 * decisions land inside one minute and claim the same snapshot ref.
 */
export const DUE_GRACE_SECONDS = 10;

export interface DueAgent {
  agent_id: string;
  season_id: string;
  cadence_seconds: number;
  /** Null when the agent has never decided: its first run is due immediately. */
  last_decision_at: string | null;
  /** Seconds since the last decision, null for an agent that has none. */
  age_seconds: number | null;
}

export interface Querier {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * Every agent whose own interval has elapsed since its LAST RECORDED DECISION.
 *
 * MEASURED FROM THE RECORD, not from a cursor and not from the schedule. A
 * cursor is a second source of truth that drifts the first time a decision is
 * written by anything else — the manual endpoint, a backfill — and this
 * repository has already retired one table that existed to hold exactly that
 * (`service_state`, migration 0028). Reading `decisions` also means a missed
 * minute is picked up on the next one rather than shifting the series.
 *
 * WHO IS EXCLUDED, and each one for a reason that already exists elsewhere:
 *
 *   - not `active`   — the engine refuses a draft (`agent is not active`), and a
 *                      retired agent has stood down.
 *   - `verification` — the engine refuses those by design, so pacing one would
 *                      write a guaranteed failure every minute.
 *   - `human`        — a person is not paced by a clock; the manual decision
 *                      endpoint is theirs and still works.
 *   - no seat        — an agent outside every open competition has no season to
 *                      record a decision against. Seating is automatic at
 *                      activation and reconciled before every tick
 *                      (competitions/seating.ts), so this is a transient state,
 *                      not a way to be left out.
 *
 * The SEASON comes from the seat rather than from the clock, because portfolios
 * and scores are per (agent, season) and a decision filed under a season the
 * agent does not compete in would be invisible to both.
 */
export async function dueAgents(db: Querier, now = new Date()): Promise<DueAgent[]> {
  const rows = (await db.query(
    `WITH seat AS (
       SELECT DISTINCT ON (a.id)
              a.id AS agent_id, c.season_id, a.cadence_seconds
         FROM agents a
         JOIN competitions c
           ON c.status <> 'completed'
          AND a.id = ANY(coalesce(c.participant_ids, '{}'::uuid[]))
         JOIN seasons s ON s.id = c.season_id
        WHERE a.status = 'active'
          AND a.provenance <> 'verification'
          AND coalesce(a.strategy_type, '') <> 'human'
          AND $1::timestamptz >= s.start_at
          AND $1::timestamptz <  s.end_at
        ORDER BY a.id, (c.type = 'ai_vs_ai') DESC, s.start_at DESC, c.id
     ), last AS (
       -- AT OR BEFORE THE INSTANT ASKED ABOUT, so this is a question about a
       -- point in time rather than about whenever it is answered. Without the
       -- bound, a decision written after that instant — by the pacer's next run,
       -- or by the manual endpoint — would come back as this agent's "last" and make
       -- the age negative, so an audit of a past minute would quietly report
       -- nobody as due.
       SELECT seat.agent_id,
              (SELECT max(d.ts) FROM decisions d
                WHERE d.agent_id = seat.agent_id AND d.ts <= $1::timestamptz) AS last_ts
         FROM seat
     )
     SELECT seat.agent_id::text,
            seat.season_id::text,
            seat.cadence_seconds,
            last.last_ts,
            CASE WHEN last.last_ts IS NULL THEN NULL
                 ELSE floor(extract(epoch FROM ($1::timestamptz - last.last_ts)))::bigint
            END AS age_seconds
       FROM seat
       JOIN last ON last.agent_id = seat.agent_id
      WHERE last.last_ts IS NULL
         OR $1::timestamptz + make_interval(secs => ${DUE_GRACE_SECONDS}) - last.last_ts
            >= make_interval(secs => seat.cadence_seconds)
      ORDER BY last.last_ts NULLS FIRST, seat.agent_id`,
    [now.toISOString()],
  )) as Array<{
    agent_id: string;
    season_id: string;
    cadence_seconds: number;
    last_ts: Date | null;
    age_seconds: string | null;
  }>;

  return rows.map((r) => ({
    agent_id: r.agent_id,
    season_id: r.season_id,
    cadence_seconds: Number(r.cadence_seconds),
    last_decision_at: r.last_ts ? new Date(r.last_ts).toISOString() : null,
    age_seconds: r.age_seconds == null ? null : Number(r.age_seconds),
  }));
}
