import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * System status, from probes that measure something.
 *
 * THE RULE THIS FILE IS BUILT AROUND: a check that cannot run is not a check
 * that passed. Every component below reports one of three states —
 * `operational`, `degraded`, `unknown` — and `unknown` is used whenever the
 * probe itself could not be carried out. A status page that renders green
 * because a query returned no rows is the exact failure this platform keeps
 * writing down: healthy and wrong.
 *
 * WHAT MAKES A COMPONENT DEGRADED IS STATED IN ITS OWN ROW, as a threshold with
 * units, so a reader can disagree with the judgement rather than having to take
 * it. "Stale" means nothing without saying stale against what.
 *
 * NOTHING HERE IS AN UPTIME PERCENTAGE. This service has no historical probe
 * record to compute one from, and a "99.9%" assembled from the last few rows of
 * a table would be a number with a decimal point and no measurement behind it.
 */

export type Health = 'operational' | 'degraded' | 'unknown';

export type Component = {
  key: string;
  label: string;
  state: Health;
  /** The measurement the state was decided from, in words with units. */
  detail: string;
  /** The threshold that separates operational from degraded. */
  threshold: string | null;
  /** Populated only when the probe could not run. */
  unknown_because: string | null;
  measured_at: string | null;
};

/** A tick is expected roughly this often; beyond it the engine is quiet. */
const TICK_QUIET_MINUTES = 90;
/** A market snapshot older than this is stale enough to affect decisions. */
const SNAPSHOT_STALE_MINUTES = 120;
/** Model latency above this is slow enough to be worth saying. */
const MODEL_SLOW_MS = 15000;

@Injectable()
export class StatusService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async status() {
    const components: Component[] = [];
    const now = Date.now();

    const minutesSince = (d: Date | string | null | undefined) =>
      d ? Math.floor((now - new Date(d).getTime()) / 60000) : null;

    // ---- the database this service is answering from -------------------
    const started = Date.now();
    let dbOk = false;
    let dbDetail = '';
    try {
      await this.db.query('SELECT 1');
      dbOk = true;
      dbDetail = `answered SELECT 1 in ${Date.now() - started}ms`;
    } catch (e) {
      dbDetail = e instanceof Error ? e.message : String(e);
    }
    components.push({
      key: 'database',
      label: 'Database',
      state: dbOk ? 'operational' : 'degraded',
      detail: dbDetail,
      threshold: 'a failed SELECT 1 is degraded',
      unknown_because: null,
      measured_at: new Date().toISOString(),
    });

    // ---- the decision engine -------------------------------------------
    try {
      const rows = await this.db.query(
        `SELECT count(*) FILTER (WHERE ts > now() - interval '24 hours')::int AS last_24h,
                max(ts) AS last_decision
           FROM decisions_counted`,
      );
      const r = rows[0] ?? {};
      const quiet = minutesSince(r.last_decision);
      const never = r.last_decision === null;
      components.push({
        key: 'decision_engine',
        label: 'Decision engine',
        state: never ? 'unknown' : quiet !== null && quiet > TICK_QUIET_MINUTES ? 'degraded' : 'operational',
        detail: never
          ? 'no decision has ever been recorded'
          : `${Number(r.last_24h ?? 0)} decisions in the last 24h · last one ${quiet} minutes ago`,
        threshold: `quiet for more than ${TICK_QUIET_MINUTES} minutes is degraded`,
        unknown_because: never ? 'There is no decision to measure against.' : null,
        measured_at: r.last_decision ? new Date(r.last_decision).toISOString() : null,
      });
    } catch (e) {
      components.push(this.probeFailed('decision_engine', 'Decision engine', e));
    }

    // ---- the market data every decision is made against ----------------
    try {
      const rows = await this.db.query(
        `SELECT ref, tick_time FROM market_snapshots ORDER BY tick_time DESC LIMIT 1`,
      );
      const r = rows[0] ?? null;
      const age = minutesSince(r?.tick_time);
      components.push({
        key: 'market_data',
        label: 'Market data',
        state: !r ? 'unknown' : age !== null && age > SNAPSHOT_STALE_MINUTES ? 'degraded' : 'operational',
        detail: r
          ? `latest snapshot ${r.ref} · ${age} minutes old`
          : 'no market snapshot has ever been recorded',
        threshold: `older than ${SNAPSHOT_STALE_MINUTES} minutes is degraded`,
        unknown_because: r ? null : 'There is no snapshot to measure the age of.',
        measured_at: r?.tick_time ? new Date(r.tick_time).toISOString() : null,
      });
    } catch (e) {
      components.push(this.probeFailed('market_data', 'Market data', e));
    }

