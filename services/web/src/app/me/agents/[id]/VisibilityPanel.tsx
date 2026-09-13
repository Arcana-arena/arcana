'use client';

import Link from 'next/link';
import { useState } from 'react';
import { discloseAgent, revealDecision } from './actions';

export type VisibilityDecision = {
  decision_id?: number | null;
  ts: string;
  action: string;
  symbol: string | null;
  reason_code?: string | null;
  decider?: string | null;
  commitment?: string | null;
  intelligence?: 'public' | 'withheld' | 'opened';
};

type Fail = { ok: false; status: number | null; reason: string; code: string | null };

/**
 * Reasons a decision was recorded WITHOUT asking the model. Opening one reveals
 * no prompt and no response, because there were none — so the table says so
 * before somebody spends a permanent disclosure on it. The reason code is public
 * for every agent; this reveals nothing new.
 */
const NO_PROMPT: Record<string, string> = {
  no_material_move: 'nothing moved, no model was asked',
  inference_budget_exhausted: 'budget spent, no model was asked',
  cost_budget_exceeded: 'cost budget, no model was asked',
  llm_unavailable: 'model unavailable',
};

/**
 * PRIVATE AGENT. PUBLIC PROOF. — the owner's controls.
 *
 * EVERY CONSEQUENCE IS STATED BEFORE THE BUTTON, not in a dialog after it. Both
 * actions here are permanent and both are written to the agent's public record,
 * so the reader is told exactly what becomes readable, by whom, and that it
 * cannot be taken back, while they can still decide not to.
 *
 * A PUBLIC AGENT GETS NO TOGGLE, AND IS TOLD WHY. Public never becomes private:
 * what it published has already been read and used to judge it. A private agent
 * starts private, at creation.
 */
export function VisibilityPanel({
  agentId,
  agentName,
  visibility,
  disclosedAt,
  decisions,
  opened,
}: {
  agentId: string;
  agentName: string;
  visibility: 'public' | 'private';
  disclosedAt: string | null;
  decisions: VisibilityDecision[];
  /** Decision ids already opened, from the public disclosure record. */
  opened: number[];
}) {
  if (visibility === 'public') {
    return (
      <section className="box">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="k">Visibility · public</span>
          {disclosedAt ? (
            <span className="mono m3" style={{ fontSize: 11 }}>
              made public {disclosedAt.replace('T', ' ').slice(0, 19)}Z
            </span>
          ) : null}
        </div>
        <div className="m2" style={{ fontSize: 12.5, marginTop: 8, lineHeight: 1.55 }}>
          Everything about {agentName} is public: its mandate, its risk rules, and the prompt, raw response, model and
          thesis behind every decision.
        </div>
        <div className="m3" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.55 }}>
          <strong style={{ color: 'var(--color-text)' }}>A public agent cannot become private.</strong> What it published
          has already been read and used to judge it; withdrawing it would not make it secret, only make the record look
          as though it never said it. If you want to keep a strategy private, create a{' '}
          <Link href="/me/agents/new">new private agent</Link> — it starts its own record from its first decision.
        </div>
      </section>
    );
  }

  return (
    <section className="box">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="k">Visibility · private</span>
        <span className="tag tag-outline">PRIVATE AGENT · PUBLIC PROOF</span>
      </div>
      <div className="m2" style={{ fontSize: 12.5, marginTop: 8, lineHeight: 1.55 }}>
        <strong style={{ color: 'var(--color-text)' }}>Private:</strong> the mandate, its template and parameters, the
        risk rules and protective levels, and the prompt, raw response, model and thesis behind each decision.{' '}
        <strong style={{ color: 'var(--color-text)' }}>Public:</strong> every decision (action, symbol, quantity, time),
        every execution and transaction hash, performance, score, rank, competition history and behavioural DNA — and a
        commitment on every decision that proves its hidden reasoning was fixed when it was made.
      </div>

      <MakePublic agentId={agentId} agentName={agentName} />
      <OpenDecisions agentId={agentId} decisions={decisions} opened={opened} />
    </section>
  );
}

