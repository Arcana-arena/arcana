/**
 * PRIVATE AGENT. PUBLIC PROOF. — the rules, in one place.
 *
 * An agent's INTELLIGENCE is how it decides: its mandate, the template and
 * parameters behind it, its risk rules, and the prompt, raw response, model,
 * thesis and rationale behind each decision. A creator may keep that private.
 *
 * Its RECORD is what it did: every decision (action, symbol, quantity, time),
 * every execution and transaction hash, performance, score, rank, competition
 * history and behavioural DNA. That is public for every agent, private or not.
 *
 * Every read model that touches intelligence masks through these functions, so
 * "what counts as private" has one definition — and private-agent-verify plants
 * a canary in each private field and fails if any public surface prints it.
 */

export type Visibility = 'public' | 'private';

export const COMMITMENT_SCHEME = 'arcana-commitment/v1';

/** The one sentence a non-technical reader is shown next to a commitment. */
export const COMMITMENT_EXPLAINED =
  'This fingerprint was recorded the moment the decision was made. If the hidden reasoning behind it ' +
  'were changed afterwards, it would no longer match.';

/** What a private agent withholds, by name, so a page can say what is missing rather than show a gap. */
export const WITHHELD = [
  'mandate',
  'mandate template and parameters',
  'risk rules',
  'protective levels',
  'prompt',
  'raw model response',
  'model and version',
  'thesis',
  'rationale',
] as const;

export const PRIVATE_NOTE =
  'The creator keeps this agent’s intelligence private: its mandate, risk rules, prompts, model and ' +
  'reasoning. Its decisions, executions, performance, score, rank and competition history are public, ' +
  'and every decision carries a commitment proving its hidden reasoning was not changed afterwards.';

export function isPrivate(visibility: unknown): boolean {
  return visibility === 'private';
}

/**
 * The block every agent-level response carries, so a reader never has to infer
 * privacy from which fields happen to be null. A null mandate on a public
 * deterministic agent and a withheld one on a private agent are different facts.
 */
export function intelligenceBlock(visibility: unknown, disclosedAt: string | null = null) {
  if (isPrivate(visibility)) {
    return {
      visibility: 'private' as const,
      private: true,
      withheld: [...WITHHELD],
      disclosed_at: null,
      note: PRIVATE_NOTE,
    };
  }
  return {
    visibility: 'public' as const,
    private: false,
    withheld: [] as string[],
    disclosed_at: disclosedAt,
    note: disclosedAt
      ? `This agent was private until ${disclosedAt}, when its creator made it public. Everything it ` +
        'withheld is readable now, including the evidence behind decisions made while it was private.'
      : null,
  };
}

/** An `agents` entity (camelCase), with its intelligence removed when private. */
export function maskAgentEntity<T extends object>(agent: T, disclosedAt: string | null = null) {
  const a = agent as Record<string, unknown>;
  if (!isPrivate(a.visibility)) {
    return { ...a, intelligence: intelligenceBlock('public', disclosedAt) };
  }
  return {
    ...a,
    mandate: null,
    mandateTemplate: null,
    mandateParams: null,
    mandateSource: null,
    riskProfile: null,
    intelligence: intelligenceBlock('private'),
  };
}

/**
 * Measured DNA, minus the values that are copies of the declared risk profile.
 * What the agent DID stays; what its owner TOLD it does not.
 */
export function withoutConfiguredLimits<T>(riskPersonality: T): T {
  if (!riskPersonality || typeof riskPersonality !== 'object') return riskPersonality;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(riskPersonality as Record<string, unknown>)) {
    if (k.startsWith('configured_') || k === 'risk_budget_utilisation') continue;
    out[k] = v;
  }
  return out as T;
}

// ---------------------------------------------------------------- manifests

/**
 * Parse a manifest written by the decision engine (store/commitment.go).
 * Returns null for anything that is not exactly that format — a verifier that
 * guessed at a malformed manifest would be verifying its own guess.
 */
export function parseManifest(body: string): { scheme: string; fields: Record<string, unknown> } | null {
  if (!body.endsWith('\n')) return null;
  const lines = body.slice(0, -1).split('\n');
  const scheme = lines.shift();
  if (scheme !== COMMITMENT_SCHEME) return null;
  const fields: Record<string, unknown> = {};
  for (const line of lines) {
    const at = line.indexOf(': ');
    if (at <= 0) return null;
    const key = line.slice(0, at);
    try {
      fields[key] = JSON.parse(line.slice(at + 2));
    } catch {
      return null;
    }
  }
  return { scheme, fields };
}

/** JSON with sorted keys, for comparing a JSONB value with the manifest's copy. */
export function stableJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** '' and null are the same fact on a decision row; see commitment.go jsonText. */
export function blankToNull(v: unknown): unknown {
  return v === '' || v === undefined ? null : v;
}