    // ---- the model behind the decisions --------------------------------
    //
    // MEASURED FROM latency_ms ON THE DECISIONS THEMSELVES, not from a synthetic
    // ping. A probe request to a provider measures the probe; this measures what
    // the agents actually waited for. Rows with no latency recorded are excluded
    // rather than counted as fast.
    try {
      const rows = await this.db.query(
        `SELECT provider, model,
                count(*)::int AS calls,
                percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms)::bigint AS median_ms,
                max(ts) AS last_call
           FROM decisions_counted
          WHERE ts > now() - interval '24 hours' AND latency_ms IS NOT NULL
          GROUP BY provider, model
          ORDER BY count(*) DESC LIMIT 1`,
      );
      const r = rows[0] ?? null;
      const median = r ? Number(r.median_ms) : null;
      components.push({
        key: 'model_provider',
        label: 'Model provider',
        state: !r ? 'unknown' : median !== null && median > MODEL_SLOW_MS ? 'degraded' : 'operational',
        detail: r
          ? `${r.provider ?? 'provider not recorded'} · ${r.model ?? 'model not recorded'} · ` +
            `median ${(median! / 1000).toFixed(1)}s over ${r.calls} calls in 24h`
          : 'no model call with a recorded latency in the last 24 hours',
        threshold: `median above ${MODEL_SLOW_MS / 1000}s is degraded`,
        unknown_because: r
          ? null
          : 'No decision in the last 24 hours carries a latency, so there is nothing to measure. ' +
            'That may mean no model was called at all.',
        measured_at: r?.last_call ? new Date(r.last_call).toISOString() : null,
      });
    } catch (e) {
      components.push(this.probeFailed('model_provider', 'Model provider', e));
    }

    // ---- the chain, as far as ARCANA can see it ------------------------
    //
    // THE HIGHEST BLOCK ARCANA HAS A TRANSACTION IN — NOT THE CHAIN HEAD. This
    // service does not call an RPC, and reporting a number from the executions
    // table as "the chain head" would be a claim about the network made from a
    // record of our own activity. The distinction is in the detail line.
    try {
      const rows = await this.db.query(
        `SELECT max(block_number)::bigint AS last_block,
                max(ts) AS last_execution,
                count(*) FILTER (WHERE ts > now() - interval '24 hours')::int AS last_24h,
                count(*) FILTER (WHERE ts > now() - interval '24 hours' AND status = 'failed')::int AS failed_24h
           FROM executions`,
      );
      const r = rows[0] ?? {};
      const has = r.last_execution !== null && r.last_execution !== undefined;
      const failed = Number(r.failed_24h ?? 0);
      const total = Number(r.last_24h ?? 0);
      components.push({
        key: 'settlement',
        label: 'On-chain settlement',
        state: !has ? 'unknown' : failed > 0 ? 'degraded' : 'operational',
        detail: has
          ? `highest block ARCANA has a transaction in: ${r.last_block ?? 'none recorded'} · ` +
            `${total} executions in 24h, ${failed} failed · last ${minutesSince(r.last_execution)} minutes ago`
          : 'ARCANA has never recorded an on-chain execution',
        threshold: 'any failed execution in the last 24h is degraded',
        unknown_because: has
          ? null
          : 'There is no execution to read a block from. This is not a statement about the chain, ' +
            'which this service does not call.',
        measured_at: r.last_execution ? new Date(r.last_execution).toISOString() : null,
      });
    } catch (e) {
      components.push(this.probeFailed('settlement', 'On-chain settlement', e));
    }

    // ---- protective levels that crossed and were not taken -------------
    //
    // Not infrastructure, and on this page deliberately: a stop that is armed
    // and held back is the failure a customer would never see anywhere else,
    // and its owner believes the position is covered.
    try {
      const rows = await this.db.query(
        `SELECT count(*)::int AS held_back, max(last_refusal_at) AS last
           FROM position_guards
          WHERE status = 'armed' AND last_refusal_at IS NOT NULL`,
      );
      const held = Number(rows[0]?.held_back ?? 0);
      components.push({
        key: 'protection',
        label: 'Protective levels',
        state: held > 0 ? 'degraded' : 'operational',
        detail:
          held > 0
            ? `${held} armed level(s) crossed and the exit was not taken`
            : 'no armed level is currently held back',
        threshold: 'any armed level that crossed without exiting is degraded',
        unknown_because: null,
        measured_at: rows[0]?.last ? new Date(rows[0].last).toISOString() : new Date().toISOString(),
      });
    } catch (e) {
      components.push(this.probeFailed('protection', 'Protective levels', e));
    }

    // THE WORST STATE WINS, and `unknown` does not resolve to green. A page
    // whose overall badge says OPERATIONAL while one probe could not run would
    // be reporting the absence of a check as the success of one.
    const overall: Health = components.some((c) => c.state === 'degraded')
      ? 'degraded'
      : components.some((c) => c.state === 'unknown')
        ? 'unknown'
        : 'operational';

    return {
      overall,
      overall_note:
        overall === 'unknown'
          ? 'At least one probe could not be carried out. That is not the same as everything being ' +
            'fine, so the overall state is unknown rather than operational.'
          : overall === 'degraded'
            ? 'At least one component is measurably outside its threshold. The rows below say which ' +
              'and by how much.'
            : 'Every probe ran and every measurement was inside its stated threshold.',
      components,
      probes: components.length,
      probes_unknown: components.filter((c) => c.state === 'unknown').length,
      basis:
        'These are measurements over ARCANA’s own records, not synthetic pings. There is no ' +
        'historical probe log, so no uptime percentage is offered — one assembled from these rows ' +
        'would be a figure with no measurement behind it.',
      as_of: new Date().toISOString(),
    };
  }

  private probeFailed(key: string, label: string, e: unknown): Component {
    return {
      key,
      label,
      state: 'unknown',
      detail: 'the probe did not complete',
      threshold: null,
      unknown_because: e instanceof Error ? e.message : String(e),
      measured_at: null,
    };
  }
}
