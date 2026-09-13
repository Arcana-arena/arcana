'use server';

import { authed } from '@/lib/session';

/**
 * Creating an agent, in the two steps the platform actually has.
 *
 * A DRAFT IS NOT A LIVE AGENT, and the wizard's last step is where that changes.
 * `POST /v1/agents` writes a row with status `draft`: nothing ticks for it,
 * nothing is scored, and nothing can be lost. `POST /v1/agents/:id/activate` is
 * the act that costs a slot, checks the entitlement, and retires a parent if
 * this is a version. Splitting them means a half-finished wizard leaves a draft
 * rather than a live agent trading on an unfinished configuration.
 *
 * THE CREATE RESPONSE IS RETURNED WHOLE. It carries `risk_profile_unrecognised`
 * and `risk_profile_ambiguous` — the keys nothing will read, and the keys whose
 * names lie about their scale. Those have to reach the owner at the moment they
 * set them, which is here, not in a log.
 */

type Fail = { ok: false; status: number | null; reason: string; code: string | null };
const codeOf = (body: Record<string, unknown> | null) => {
  const inner = body?.error as Record<string, unknown> | undefined;
  const c = body?.code ?? inner?.code;
  return typeof c === 'string' ? c : null;
};

export type Created = {
  id: string;
  name: string;
  version: number;
  status: string;
  mandate: string | null;
  riskProfile: Record<string, unknown> | null;
  risk_profile_unrecognised?: string[];
  risk_profile_note?: string;
  risk_profile_ambiguous?: string[];
  risk_profile_ambiguous_note?: string;
};

export async function createAgent(input: {
  name: string;
  strategyType?: string;
  assetUniverse: string;
  mandate?: string;
  mandateTemplate?: string;
  mandateParams?: Record<string, unknown>;
  riskProfile: Record<string, unknown>;
  visibility?: 'public' | 'private';
}): Promise<{ ok: true; data: Created } | Fail> {
  const body: Record<string, unknown> = {
    name: input.name,
    assetUniverse: input.assetUniverse,
    // PRIVATE AGENT. PUBLIC PROOF. Sent explicitly either way, so the choice the
    // owner made is the choice recorded rather than a default nobody saw.
    visibility: input.visibility ?? 'public',
    // The service takes this as a JSON STRING and parses it into jsonb. Sending
    // an object here is a 400 that names the field — which is the API being
    // strict rather than silently ignoring it, and worth matching exactly.
    riskProfile: JSON.stringify(input.riskProfile),
  };
  if (input.strategyType) body.strategyType = input.strategyType;
  if (input.mandateTemplate) {
    body.mandateTemplate = input.mandateTemplate;
    if (input.mandateParams) body.mandateParams = input.mandateParams;
  } else if (input.mandate) {
    body.mandate = input.mandate;
  }

  const r = await authed<Created>('/v1/agents', { method: 'POST', body });
  if (r.ok) return { ok: true, data: r.data };
  return { ok: false, status: r.status, reason: r.reason, code: codeOf(r.body) };
}

/**
 * Activate the draft.
 *
 * THIS IS THE STEP THAT COSTS SOMETHING. It takes a slot, it is checked against
 * the $ARCA entitlement, and if this agent is a version it retires its parent
 * in the same transaction. The refusal for a full slot names the cap and says
 * how to free one, so it is returned unchanged.
 */
export async function activateAgent(agentId: string): Promise<{ ok: true; data: unknown } | Fail> {
  const r = await authed<unknown>(`/v1/agents/${agentId}/activate`, { method: 'POST' });
  if (r.ok) return { ok: true, data: r.data };
  return { ok: false, status: r.status, reason: r.reason, code: codeOf(r.body) };
}

/**
 * Derive the agent's wallet, or adopt one the owner already controls.
 *
 * IMPORTING IS THE DANGEROUS OPTION AND THE SERVICE SAYS SO IN ITS RESPONSE.
 * ARCANA can sign ANYTHING from an imported key, not only trades — the signer
 * restricts what it will build, but that is ARCANA restricting itself rather
 * than a property of the key. The wallet must be one used for this agent and
 * nothing else.
 */
export async function deriveWallet(agentId: string): Promise<{ ok: true; data: { address: string } } | Fail> {
  const r = await authed<{ address: string }>(`/v1/agents/${agentId}/wallet`);
  if (r.ok) return { ok: true, data: r.data };
  return { ok: false, status: r.status, reason: r.reason, code: codeOf(r.body) };
}

export async function importWallet(
  agentId: string,
  privateKey: string,
): Promise<{ ok: true; data: Record<string, unknown> } | Fail> {
  const r = await authed<Record<string, unknown>>(`/v1/agents/${agentId}/wallet/import`, {
    method: 'POST',
    body: { privateKey },
  });
  if (r.ok) return { ok: true, data: r.data };
  return { ok: false, status: r.status, reason: r.reason, code: codeOf(r.body) };
}
