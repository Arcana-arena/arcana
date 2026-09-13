/**
 * Anchors — every Merkle root of decision commitments written on chain.
 *
 * WHY THIS PAGE EXISTS. A proof nobody outside can trace is not a proof. Each row
 * names the transaction, so anyone can read the root out of its input with any
 * Robinhood Chain RPC and check a decision against it without trusting ARCANA's
 * database. The cost row is here because anchoring is paid by the platform, and
 * a cost nobody can see is one nobody can check.
 */
import Link from 'next/link';
import { agent, qs } from '@/lib/api';
import { int, utc } from '@/lib/format';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Callout, Empty, Failed } from '@/components/ds/states';

export const dynamic = 'force-dynamic';

type Anchor = {
  id: number;
  root: string;
  leaf_count: number;
  decisions: { first_id: number; last_id: number; first_ts: string; last_ts: string };
  chain_id: number;
  sender: string;
  tx_hash: string;
  explorer_url: string | null;
  status: string;
  block_number: number | null;
  gas_cost_usd: number | null;
  created_at: string;
  mined_at: string | null;
};

type AnchorList = {
  scheme: string;
  items: Anchor[];
  page: number;
  has_more: boolean;
  totals: { mined: number; decisions_anchored: number; gas_cost_usd: number | null; last_mined_at: string | null; paid_by: string };
  waiting: { sealed_decisions: number; oldest: string | null; note: string };
};

type SP = { [k: string]: string | string[] | undefined };

export default async function AnchorsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.page) ? sp.page[0] : sp.page;
  const page = Math.max(1, Number.parseInt(raw || '1', 10) || 1);
  const r = await agent<AnchorList>(`/v1/anchors${qs({ page: String(page), page_size: '50' })}`);
  const d = r.ok ? r.data : null;

  return (
    <div className="page">
      <Header />
      <div className="sec" style={{ paddingTop: 32, paddingBottom: 18, borderBottom: 'none' }}>
        <h1>Anchors</h1>
        <div className="m2" style={{ fontSize: 12.5, marginTop: 4, maxWidth: 760, lineHeight: 1.5 }}>
          Every decision is sealed with a commitment when it is recorded. Every fifteen minutes, the new commitments
          become the leaves of a Merkle tree and its root is written into a transaction on Robinhood Chain. After that,
          changing any anchored decision breaks a proof anyone can check against the chain.{' '}
          <Link href="/docs/private-agents">How the proof works</Link>
        </div>
      </div>

      <div className="sec" style={{ paddingBottom: 40, borderBottom: 'none' }}>
        {!r.ok ? (
          <Failed what="The anchor list" error={r} />
        ) : (
          <>
            <div className="stat-row" style={{ marginBottom: 16, display: 'flex', gap: 28, flexWrap: 'wrap' }}>
              <div>
                <div className="lbl">ANCHORS MINED</div>
                <div className="mono" style={{ fontSize: 20 }}>{int(d!.totals.mined)}</div>
              </div>
              <div>
                <div className="lbl">DECISIONS ANCHORED</div>
                <div className="mono" style={{ fontSize: 20 }}>{int(d!.totals.decisions_anchored)}</div>
              </div>
              <div>
                <div className="lbl">WAITING FOR THE NEXT ANCHOR</div>
                <div className="mono" style={{ fontSize: 20 }}>{int(d!.waiting.sealed_decisions)}</div>
              </div>
              <div title={d!.totals.paid_by}>
                <div className="lbl">GAS · PAID BY ARCANA</div>
                <div className="mono" style={{ fontSize: 20 }}>
                  {d!.totals.gas_cost_usd === null ? '—' : `$${d!.totals.gas_cost_usd.toFixed(4)}`}
                </div>
              </div>
            </div>

            {d!.totals.mined === 0 && d!.waiting.sealed_decisions > 0 ? (
              <div style={{ marginBottom: 16 }}>
                <Callout tone="warn">
                  <strong>Nothing has been anchored yet.</strong> {int(d!.waiting.sealed_decisions)} sealed decision(s)
                  are protected by ARCANA&rsquo;s database alone until the first root is mined
                  {d!.waiting.oldest ? `; the oldest was recorded ${utc(d!.waiting.oldest)}` : ''}.
                </Callout>
              </div>
            ) : null}

            {d!.items.length === 0 ? (
              <Empty title="No anchor has been written">No root has been sent to the chain yet.</Empty>
            ) : (
              <div className="scroll-x">
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Mined (UTC)</th>
                      <th className="r">Decisions</th>
                      <th>Root</th>
                      <th>Transaction</th>
                      <th className="r">Block</th>
                      <th>Status</th>
                      <th className="r">Gas · USD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d!.items.map((a) => (
                      <tr key={a.id}>
                        <td className="mono m2">{a.id}</td>
                        <td className="mono m2" style={{ whiteSpace: 'nowrap' }}>{a.mined_at ? utc(a.mined_at) : '—'}</td>
                        <td className="r mono" title={`decisions ${a.decisions.first_id}–${a.decisions.last_id}`}>
                          {int(a.leaf_count)}
                        </td>
                        <td className="mono m3" style={{ fontSize: 11 }} title={a.root}>
                          {a.root.slice(0, 16)}…
                        </td>
                        <td className="mono" style={{ fontSize: 11 }} title={a.tx_hash}>
                          {a.explorer_url ? (
                            <a href={a.explorer_url} target="_blank" rel="noreferrer">{a.tx_hash.slice(0, 14)}…</a>
                          ) : (
                            `${a.tx_hash.slice(0, 14)}…`
                          )}
                        </td>
                        <td className="r mono m2">{a.block_number ?? '—'}</td>
                        <td className={a.status === 'mined' ? 'up mono' : a.status === 'reverted' || a.status === 'dropped' ? 'dn mono' : 'am mono'}>
                          {a.status}
                        </td>
                        <td className="r mono m2">{a.gas_cost_usd === null ? '—' : a.gas_cost_usd.toFixed(5)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {page > 1 || d!.has_more ? (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: 12 }}>
                {page > 1 ? <Link href={`/anchors?page=${page - 1}`}>← Newer</Link> : <span />}
                {d!.has_more ? <Link href={`/anchors?page=${page + 1}`}>Older →</Link> : <span />}
              </div>
            ) : null}
          </>
        )}
      </div>
      <Footer />
    </div>
  );
}
