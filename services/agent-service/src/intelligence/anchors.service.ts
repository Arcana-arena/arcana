import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ANCHOR_MAGIC_HEX, ANCHOR_SCHEME, leafHash, merkleProof, merkleRoot, verifyProof } from './merkle';

type Check = { name: string; ok: boolean; detail?: string };

type AnchorRow = {
  id: string;
  scheme: string;
  root: string;
  leaf_count: number;
  first_decision_id: string | null;
  last_decision_id: string | null;
  first_decision_ts: string | null;
  last_decision_ts: string | null;
  chain_id: number;
  sender: string;
  nonce: string;
  tx_hash: string;
  status: string;
  block_number: string | null;
  gas_used: string | null;
  gas_cost_wei: string | null;
  gas_cost_usd: string | null;
  note: string | null;
  created_at: string;
  mined_at: string | null;
};

type OnChain = { reachable: boolean; checks: Check[]; block_number: number | null; reason?: string };

export type SealProof = {
  seal: string;
  kind: string | null;
  status: 'anchored' | 'anchoring' | 'mismatch' | 'pending';
  note?: string;
  anchor?: ReturnType<AnchorsService['shape']>;
  leaf_index?: number;
  leaf_count?: number;
  proof?: Array<{ sibling: string; position: 'left' | 'right' }>;
  expected_input?: string;
  checks?: Check[];
  on_chain?: { reachable: boolean; block_number: number | null; reason: string | null };
  how_to_check: string;
};

const HOW_TO_CHECK =
  'You do not need ARCANA to check this. Ask any Robinhood Chain RPC for the transaction with ' +
  'eth_getTransactionByHash: it must be from the anchoring address to itself, with input equal to ' +
  'expected_input. Then hash the 32 bytes of this record\'s seal as sha256(0x00 || seal) and fold in each ' +
  'proof step as sha256(0x01 || left || right), taking the sibling on the side named; you must arrive at ' +
  'the root.';

const KIND_LABEL: Record<string, string> = {
  decision: 'decision commitment',
  portfolio_snapshot: 'portfolio snapshot seal',
  score: 'score seal',
};

/**
 * Anchors: which on-chain root contains a sealed record, and the evidence for it.
 *
 * A record is a decision (its commitment), a portfolio snapshot (its seal) or a
 * score (its seal). Each is the sha256 of a manifest that names its own scheme,
 * so the proof is the same whatever the record is — one path, below, used by
 * every endpoint that proves anything.
 *
 * Everything here is public, including for private agents: an anchor contains
 * only hashes, and those are public for every agent.
 *
 * THE CHAIN IS ASKED, NOT THE TABLE. A proof is only a proof if it ends at data
 * ARCANA does not control, so every mined anchor shown is checked against the
 * transaction itself over RPC. A mined, matching transaction cannot change, so
 * that answer is cached; anything else is asked again next time.
 */
