/**
 * Anchored on chain — which root contains this decision, and how to check it
 * without asking ARCANA.
 *
 * The commitment above proves the reasoning was fixed when the decision was
 * recorded — as long as ARCANA's database is honest. This is what removes that
 * condition: the root is in a transaction on Robinhood Chain, and the proof
 * below leads from this decision to it. The checks are listed, not summarised,
 * and the transaction is named so anyone can read it with any RPC.
 */
import Link from 'next/link';
import { agent } from '@/lib/api';
import { utc } from '@/lib/format';
import { Failed } from '@/components/ds/states';
import type { AnchorProofResp } from '../shapes';

export async function AnchorBlock({ agentId, decisionId }: { agentId: string; decisionId: string }) {
  const r = await agent<AnchorProofResp>(`/v1/agents/${agentId}/decisions/${encodeURIComponent(decisionId)}/anchor`);
  if (!r.ok) return <Failed what="The on-chain anchor" error={r} />;
  const a = r.data;
  const passed = (a.checks ?? []).filter((c) => c.ok).length;
  const total = (a.checks ?? []).length;

  const badge =
    a.status === 'anchored'
      ? { cls: 'up', text: `anchored · ${passed} of ${total} checks pass` }
      : a.status === 'mismatch'
        ? { cls: 'dn', text: `mismatch · ${passed} of ${total} checks pass` }
        : a.status === 'anchoring'
          ? { cls: 'am', text: 'in a transaction that is not mined yet' }
          : a.status === 'pending'
            ? { cls: 'am', text: 'sealed · waiting for the next anchor' }
            : { cls: 'm3', text: 'no commitment to anchor' };

  return (
    <div className="node" style={{ padding: '10px 12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <span className="lbl">ANCHORED ON CHAIN{a.anchor ? ` · ${a.anchor.scheme}` : ''}</span>
        <span className={`mono ${badge.cls}`} style={{ fontSize: 11 }}>
          {badge.text}
        </span>
      </div>

      {!a.anchor ? (
        <div className="m2" style={{ fontSize: 12, lineHeight: 1.5 }}>
          {a.note}
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: '4px 12px', fontSize: 12 }}>
            <span className="m3">root</span>
            <span className="mono" style={{ wordBreak: 'break-all' }}>{a.anchor.root}</span>
            <span className="m3">transaction</span>
            <span className="mono" style={{ wordBreak: 'break-all' }}>
              {a.anchor.explorer_url ? (
                <a href={a.anchor.explorer_url} target="_blank" rel="noreferrer">
                  {a.anchor.tx_hash}
                </a>
              ) : (
                a.anchor.tx_hash
              )}
            </span>
            <span className="m3">chain · block</span>
            <span className="mono">
              {a.anchor.chain_id} · {a.anchor.block_number ?? 'not mined yet'}
              {a.anchor.mined_at ? ` · ${utc(a.anchor.mined_at)}` : ''}
            </span>
            <span className="m3">position</span>
            <span className="mono">
              leaf {a.leaf_index} of {a.leaf_count} in <Link href="/anchors">anchor {a.anchor.id}</Link>
            </span>
            <span className="m3">sender</span>
            <span className="mono" style={{ wordBreak: 'break-all' }}>{a.anchor.sender}</span>
          </div>
          <div className="m2" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
            Rewriting this decision now would break a proof anyone can check against the chain, without asking ARCANA.
          </div>
          <details style={{ marginTop: 8 }}>
            <summary className="m3" style={{ fontSize: 11.5, cursor: 'pointer' }}>
              Every check, the proof, and how to check it yourself
            </summary>
            <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: 11.5, lineHeight: 1.6 }}>
              {(a.checks ?? []).map((c) => (
                <li key={c.name} className={c.ok ? 'm2' : 'dn'}>
                  {c.ok ? '✓' : '✗'} {c.name}
                  {c.detail ? ` — ${c.detail}` : ''}
                </li>
              ))}
            </ul>
            <div className="lbl" style={{ margin: '10px 0 4px' }}>EXPECTED TRANSACTION INPUT</div>
            <div className="mono m2" style={{ fontSize: 11, wordBreak: 'break-all' }}>{a.expected_input}</div>
            <div className="lbl" style={{ margin: '10px 0 4px' }}>PROOF · {a.proof?.length ?? 0} STEP(S)</div>
            <ol style={{ margin: '0 0 0 18px', padding: 0, fontSize: 11, lineHeight: 1.6 }} className="mono m2">
              {(a.proof ?? []).map((p, i) => (
                <li key={i} style={{ wordBreak: 'break-all' }}>
                  sibling on the {p.position}: {p.sibling}
                </li>
              ))}
            </ol>
            <div className="m2" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.5 }}>
              {a.how_to_check}
            </div>
          </details>
          {a.on_chain && !a.on_chain.reachable && a.on_chain.reason ? (
            <div className="am" style={{ fontSize: 11.5, marginTop: 6 }}>
              The chain could not be read just now ({a.on_chain.reason}). That is unknown, not a failed check.
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
