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
export async function deriveSubscriptionWallet(
  subscriptionId: string,
): Promise<{ ok: true; address: string } | { ok: false; status: number | null; reason: string }> {
  const r = await authed<{ wallet_address: string | null }>(`/v1/subscriptions/${subscriptionId}/wallet`, {
    method: 'POST',
  });
  if (!r.ok) return { ok: false, status: r.status, reason: r.reason };
  if (!r.data?.wallet_address) {
    return { ok: false, status: null, reason: 'the service answered without a wallet address, so none is shown' };
  }
  revalidatePath('/me/subscriptions');
  return { ok: true, address: r.data.wallet_address };
}
