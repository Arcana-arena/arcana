'use server';

import { MARKETPLACE_API } from '@/lib/api';
import { authed } from '@/lib/session';
import type { AlreadyUsedBody, ClaimOutcome, PendingBody, ShortBody, Unclaimed, WrongRecipientBody } from '../shapes';

/**
 * The two writes this surface makes, and the one read that costs a chain scan.
 *
 * SERVER ACTIONS RATHER THAN A GET PAGE. Claiming a payment is a mutation with
 * a UNIQUE constraint behind it; putting it on a page render would fire it on a
 * refresh, on a prefetch, and on a link preview in a chat client. The form
 * posts, the action runs once, and the result is rendered from what came back.
 *
 * THE ERROR BODY IS CARRIED THROUGH INTACT. Three of the outcomes below are
 * separate screens, and each needs fields the others do not have: the shortfall
 * and what to do about it; the addresses the money actually reached; what this
 * hash already bought and whether that term is still running. Flattening them
 * into "payment failed" would leave a person who has just lost money with a
 * page that tells them nothing they can act on.
 *
 * NOTHING HERE INTERPRETS A FAILURE MORE FAVOURABLY THAN THE SERVICE DID. An
 * unreachable chain comes back as `other` with the service's own 503 sentence,
 * not as "still confirming" — "we could not check" and "not yet" are different
 * answers and only one of them means the buyer should wait.
 */

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export async function claimPayment(listingId: string, txHash: string): Promise<ClaimOutcome> {
  const trimmed = (txHash ?? '').trim();
  // Checked here as well as in the service, so an obviously malformed hash does
  // not cost a signed-in round trip. The service still checks it: this is a
  // convenience, never the guard.
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    return {
      kind: 'other',
      code: 'malformed_tx_hash',
      status: 400,
      reason:
        'A transaction hash is 0x followed by 64 hexadecimal characters. This one is ' +
        `${trimmed.length} characters long, so nothing was submitted.`,
      body: null,
    };
  }

  const r = await authed<{ granted: true; listing_id: string; tx_hash: string; amount: string; confirmations: number; expires_at: string }>(
    `/v1/marketplace/listings/${listingId}/claim-payment`,
    { method: 'POST', body: { txHash: trimmed }, base: MARKETPLACE_API },
  );

  if (r.ok) return { kind: 'granted', data: r.data };

  const body = asRecord(r.body);
  const code = typeof body.code === 'string' ? body.code : null;

  if (code === 'insufficient_confirmations' && body.pending === true) {
    return { kind: 'pending', body: body as unknown as PendingBody };
  }
  if (code === 'insufficient_amount') {
    return { kind: 'short', body: body as unknown as ShortBody };
  }
  if (code === 'no_matching_transfer') {
    return { kind: 'wrong_recipient', body: body as unknown as WrongRecipientBody };
  }
  if (code === 'tx_already_claimed') {
    return { kind: 'already_used', body: body as unknown as AlreadyUsedBody };
  }
  return { kind: 'other', code, status: r.status, reason: r.reason, body: r.body };
}

/**
 * Transfers the caller already made to this creator that nothing has claimed.
 *
 * IT GRANTS NOTHING. It returns candidate hashes and claiming one still goes
 * through every check unchanged. Rate limited upstream because each call reads
 * the chain, and the bound of the search is returned rather than hidden — an
 * empty list here means "not in the last half hour", not "you did not pay".
 */
export async function findUnclaimed(
  listingId: string,
): Promise<
  { ok: true; data: Unclaimed } | { ok: false; status: number | null; reason: string; code: string | null }
> {
  const r = await authed<Unclaimed>(`/v1/marketplace/listings/${listingId}/unclaimed-payments`, {
    base: MARKETPLACE_API,
  });
  if (r.ok) return { ok: true, data: r.data };
  // THE CODE MATTERS MOST ON THIS ONE. It is rate limited upstream precisely
  // because each call reads the chain, so `rate_limited` is the likeliest
  // refusal a buyer meets here — and it means "ask again in a moment", which
  // is the opposite of what `payment_verification_unavailable` means. Both
  // used to arrive as a sentence with the code already discarded.
  const c = (r.body?.code ?? (r.body?.error as Record<string, unknown> | undefined)?.code) as unknown;
  return { ok: false, status: r.status, reason: r.reason, code: typeof c === 'string' ? c : null };
}
