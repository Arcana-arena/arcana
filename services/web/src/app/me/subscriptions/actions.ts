'use server';

import { revalidatePath } from 'next/cache';
import { authed } from '@/lib/session';

/**
 * Derive this subscription's trading wallet.
 *
 * THE MISSING STEP. The claim panel tells a buyer to derive and fund the wallet
 * before the first tick, and until now no page could: the route existed and
 * nothing called it, so a paying customer reached "Access granted" and then a
 * subscription the agent could never trade for.
 *
 * ONLY THE SUBSCRIPTION ID IS SENT. The address is computed by the signer from
 * that id and the owner is taken from the session, so there is no field here in
 * which a client could name a wallet. Idempotent: asking twice returns the same
 * address.
 */
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
/**
 * The service's own code, kept rather than dropped.
 *
 * `authed()` already unwraps the envelope and hands back `body`; this action
 * was throwing it away and returning the sentence alone. The signer names its
 * refusals — `signer_unavailable` is an outage worth retrying,
 * `wallet_blocked` is not — and a page holding only prose cannot tell a
 * customer which of those just happened.
 */
const codeOf = (body: Record<string, unknown> | null) => {
  const c = body?.code ?? asRecord(body?.error).code;
  return typeof c === 'string' ? c : null;
};

export async function deriveSubscriptionWallet(
  subscriptionId: string,
): Promise<
  { ok: true; address: string } | { ok: false; status: number | null; reason: string; code: string | null }
> {
  const r = await authed<{ wallet_address: string | null }>(`/v1/subscriptions/${subscriptionId}/wallet`, {
    method: 'POST',
  });
  if (!r.ok) return { ok: false, status: r.status, reason: r.reason, code: codeOf(r.body) };
  if (!r.data?.wallet_address) {
    return {
      ok: false,
      status: null,
      code: null,
      reason: 'the service answered without a wallet address, so none is shown',
    };
  }
  revalidatePath('/me/subscriptions');
  return { ok: true, address: r.data.wallet_address };
}
