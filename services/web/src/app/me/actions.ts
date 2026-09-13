'use server';

import { revalidatePath } from 'next/cache';
import { authed } from '@/lib/session';

/**
 * Register the signed-in wallet's creator profile.
 *
 * THE WALLET IS NOT SENT. The service takes it from the verified session and
 * refuses to accept one in the body — a profile claiming an address it had not
 * proved would be trusted by every per-wallet check downstream. So the only
 * thing that travels is the handle.
 *
 * THE CONFLICT IS RETURNED AS ITSELF. One wallet gets one profile, and the
 * service says which handle it already has. Flattening that into "could not
 * create" would leave somebody trying a different name against a rule that has
 * nothing to do with the name.
 */
export async function createProfile(
  handle: string,
): Promise<{ ok: true; data: { id: string; handle: string } } | { ok: false; status: number | null; reason: string; code: string | null }> {
  const r = await authed<{ id: string; handle: string }>('/v1/creators', {
    method: 'POST',
    body: { handle },
  });
  if (r.ok) {
    revalidatePath('/me');
    return { ok: true, data: r.data };
  }
  const body = (r.body ?? {}) as Record<string, unknown>;
  const inner = body.error as Record<string, unknown> | undefined;
  const code = typeof body.code === 'string' ? body.code : typeof inner?.code === 'string' ? inner.code : null;
  return { ok: false, status: r.status, reason: r.reason, code };
}
