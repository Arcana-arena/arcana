'use server';

import { revalidatePath } from 'next/cache';
import { MARKETPLACE_API } from '@/lib/api';
import { authed } from '@/lib/session';
import type { PauseResult, RiskResult } from '../../shapes';

/**
 * The writes the manage page makes.
 *
 * EVERY ONE RETURNS THE SERVICE'S OWN ANSWER, not a boolean. Three of these
 * produce a response whose whole value is in what it says: pausing lists the
 * protective levels that stop being watched, setting risk names every key the
 * engine will not read and every key whose NAME lies about its scale, and
 * retiring says what does and does not happen to the positions. Collapsing any
 * of them into "saved" would delete the part that matters.
 *
 * NOTHING HERE INTERPRETS A REFUSAL MORE FAVOURABLY THAN THE SERVICE DID. A
 * mandate edit refused because the agent is active comes back with the
 * service's sentence, which explains evolve; a generic "could not save" would
 * leave the owner trying the same thing again.
 */

type Fail = { ok: false; status: number | null; reason: string; code: string | null };
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const codeOf = (body: Record<string, unknown> | null) => {
  const c = body?.code ?? asRecord(body?.error).code;
  return typeof c === 'string' ? c : null;
};

export async function setRisk(
  agentId: string,
  riskProfile: Record<string, unknown>,
): Promise<{ ok: true; data: RiskResult } | Fail> {
  const r = await authed<RiskResult>(`/v1/agents/${agentId}/risk`, {
    method: 'PATCH',
    body: { riskProfile },
  });
  if (r.ok) {
    revalidatePath(`/me/agents/${agentId}`);
    return { ok: true, data: r.data };
  }
  return { ok: false, status: r.status, reason: r.reason, code: codeOf(r.body) };
}

export async function pauseAgent(
  agentId: string,
  because: string,
): Promise<{ ok: true; data: PauseResult } | Fail> {
  const r = await authed<PauseResult>(`/v1/agents/${agentId}/pause`, {
    method: 'POST',
    body: { because: because || undefined },
  });
  if (r.ok) {
    revalidatePath(`/me/agents/${agentId}`);
    revalidatePath('/me');
    return { ok: true, data: r.data };
  }
  return { ok: false, status: r.status, reason: r.reason, code: codeOf(r.body) };
}

export async function resumeAgent(agentId: string): Promise<{ ok: true; data: PauseResult } | Fail> {
  const r = await authed<PauseResult>(`/v1/agents/${agentId}/resume`, { method: 'POST' });
  if (r.ok) {
    revalidatePath(`/me/agents/${agentId}`);
    revalidatePath('/me');
    return { ok: true, data: r.data };
  }
  return { ok: false, status: r.status, reason: r.reason, code: codeOf(r.body) };
}

/**
 * Retire an agent.
 *
 * WHAT THIS DOES NOT DO is why the confirmation is worded the way it is. The
 * service sets the status and removes the agent's seat from every running
 * competition. It does NOT close positions, and it does not return funds — the
 * design says it does both, and it does neither. Whatever the agent holds stays
 * in its wallet, and the key is exportable afterwards exactly as before.
 */
export async function retireAgent(agentId: string): Promise<{ ok: true; data: unknown } | Fail> {
  const r = await authed<unknown>(`/v1/agents/${agentId}/retire`, { method: 'POST' });
  if (r.ok) {
    revalidatePath(`/me/agents/${agentId}`);
    revalidatePath('/me');
    return { ok: true, data: r.data };
  }
  return { ok: false, status: r.status, reason: r.reason, code: codeOf(r.body) };
}

/**
 * Create the next version of an agent.
 *
 * The child is a DRAFT. The parent is not retired until the child is
 * ACTIVATED, and at that moment the parent's seat in any running competition is
 * handed to the child — the seat moves rather than being lost. What is lost is
 * the record: the child starts with no decisions and is unranked until it has
 * recorded enough, while the parent's score freezes where it stands.
 */
export async function evolveAgent(
  agentId: string,
  mandate: string,
  visibility?: 'public' | 'private',
): Promise<{ ok: true; data: { id: string } } | Fail> {
  const r = await authed<{ id: string }>(`/v1/agents/${agentId}/evolve`, {
    method: 'POST',
    body: { ...(mandate ? { mandate } : {}), ...(visibility ? { visibility } : {}) },
  });
  if (r.ok) {
    revalidatePath('/me');
    return { ok: true, data: r.data };
  }
  return { ok: false, status: r.status, reason: r.reason, code: codeOf(r.body) };
}

/** Derive the trading wallet. Idempotent — the address is a function of the id. */
export async function ensureWallet(agentId: string): Promise<{ ok: true; data: { address: string } } | Fail> {
  const r = await authed<{ address: string }>(`/v1/agents/${agentId}/wallet`);
  if (r.ok) {
    revalidatePath(`/me/agents/${agentId}`);
    return { ok: true, data: r.data };
  }
  return { ok: false, status: r.status, reason: r.reason, code: codeOf(r.body) };
}