function MakePublic({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: true; note: string } | Fail | null>(null);

  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--color-divider)' }}>
      <div className="lbl" style={{ marginBottom: 6 }}>MAKE THIS AGENT PUBLIC</div>
      <div className="m2" style={{ fontSize: 12, lineHeight: 1.55 }}>What happens, all of it, before you decide:</div>
      <ul className="m2" style={{ fontSize: 12, lineHeight: 1.6, margin: '6px 0 0 18px', padding: 0 }}>
        <li>The mandate, its template and parameters, and the risk rules of {agentName} become readable by anyone.</li>
        <li>
          The prompt, raw response, model and thesis behind <em>every</em> decision become readable — including every
          decision made while it was private.
        </li>
        <li>The change is written to the agent&rsquo;s public record, with your wallet and the time.</li>
        <li>
          <strong style={{ color: 'var(--color-text)' }}>It cannot be undone.</strong> A public agent can never be made
          private again.
        </li>
      </ul>
      {result?.ok ? (
        <div className="up" style={{ fontSize: 12.5, marginTop: 10 }}>{result.note}</div>
      ) : (
        <>
          <label className="m2" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 12 }}>
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />I understand
            this is permanent and cannot be undone.
          </label>
          <button
            className="btn"
            style={{ marginTop: 10, borderColor: 'var(--amber)', color: 'var(--amber)' }}
            disabled={!understood || busy}
            onClick={async () => {
              setBusy(true);
              const r = await discloseAgent(agentId);
              setResult(r.ok ? { ok: true, note: r.data.note } : r);
              setBusy(false);
            }}
          >
            {busy ? 'Making public…' : 'Make this agent public, permanently'}
          </button>
          {result && !result.ok ? (
            <div className="dn" style={{ fontSize: 12, marginTop: 8 }}>
              {result.reason}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function OpenDecisions({
  agentId,
  decisions,
  opened,
}: {
  agentId: string;
  decisions: VisibilityDecision[];
  opened: number[];
}) {
  const [done, setDone] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openedSet = new Set(opened);

  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--color-divider)' }}>
      <div className="lbl" style={{ marginBottom: 6 }}>OPEN ONE DECISION</div>
      <div className="m2" style={{ fontSize: 12, lineHeight: 1.55 }}>
        To show one decision&rsquo;s reasoning — to a buyer, or to answer a question about it — without making the
        whole agent public. Before you do:
      </div>
      <ul className="m2" style={{ fontSize: 12, lineHeight: 1.6, margin: '6px 0 0 18px', padding: 0 }}>
        <li>
          Its prompt, raw response, model and thesis become readable by anyone, and anyone can check them against the
          commitment recorded when the decision was made.
        </li>
        <li>
          <strong style={{ color: 'var(--color-text)' }}>The prompt contains your mandate and risk limits as they were
          then.</strong>{' '}
          Opening a decision reveals them.
        </li>
        <li>It is permanent and is written to the agent&rsquo;s public record of disclosures.</li>
        <li>A decision marked &ldquo;no model was asked&rdquo; has no prompt behind it; opening it shows nothing new.</li>
      </ul>

      {decisions.length === 0 ? (
        <div className="m3" style={{ fontSize: 12, marginTop: 10 }}>
          This agent has recorded no decision yet. An agent decides only once it holds a seat in a running competition.
        </div>
      ) : (
        <div className="scroll-x" style={{ marginTop: 10 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>Action</th>
                <th>Symbol</th>
                <th>Why</th>
                <th>Commitment</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {decisions.map((d) => {
                const did = d.decision_id ?? null;
                const isOpen = did !== null && (openedSet.has(did) || d.intelligence === 'opened' || done[did]);
                const noPrompt = d.reason_code ? NO_PROMPT[d.reason_code] : undefined;
                return (
                  <tr key={`${d.ts}-${did}`}>
                    <td className="mono m2" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
                      {d.ts.replace('T', ' ').slice(0, 19)}
                    </td>
                    <td className="mono">{d.action}</td>
                    <td className="mono">{d.symbol || <span className="m3">—</span>}</td>
                    <td className={noPrompt ? 'm3' : 'm2'} style={{ fontSize: 11.5 }}>
                      {noPrompt ?? d.reason_code ?? (d.decider === 'protective' ? 'a protective level' : 'the agent decided')}
                    </td>
                    <td className="mono m3" style={{ fontSize: 11 }} title={d.commitment ?? undefined}>
                      {d.commitment ? `${d.commitment.slice(0, 12)}…` : 'none'}
                    </td>
                    <td>
                      {did === null ? null : isOpen ? (
                        <Link href={`/agents/${agentId}?tab=decisions&open=${did}`} style={{ fontSize: 11.5 }}>
                          opened · view
                        </Link>
                      ) : (
                        <button
                          className="btn"
                          style={{ fontSize: 11.5, padding: '3px 10px' }}
                          disabled={busy !== null}
                          onClick={async () => {
                            setBusy(did);
                            setError(null);
                            const r = await revealDecision(agentId, did);
                            if (r.ok) setDone((m) => ({ ...m, [did]: r.data.disclosed_at }));
                            else setError(r.reason);
                            setBusy(null);
                          }}
                        >
                          {busy === did ? 'Opening…' : 'Open, permanently'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {error ? (
        <div className="dn" style={{ fontSize: 12, marginTop: 8 }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
