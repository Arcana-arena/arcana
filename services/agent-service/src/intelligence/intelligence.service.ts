import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  COMMITMENT_EXPLAINED,
  Visibility,
  blankToNull,
  isPrivate,
  parseManifest,
  stableJson,
} from './intelligence';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export type Check = { name: string; ok: boolean; detail?: string };

/**
 * Visibility, disclosures and commitment verification.
 *
 * Read models ask this whether an agent is private and whether one decision has
 * been opened; the owner endpoints use it to open them. Every write goes through
 * a transaction the database itself polices (migration 0047): a visibility change
 * without a disclosure row in the same transaction is refused, a disclosure can
 * never be edited, and public can never become private.
 *
 * DECISIONS ARE READ THROUGH decisions_counted, like every other reader — a
 * measurement artefact cannot be opened or verified, because no public surface
 * treats it as a decision. The one exception is the chain lookup, which must see
 * every row the engine chained over, marked where it happens.
 */
@Injectable()
export class IntelligenceService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /** The agent's visibility and, if it was ever made public, when. Null when the agent does not exist. */
  async visibilityOf(agentId: string): Promise<{ visibility: Visibility; disclosedAt: string | null } | null> {
    const rows = await this.db.query(
      `SELECT a.visibility, d.disclosed_at
         FROM agents a
         LEFT JOIN intelligence_disclosures d ON d.agent_id = a.id AND d.scope = 'agent'
        WHERE a.id = $1`,
      [agentId],
    );
    if (rows.length === 0) return null;
    return {
      visibility: rows[0].visibility === 'private' ? 'private' : 'public',
      disclosedAt: rows[0].disclosed_at ? new Date(rows[0].disclosed_at).toISOString() : null,
    };
  }

  /** Visibility for many agents at once, for list endpoints. */
  async visibilities(agentIds: string[]): Promise<Map<string, Visibility>> {
    const out = new Map<string, Visibility>();
    if (agentIds.length === 0) return out;
    const rows = await this.db.query(`SELECT id::text AS id, visibility FROM agents WHERE id = ANY($1::uuid[])`, [
      agentIds,
    ]);
    for (const r of rows) out.set(r.id, r.visibility === 'private' ? 'private' : 'public');
    return out;
  }

  /** Ids of this agent's decisions whose intelligence its creator has opened. */
  async openedDecisions(agentId: string): Promise<Set<number>> {
    const rows = await this.db.query(
      `SELECT decision_id FROM intelligence_disclosures WHERE agent_id = $1 AND scope = 'decision'`,
      [agentId],
    );
    return new Set(rows.map((r: { decision_id: string | number }) => Number(r.decision_id)));
  }

  /** The permanent record: every time this agent's intelligence was opened. Public. */
  async disclosures(agentId: string) {
    const v = await this.visibilityOf(agentId);
    if (!v) throw new NotFoundException(`Agent ${agentId} not found`);
    const rows = await this.db.query(
      `SELECT id, scope, decision_id, decision_ts, commitment, disclosed_by_wallet, disclosed_at
         FROM intelligence_disclosures
        WHERE agent_id = $1
        ORDER BY disclosed_at DESC, id DESC`,
      [agentId],
    );
    return {
      agent_id: agentId,
      visibility: v.visibility,
      items: rows.map((r: Record<string, any>) => ({
        id: Number(r.id),
        scope: r.scope,
        decision_id: r.decision_id === null ? null : Number(r.decision_id),
        decision_ts: r.decision_ts ? new Date(r.decision_ts).toISOString() : null,
        commitment: r.commitment ? String(r.commitment).trim() : null,
        disclosed_by_wallet: r.disclosed_by_wallet,
        disclosed_at: new Date(r.disclosed_at).toISOString(),
      })),
      note:
        'Every disclosure is a permanent record. It cannot be edited or removed, and an agent that became ' +
        'public cannot become private again.',
    };
  }

  /**
   * Make a private agent public, permanently. The disclosure row and the
   * visibility change commit together; the database refuses the second without
   * the first.
   */
  async discloseAgent(agentId: string, wallet: string) {
    return this.db.transaction(async (m) => {
      const rows = await m.query(`SELECT visibility, creator_id FROM agents WHERE id = $1 FOR UPDATE`, [agentId]);
      if (rows.length === 0) throw new NotFoundException(`Agent ${agentId} not found`);
      if (!isPrivate(rows[0].visibility)) {
        throw new ConflictException({
          code: 'already_public',
          message: 'This agent is already public. Nothing is withheld, so there is nothing to disclose.',
        });
      }
      const ins = await m.query(
        `INSERT INTO intelligence_disclosures (agent_id, scope, disclosed_by_wallet, creator_id)
         VALUES ($1, 'agent', $2, $3)
         RETURNING id, disclosed_at`,
        [agentId, wallet.toLowerCase(), rows[0].creator_id],
      );
      await m.query(`UPDATE agents SET visibility = 'public' WHERE id = $1`, [agentId]);
      return {
        agent_id: agentId,
        visibility: 'public' as const,
        disclosure_id: Number(ins[0].id),
        disclosed_at: new Date(ins[0].disclosed_at).toISOString(),
        note:
          'This agent is public now, permanently. Its mandate, risk rules and the evidence behind every ' +
          'decision — including those made while it was private — are readable by anyone, and this ' +
          'disclosure is on its public record.',
      };
    });
  }

  /**
   * Open the intelligence behind ONE decision of a private agent: its manifest,
   * prompt, raw response, model and thesis. Recorded permanently. Opening the
   * same decision twice returns the first record rather than writing a second.
   *
   * THE TIMESTAMP TRAVELS AS TEXT. A decision's ts is part of its key and is
   * stored to the microsecond; read into a JavaScript Date it loses the last
   * three digits, and the disclosure then names a decision that does not exist —
   * which the database refuses, correctly. That refusal was the first run's 500.
   */
  async revealDecision(agentId: string, decisionId: number, wallet: string) {
    return this.db.transaction(async (m) => {
      const agent = await m.query(`SELECT visibility, creator_id FROM agents WHERE id = $1`, [agentId]);
      if (agent.length === 0) throw new NotFoundException(`Agent ${agentId} not found`);
      if (!isPrivate(agent[0].visibility)) {
        throw new ConflictException({
          code: 'already_public',
          message: 'This agent is public, so the evidence behind every decision is already readable.',
        });
      }
      const d = await m.query(
        `SELECT id, ts::text AS ts_text, commitment FROM decisions_counted WHERE id = $1 AND agent_id = $2`,
        [decisionId, agentId],
      );
      if (d.length === 0) throw new NotFoundException(`Decision ${decisionId} not found for this agent`);

      await m.query(
        `INSERT INTO intelligence_disclosures
           (agent_id, scope, decision_id, decision_ts, commitment, disclosed_by_wallet, creator_id)
         VALUES ($1, 'decision', $2, $3::timestamptz, $4, $5, $6)
         ON CONFLICT (agent_id, decision_id, decision_ts) WHERE scope = 'decision' DO NOTHING`,
        [agentId, decisionId, d[0].ts_text, d[0].commitment, wallet.toLowerCase(), agent[0].creator_id],
      );
      const rec = await m.query(
        `SELECT id, disclosed_at FROM intelligence_disclosures
          WHERE agent_id = $1 AND scope = 'decision' AND decision_id = $2`,
        [agentId, decisionId],
      );
      return {
        agent_id: agentId,
        decision_id: decisionId,
        disclosure_id: Number(rec[0].id),
        disclosed_at: new Date(rec[0].disclosed_at).toISOString(),
        commitment: d[0].commitment ? String(d[0].commitment).trim() : null,
        note:
          'The intelligence behind this decision is public now, permanently, and anyone can check it ' +
          'against the commitment recorded when the decision was made. The prompt contains the mandate ' +
          'as it was then.',
      };
    });
  }

  /**
   * Check a decision's commitment against what is stored: the manifest hashes
   * to the commitment, the bodies it names hash to their names, it describes
   * this decision row, and it names the agent's previous commitment.
   *
   * Only called for decisions whose intelligence is readable — the manifest
   * holds the salt, and verifying against it publicly is the same as opening it.
   */
  async verifyCommitment(agentId: string, decisionId: number) {
    const rows = await this.db.query(
      `SELECT d.id, d.agent_id::text AS agent_id, d.season_id::text AS season_id,
              to_char(d.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts_text,
              d.market_snapshot_ref, d.action, d.symbol, d.quantity::text AS quantity, d.rationale,
              d.decider, d.reason_code, d.provider, d.model, d.model_version, d.params, d.thesis,
              d.system_prompt_hash, d.prompt_hash, d.response_hash, d.commitment, d.commitment_scheme,
              m.body AS manifest
         FROM decisions_counted d
         LEFT JOIN decision_evidence m ON m.hash = d.commitment
        WHERE d.id = $1 AND d.agent_id = $2`,
      [decisionId, agentId],
    );
    if (rows.length === 0) throw new NotFoundException(`Decision ${decisionId} not found for this agent`);
    const r = rows[0];
    const commitment: string | null = r.commitment ? String(r.commitment).trim() : null;

    if (!commitment) {
      return {
        status: 'no_commitment' as const,
        commitment: null,
        checks: [] as Check[],
        explained:
          'This decision was recorded before commitments existed, or could not be sealed when it was ' +
          'recorded. There is nothing to check it against, and none is added afterwards.',
      };
    }
    if (!r.manifest) {
      return {
        status: 'manifest_missing' as const,
        commitment,
        checks: [{ name: 'the manifest is in the evidence store', ok: false }] as Check[],
        explained: 'The commitment was recorded, but the manifest it names is no longer stored.',
      };
    }

    const checks: Check[] = [];
    const check = (name: string, ok: boolean, detail?: string) => checks.push(ok ? { name, ok } : { name, ok, detail });

    check('the manifest hashes to the commitment', sha256(r.manifest) === commitment);
    const parsed = parseManifest(r.manifest);
    check('the manifest is in the recorded format', parsed !== null, 'not an arcana-commitment/v1 manifest');

    if (parsed) {
      const f = parsed.fields;
      const same = (name: string, a: unknown, b: unknown) =>
        check(`it names the same ${name}`, blankToNull(a) === blankToNull(b), `${String(a)} ≠ ${String(b)}`);

      same('agent', f.agent_id, r.agent_id);
      same('season', f.season_id, r.season_id);
      same('time', f.ts, r.ts_text);
      same('snapshot', f.market_snapshot_ref, r.market_snapshot_ref);
      same('action', f.action, r.action);
      same('symbol', f.symbol, r.symbol);
      check(
        'it names the same quantity',
        (f.quantity === null && r.quantity === null) ||
          (f.quantity !== null && r.quantity !== null && Math.abs(Number(f.quantity) - Number(r.quantity)) < 1e-9),
        `${String(f.quantity)} ≠ ${String(r.quantity)}`,
      );
      same('rationale', f.rationale, r.rationale);
      same('decider', f.decider, r.decider);
      same('reason', f.reason_code, r.reason_code);
      same('provider', f.provider, r.provider);
      same('model', f.model, r.model);
      same('model version', f.model_version, r.model_version);
      check('it names the same parameters', stableJson(f.params) === stableJson(r.params ?? null));
      check('it names the same thesis', stableJson(f.thesis) === stableJson(r.thesis ?? null));

      for (const [key, column, label] of [
        ['system_prompt_sha256', 'system_prompt_hash', 'system prompt'],
        ['prompt_sha256', 'prompt_hash', 'prompt'],
        ['response_sha256', 'response_hash', 'raw response'],
      ] as const) {
        const named = blankToNull(f[key]);
        const onRow = r[column] ? String(r[column]).trim() : null;
        check(`it names the same ${label}`, named === onRow, `${String(named)} ≠ ${String(onRow)}`);
        if (typeof named === 'string') {
          const body = await this.db.query(`SELECT body FROM decision_evidence WHERE hash = $1`, [named]);
          check(
            `the stored ${label} hashes to the name in the manifest`,
            body.length === 1 && sha256(body[0].body) === named,
            body.length === 0 ? 'body not in the evidence store' : 'hash mismatch',
          );
        }
      }

      // THE CHAIN WALKS THE RAW LOG, deliberately. The engine names the previous
      // commitment over every row it wrote, including one later marked as a
      // measurement artefact; asking the counted view would report a gap the
      // chain does not have. This reads order, it counts nothing.
      const prev = await this.db.query(
        `SELECT commitment FROM decisions -- raw-by-design: the commitment chain spans every written row, artefacts included
          WHERE agent_id = $1 AND commitment IS NOT NULL AND id < $2
          ORDER BY id DESC LIMIT 1`,
        [agentId, decisionId],
      );
      const expectedPrev = prev.length ? String(prev[0].commitment).trim() : null;
      check(
        'it names the commitment of the decision before it',
        blankToNull(f.previous_commitment) === expectedPrev,
        `${String(f.previous_commitment)} ≠ ${String(expectedPrev)}`,
      );
    }

    return {
      status: checks.every((c) => c.ok) ? ('verified' as const) : ('mismatch' as const),
      commitment,
      scheme: r.commitment_scheme ?? null,
      checks,
      manifest: r.manifest as string,
      explained: COMMITMENT_EXPLAINED,
    };
  }
}
