'use server';

import { revalidatePath } from 'next/cache';
import { authed } from '@/lib/session';

/**
 * The two writes this page makes: record what the signed-in wallet would
 * supply to an agent, and take it back. Neither moves money — the service
 * stores a row and nothing reads it to sign anything.
 */
export type MyIndication = {
  id: number;
  agent_id: string;
  agent_name: string;
  agent_status: string;
  amount_usdg: number;
  rate_bps: number | null;
  agent_at: { status: 'no_record' | 'unrated' | 'rated'; score: number | null; tier: number };
  created_at: string;
  ended_at: string | null;
  ended_how: 'withdrawn' | 'replaced' | null;
};

export type MyIndications = {
  wallet: string;
  funded: false;
  open: MyIndication[];
  open_total_usdg: number;
  ended: MyIndication[];
  max_open: number;
};

type Fail = { ok: false; status: number | null; reason: string; code: string | null };
type Outcome = { ok: true; data: MyIndications } | Fail;

export async function indicate(agentId: string, amountUsdg: number, rateBps: number | null): Promise<Outcome> {
  const r = await authed<MyIndications>(`/v1/credit-market/agents/${agentId}/indication`, {
    method: 'PUT',
    body: rateBps === null ? { amount_usdg: amountUsdg } : { amount_usdg: amountUsdg, rate_bps: rateBps },
  });
  if (!r.ok) return { ok: false, status: r.status, reason: r.reason, code: r.code };
  revalidatePath('/credit-market');
  return r;
}

export async function withdrawIndication(agentId: string): Promise<Outcome> {
  const r = await authed<MyIndications>(`/v1/credit-market/agents/${agentId}/indication`, { method: 'DELETE' });
  if (!r.ok) return { ok: false, status: r.status, reason: r.reason, code: r.code };
  revalidatePath('/credit-market');
  return r;
}