/**
 * Hand the owner their private key.
 *
 * BEHIND THREE STEPS IN THE UI AND RATE LIMITED TO THREE AN HOUR IN THE
 * SERVICE. This is the one call on the platform that returns key material, so
 * the cost of a stolen session is bounded by how often it can be made before
 * anybody notices. The key is returned once and never stored by this page.
 */
export async function exportKey(
  agentId: string,
): Promise<{ ok: true; data: { address: string; private_key: string } } | Fail> {
  const r = await authed<{ address: string; private_key: string }>(`/v1/agents/${agentId}/wallet/export`, {
    method: 'POST',
  });
  if (r.ok) return { ok: true, data: r.data };
  return { ok: false, status: r.status, reason: r.reason, code: codeOf(r.body) };
}

/**
 * Put an agent on the marketplace, or take it off.
 *
 * THE PAYEE GATE LIVES IN THE SERVICE AND IS NOT WORKED AROUND HERE. Publishing
 * asks arca-service whether this agent's creator can be paid at all, and
 * refuses with `creator_has_no_wallet` if not — a listing nobody could ever buy
 * is worse than no listing, and the refusal is returned unchanged so the owner
 * is told the actual thing to fix.
 *
 * REACTIVATING RUNS THE SAME CHECK. A listing switched off because its creator
 * had no wallet must not come back without one, or the gate is a formality that
 * one toggle walks around.
 */
export async function publishListing(
  agentId: string,
  priceUsd: number,
): Promise<{ ok: true; data: { id: string } } | Fail> {
  const r = await authed<{ id: string }>('/v1/marketplace/listings', {
    method: 'POST',
    base: MARKETPLACE_API,
    body: {
      agentId,
      accessType: 'subscription',
      priceUsd,
      // The amount a buyer actually sends is resolved from this by the same
      // code that verifies the payment. Setting it equal to the price keeps
      // one number on the listing rather than two that can disagree.
      arcaGateAmount: priceUsd,
      active: true,
    },
  });
  if (r.ok) {
    revalidatePath(`/me/agents/${agentId}`);
    revalidatePath('/me');
    revalidatePath('/marketplace');
    return { ok: true, data: r.data };
  }
  return { ok: false, status: r.status, reason: r.reason, code: codeOf(r.body) };
}

export async function updateListing(
  agentId: string,
  listingId: string,
  patch: { priceUsd?: number; active?: boolean },
): Promise<{ ok: true; data: unknown } | Fail> {
  const r = await authed<unknown>(`/v1/marketplace/listings/${listingId}`, {
    method: 'PATCH',
    base: MARKETPLACE_API,
    body: patch,
  });
  if (r.ok) {
    revalidatePath(`/me/agents/${agentId}`);
    revalidatePath('/me');
    revalidatePath('/marketplace');
    return { ok: true, data: r.data };
  }
  return { ok: false, status: r.status, reason: r.reason, code: codeOf(r.body) };
}

/**
 * Make a private agent public — permanently.
 *
 * `confirm: true` is sent because the service requires it, and the service
 * requires it because there is no way back: the database refuses a public agent
 * becoming private. The panel states every consequence before the button.
 */
export async function discloseAgent(
  agentId: string,
): Promise<{ ok: true; data: { disclosed_at: string; note: string } } | Fail> {
  const r = await authed<{ disclosed_at: string; note: string }>(`/v1/agents/${agentId}/disclose`, {
    method: 'POST',
    body: { confirm: true },
  });
  if (r.ok) {
    revalidatePath(`/me/agents/${agentId}`);
    revalidatePath(`/agents/${agentId}`);
    revalidatePath('/me');
    return { ok: true, data: r.data };
  }
  return { ok: false, status: r.status, reason: r.reason, code: codeOf(r.body) };
}

/**
 * Enter an agent into a competition.
 *
 * THE SAME DOOR AS THE API, with the same gates: ownership first, then the
 * $ARCA entry gates in admit(), and a refusal once the competition has ticked.
 * That refusal is returned unchanged — it names the reason entry closes.
 */
export async function enterCompetition(
  agentId: string,
  competitionId: string,
): Promise<{ ok: true; data: unknown } | Fail> {
  const r = await authed<unknown>(`/v1/competitions/${competitionId}/participants`, {
    method: 'POST',
    body: { agentId },
  });
  if (r.ok) {
    revalidatePath(`/me/agents/${agentId}`);
    revalidatePath('/seasons');
    return { ok: true, data: r.data };
  }
  return { ok: false, status: r.status, reason: r.reason, code: codeOf(r.body) };
}

/** Open the intelligence behind one decision of a private agent — permanently, and on its public record. */
export async function revealDecision(
  agentId: string,
  decisionId: number,
): Promise<{ ok: true; data: { disclosed_at: string; commitment: string | null; note: string } } | Fail> {
  const r = await authed<{ disclosed_at: string; commitment: string | null; note: string }>(
    `/v1/agents/${agentId}/decisions/${decisionId}/reveal`,
    { method: 'POST' },
  );
  if (r.ok) {
    revalidatePath(`/me/agents/${agentId}`);
    revalidatePath(`/agents/${agentId}`);
    return { ok: true, data: r.data };
  }
  return { ok: false, status: r.status, reason: r.reason, code: codeOf(r.body) };
}
