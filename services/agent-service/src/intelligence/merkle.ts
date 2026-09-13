import { createHash } from 'node:crypto';

/**
 * arcana-anchor/v1 — the same construction as
 * services/decision-engine/internal/store/merkle.go, which BUILDS the roots.
 * This one CHECKS them. Two implementations on purpose: a proof checked by the
 * code that produced it proves only that the code agrees with itself.
 *
 *   leaf  = sha256(0x00 || commitment)      commitment as its 32 raw bytes
 *   node  = sha256(0x01 || left || right)
 *   odd   = the last node of a level is carried up unchanged
 *   order = decision id ascending
 *
 * On chain: a zero-value transaction from the anchoring address to itself whose
 * input is ANCHOR_MAGIC_HEX followed by the root.
 */
export const ANCHOR_SCHEME = 'arcana-anchor/v1';
/** "ARCANA" 0x00 0x01. */
export const ANCHOR_MAGIC_HEX = '415243414e410001';

const sha256 = (...parts: Buffer[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

export function leafHash(commitment: string): Buffer {
  const c = commitment.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(c)) throw new Error(`commitment ${commitment} is not 32 bytes of hex`);
  return sha256(Buffer.from([0x00]), Buffer.from(c, 'hex'));
}

const node = (left: Buffer, right: Buffer) => sha256(Buffer.from([0x01]), left, right);

function nextLevel(level: Buffer[]): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < level.length; i += 2) {
    out.push(i + 1 === level.length ? level[i] : node(level[i], level[i + 1]));
  }
  return out;
}

export function merkleRoot(leaves: Buffer[]): Buffer | null {
  if (leaves.length === 0) return null;
  let level = leaves;
  while (level.length > 1) level = nextLevel(level);
  return level[0];
}

export type ProofStep = { sibling: string; position: 'left' | 'right' };

export function merkleProof(leaves: Buffer[], index: number): ProofStep[] {
  if (index < 0 || index >= leaves.length) throw new Error(`leaf ${index} outside ${leaves.length} leaves`);
  const proof: ProofStep[] = [];
  let level = leaves;
  let i = index;
  while (level.length > 1) {
    if (i % 2 === 1) proof.push({ sibling: level[i - 1].toString('hex'), position: 'left' });
    else if (i + 1 < level.length) proof.push({ sibling: level[i + 1].toString('hex'), position: 'right' });
    level = nextLevel(level);
    i = Math.floor(i / 2);
  }
  return proof;
}

export function verifyProof(leaf: Buffer, proof: ProofStep[], root: Buffer): boolean {
  let cur = leaf;
  for (const step of proof) {
    const sib = Buffer.from(step.sibling, 'hex');
    cur = step.position === 'left' ? node(sib, cur) : node(cur, sib);
  }
  return cur.equals(root);
}