@Injectable()
export class AnchorsService {
  private readonly logger = new Logger(AnchorsService.name);
  private readonly rpcUrls = (process.env.ANCHOR_RPC_URLS ||
    'https://rpc.mainnet.chain.robinhood.com,https://robinhood-rpc.publicnode.com')
    .split(',').map((s) => s.trim()).filter(Boolean);
  private readonly explorerTemplate = process.env.ANCHOR_EXPLORER_TX_URL || null;
  private readonly verified = new Map<string, OnChain>();

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /** Every anchor, newest first, what each carries, and what anchoring has cost the platform. */
  async list(page: number, pageSize: number, offset: number) {
    const [rows, totals, waiting, kinds] = await Promise.all([
      this.db.query(`${ANCHOR_SELECT} ORDER BY id DESC LIMIT $1 OFFSET $2`, [pageSize, offset]),
      this.db.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'mined')::int AS mined,
                coalesce(sum(leaf_count) FILTER (WHERE status = 'mined'), 0)::int AS records_anchored,
                sum(gas_cost_usd) FILTER (WHERE status = 'mined')::float8 AS gas_cost_usd,
                max(mined_at) AS last_mined_at
           FROM decision_anchors`,
      ),
      this.db.query(
        `SELECT
           (SELECT count(*)::int FROM decisions d -- raw-by-design: anchoring covers every sealed row, artefacts included
              JOIN agents a ON a.id = d.agent_id AND a.provenance = 'live'
             WHERE d.commitment IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM decision_anchor_leaves l JOIN decision_anchors x ON x.id = l.anchor_id
                                WHERE l.kind = 'decision' AND l.decision_id = d.id AND l.decision_ts = d.ts
                                  AND x.status NOT IN ('reverted', 'dropped'))) AS decisions,
           (SELECT count(*)::int FROM portfolio_snapshots ps
              JOIN portfolios p ON p.id = ps.portfolio_id
              JOIN agents a ON a.id = p.agent_id AND a.provenance = 'live'
             WHERE ps.seal IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM decision_anchor_leaves l JOIN decision_anchors x ON x.id = l.anchor_id
                                WHERE l.kind = 'portfolio_snapshot' AND l.portfolio_id = ps.portfolio_id
                                  AND l.record_ts = ps.ts AND x.status NOT IN ('reverted', 'dropped'))) AS portfolio_snapshots,
           (SELECT count(*)::int FROM score_snapshots s
              JOIN agents a ON a.id = s.agent_id AND a.provenance = 'live'
             WHERE s.seal IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM decision_anchor_leaves l JOIN decision_anchors x ON x.id = l.anchor_id
                                WHERE l.kind = 'score' AND l.agent_id = s.agent_id AND l.season_id = s.season_id
                                  AND l.record_ts = s.ts AND x.status NOT IN ('reverted', 'dropped'))) AS scores`,
      ),
      this.db.query(
        `SELECT anchor_id::text, kind, count(*)::int AS n FROM decision_anchor_leaves
          WHERE anchor_id IN (SELECT id FROM decision_anchors ORDER BY id DESC LIMIT $1 OFFSET $2)
          GROUP BY anchor_id, kind`,
        [pageSize, offset],
      ),
    ]);
    const t = totals[0];
    const w = waiting[0];
    const byAnchor = new Map<string, Record<string, number>>();
    for (const k of kinds as Array<{ anchor_id: string; kind: string; n: number }>) {
      const m = byAnchor.get(k.anchor_id) ?? {};
      m[k.kind] = k.n;
      byAnchor.set(k.anchor_id, m);
    }
    return {
      scheme: ANCHOR_SCHEME,
      items: rows.map((r: AnchorRow) => ({ ...this.shape(r), kinds: byAnchor.get(String(r.id)) ?? {} })),
      page,
      page_size: pageSize,
      total: t.total,
      has_more: page * pageSize < t.total,
      totals: {
        mined: t.mined,
        records_anchored: t.records_anchored,
        // Kept for readers of the first version of this endpoint.
        decisions_anchored: t.records_anchored,
        gas_cost_usd: t.gas_cost_usd === null ? null : Number(t.gas_cost_usd),
        last_mined_at: t.last_mined_at ? new Date(t.last_mined_at).toISOString() : null,
        paid_by: 'ARCANA — anchoring is infrastructure, never charged to an agent or its owner',
      },
      waiting: {
        sealed_decisions: w.decisions,
        sealed_portfolio_snapshots: w.portfolio_snapshots,
        sealed_scores: w.scores,
        note:
          'Sealed records not yet in an anchor. Anchors are written every fifteen minutes when there is something ' +
          'new; a score waits until every sealed input it names is in a mined anchor.',
      },
    };
  }

  /** One anchor, its leaves, and whether they, the root and the chain agree. */
  async detail(id: number) {
    const rows: AnchorRow[] = await this.db.query(`${ANCHOR_SELECT} WHERE id = $1`, [id]);
    if (rows.length === 0) throw new NotFoundException(`Anchor ${id} not found`);
    const a = rows[0];
    const leaves: Array<Record<string, any>> = await this.db.query(
      `SELECT leaf_index, kind, agent_id::text, trim(commitment) AS commitment,
              decision_id::text,
              to_char(decision_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decision_ts,
              portfolio_id::text, season_id::text,
              to_char(record_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS record_ts
         FROM decision_anchor_leaves WHERE anchor_id = $1 ORDER BY leaf_index`,
      [id],
    );
    const root = merkleRoot(leaves.map((l) => leafHash(l.commitment)));
    const checks: Check[] = [
      { name: 'the stored leaves hash to the anchored root', ok: !!root && root.toString('hex') === a.root.trim() },
      { name: 'the leaf count matches', ok: leaves.length === a.leaf_count },
    ];
    const onChain = await this.onChain(a);
    return {
      anchor: this.shape(a),
      leaves: leaves.map((l) => ({
        leaf_index: l.leaf_index,
        kind: l.kind,
        agent_id: l.agent_id,
        commitment: l.commitment,
        ...(l.kind === 'decision'
          ? { decision_id: Number(l.decision_id), decision_ts: l.decision_ts }
          : l.kind === 'portfolio_snapshot'
            ? { portfolio_id: l.portfolio_id, season_id: l.season_id, ts: l.record_ts }
            : { season_id: l.season_id, ts: l.record_ts }),
      })),
      checks: [...checks, ...onChain.checks],
      on_chain: { reachable: onChain.reachable, block_number: onChain.block_number, reason: onChain.reason ?? null },
      verified: [...checks, ...onChain.checks].every((c) => c.ok) && a.status === 'mined',
      how_to_check: HOW_TO_CHECK,
    };
  }

  /** The root that contains one decision, the proof, and every check. */
  async forDecision(agentId: string, decisionId: number) {
    const d = await this.db.query(
      `SELECT id, ts::text AS ts_text, trim(commitment) AS commitment
         FROM decisions_counted WHERE id = $1 AND agent_id = $2`,
      [decisionId, agentId],
    );
    if (d.length === 0) throw new NotFoundException(`Decision ${decisionId} not found for this agent`);
    const commitment: string | null = d[0].commitment || null;
    if (!commitment) {
      return {
        decision_id: decisionId,
        status: 'no_commitment' as const,
        commitment: null,
        note: 'This decision was recorded before commitments existed, so there is nothing to anchor. None is added afterwards.',
      };
    }
    const proof = await this.proofBySeal(commitment, `this decision's commitment`);
    return { decision_id: decisionId, commitment, ...proof };
  }

  /**
   * THE ONE PROOF PATH. Whatever a seal belongs to, where is it anchored, what
   * leads from it to the root, and does the chain agree.
   */
  async proofBySeal(seal: string, what = 'this seal'): Promise<SealProof> {
    const leafRow = await this.db.query(
      `SELECT l.anchor_id, l.leaf_index, l.kind
         FROM decision_anchor_leaves l JOIN decision_anchors a ON a.id = l.anchor_id
        WHERE l.commitment = $1 AND a.status NOT IN ('reverted', 'dropped')
        ORDER BY a.id DESC LIMIT 1`,
      [seal],
    );
    if (leafRow.length === 0) {
      return {
        seal,
        kind: null,
        status: 'pending',
        note:
          'Sealed, and waiting for an anchor. Until its root is mined this record is protected by the database alone; ' +
          'anchors are written every fifteen minutes, and a score waits until every input it names is anchored first.',
        how_to_check: HOW_TO_CHECK,
      };
    }

    const anchorId = Number(leafRow[0].anchor_id);
    const index = Number(leafRow[0].leaf_index);
    const kind: string = leafRow[0].kind;
    const [a]: AnchorRow[] = await this.db.query(`${ANCHOR_SELECT} WHERE id = $1`, [anchorId]);
    const leaves: Array<{ commitment: string }> = await this.db.query(
      `SELECT trim(commitment) AS commitment FROM decision_anchor_leaves WHERE anchor_id = $1 ORDER BY leaf_index`,
      [anchorId],
    );
    const hashes = leaves.map((l) => leafHash(l.commitment));
    const root = merkleRoot(hashes);
    const proof = merkleProof(hashes, index);
    const anchoredRoot = Buffer.from(a.root.trim(), 'hex');

    const checks: Check[] = [
      { name: `${what} is leaf ${index} of anchor ${anchorId} (${KIND_LABEL[kind] ?? kind})`, ok: leaves[index]?.commitment === seal },
      { name: "the anchor's leaves hash to its root", ok: !!root && root.equals(anchoredRoot) },
      { name: 'the proof leads from this seal to the root', ok: verifyProof(leafHash(seal), proof, anchoredRoot) },
    ];
    const onChain = await this.onChain(a);
    const all = [...checks, ...onChain.checks];

    return {
      seal,
      kind,
      status:
        a.status === 'mined'
          ? all.every((c) => c.ok) ? 'anchored' : 'mismatch'
          : 'anchoring',
      anchor: this.shape(a),
      leaf_index: index,
      leaf_count: a.leaf_count,
      proof,
      expected_input: `0x${ANCHOR_MAGIC_HEX}${a.root.trim()}`,
      checks: all,
      on_chain: { reachable: onChain.reachable, block_number: onChain.block_number, reason: onChain.reason ?? null },
      how_to_check: HOW_TO_CHECK,
    };
  }

  /** Which of these seals are in a MINED anchor. */
  async minedSeals(seals: string[]): Promise<Set<string>> {
    if (seals.length === 0) return new Set();
    const rows: Array<{ commitment: string }> = await this.db.query(
      `SELECT DISTINCT trim(l.commitment) AS commitment
         FROM decision_anchor_leaves l JOIN decision_anchors a ON a.id = l.anchor_id
        WHERE a.status = 'mined' AND l.commitment = ANY($1::char(64)[])`,
      [seals],
    );
    return new Set(rows.map((r) => r.commitment));
  }

  // ---------------------------------------------------------------- the chain

  private async onChain(a: AnchorRow): Promise<OnChain> {
    if (a.status !== 'mined' && a.status !== 'broadcast') {
      return { reachable: false, checks: [], block_number: null, reason: `the anchor is ${a.status}, so there is no mined transaction to check` };
    }
    const hash = a.tx_hash.trim();
    const cached = this.verified.get(hash);
    if (cached) return cached;

    let tx: Record<string, string> | null;
    let receipt: Record<string, string> | null;
    try {
      [tx, receipt] = await Promise.all([this.rpc('eth_getTransactionByHash', [hash]), this.rpc('eth_getTransactionReceipt', [hash])]);
    } catch (e) {
      return {
        reachable: false,
        block_number: null,
        reason: `no RPC endpoint answered: ${e instanceof Error ? e.message : String(e)}`,
        checks: [{ name: 'the transaction can be read from the chain', ok: false, detail: 'no RPC endpoint answered — unknown, not failed' }],
      };
    }
    const sender = a.sender.trim().toLowerCase();
    const expected = `0x${ANCHOR_MAGIC_HEX}${a.root.trim()}`;
    const checks: Check[] = [
      { name: 'the transaction is on chain', ok: !!tx && !!receipt?.blockNumber, detail: tx ? undefined : 'the chain does not know this transaction' },
      { name: 'it succeeded', ok: receipt?.status === '0x1', detail: `status ${receipt?.status ?? 'none'}` },
      {
        name: 'it was sent from the anchoring address to itself',
        ok: tx?.from?.toLowerCase() === sender && tx?.to?.toLowerCase() === sender,
        detail: `from ${tx?.from} to ${tx?.to}`,
      },
      { name: 'its input is the anchor marker followed by this root', ok: tx?.input?.toLowerCase() === expected, detail: tx?.input },
      { name: `it is on chain ${a.chain_id}`, ok: !!tx?.chainId && parseInt(tx.chainId, 16) === Number(a.chain_id), detail: tx?.chainId },
    ];
    const result: OnChain = {
      reachable: true,
      checks: checks.map((c) => (c.ok ? { name: c.name, ok: true } : c)),
      block_number: receipt?.blockNumber ? parseInt(receipt.blockNumber, 16) : null,
    };
    if (checks.every((c) => c.ok)) this.verified.set(hash, result);
    return result;
  }

  private async rpc(method: string, params: unknown[]): Promise<any> {
    let last = '';
    for (const url of this.rpcUrls) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(8000),
        });
        const body = await r.json();
        if (body && 'result' in body) return body.result;
        last = `${url}: ${JSON.stringify(body?.error ?? body).slice(0, 120)}`;
      } catch (e) {
        last = `${url}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    this.logger.warn(`anchor rpc ${method} failed everywhere: ${last}`);
    throw new Error(last || 'no RPC endpoint configured');
  }

  shape(r: AnchorRow) {
    const hash = r.tx_hash.trim();
    return {
      id: Number(r.id),
      scheme: r.scheme,
      root: r.root.trim(),
      leaf_count: r.leaf_count,
      decisions:
        r.first_decision_id === null
          ? null
          : {
              first_id: Number(r.first_decision_id),
              last_id: Number(r.last_decision_id),
              first_ts: r.first_decision_ts,
              last_ts: r.last_decision_ts,
            },
      chain_id: Number(r.chain_id),
      sender: r.sender.trim(),
      tx_hash: hash,
      explorer_url: this.explorerTemplate ? this.explorerTemplate.replace('{hash}', hash) : null,
      status: r.status,
      block_number: r.block_number === null ? null : Number(r.block_number),
      gas_cost_usd: r.gas_cost_usd === null ? null : Number(r.gas_cost_usd),
      note: r.note,
      created_at: new Date(r.created_at).toISOString(),
      mined_at: r.mined_at ? new Date(r.mined_at).toISOString() : null,
    };
  }
}

const ANCHOR_SELECT = `
  SELECT id::text, scheme, root, leaf_count, first_decision_id::text, last_decision_id::text,
         to_char(first_decision_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS first_decision_ts,
         to_char(last_decision_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_decision_ts,
         chain_id, sender, nonce::text, tx_hash, status, block_number::text, gas_used::text,
         gas_cost_wei::text, gas_cost_usd::text, note, created_at, mined_at
    FROM decision_anchors`;
