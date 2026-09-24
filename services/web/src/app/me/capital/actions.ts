'use server';

import { revalidatePath } from 'next/cache';
import { authed } from '@/lib/session';

/**
 * The one write this page makes: a supply, borrow or repay by the owner's
 * hand. It returns the engine's own outcome — "mined", "refused" with the rule
 * that refused it, "reverted" with the transaction — never a bare "done".
 */
export type ManualOutcome = {
  kind: 'supply' | 'borrow' | 'repay' | 'withdraw';
  amount: number;
  status: string;
  reason: string;
  refusal_code?: string;
  refusal_detail?: string;
  tx_hash?: string;
  approve_tx_hash?: string;
};

type Fail = { ok: false; status: number | null; reason: string; code: string | null };

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export async function capitalManual(
  agentId: string,
  kind: 'supply' | 'borrow' | 'repay' | 'withdraw',
  amount: number,
): Promise<{ ok: true; data: ManualOutcome } | Fail> {
  const r = await authed<ManualOutcome>(`/v1/agents/${agentId}/capital/manual`, {
    method: 'POST',
    body: { kind, amount },
  });
  if (r.ok) {
    revalidatePath('/me/capital');
    revalidatePath(`/agents/${agentId}`);
    return { ok: true, data: r.data };
  }
  const err = rec(rec(r.body).error);
  const code = typeof err.code === 'string' ? err.code : typeof rec(r.body).code === 'string' ? (rec(r.body).code as string) : null;
  const msg = typeof err.message === 'string' ? err.message : typeof rec(r.body).message === 'string' ? (rec(r.body).message as string) : r.reason;
  return { ok: false, status: r.status, reason: msg, code };
}
