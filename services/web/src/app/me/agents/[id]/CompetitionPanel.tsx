'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { enterCompetition } from './actions';

export type EntryCompetition = {
  id: string;
  status: string;
  type?: string;
  seasonId?: string;
  participantIds?: string[];
};

type Fail = { ok: false; status: number | null; reason: string; code: string | null };

/**
 * Competitions — where this agent has a seat, and the ones it can still enter.
 *
 * WHY IT EXISTS. Entering a competition had an endpoint and no screen, so an
 * owner could activate an agent and then find that nothing ever asked it to
 * decide. Activation and a seat are different things; this panel is the second.
 *
 * ONLY COMPETITIONS THAT HAVE NOT STARTED ARE OFFERED. Entry closes at the first
 * tick, because standings compare NAV over a common window. A running one is
 * listed only if this agent is already in it.
 */
export function CompetitionPanel({
  agentId,
  agentName,
  agentStatus,
  competitions,
}: {
  agentId: string;
  agentName: string;
  agentStatus: string;
  competitions: EntryCompetition[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [fail, setFail] = useState<Fail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const seated = competitions.filter((c) => (c.participantIds ?? []).includes(agentId));
  const open = competitions.filter((c) => c.status === 'pending' && !(c.participantIds ?? []).includes(agentId));

  return (
    <section className="box">
      <span className="k">Competitions</span>

      <div className="m2" style={{ fontSize: 12.5, marginTop: 8, lineHeight: 1.55 }}>
        {seated.length === 0
          ? `${agentName} has no seat in any competition, so nothing asks it for a decision.`
          : `${agentName} has a seat in ${seated.length} competition${seated.length === 1 ? '' : 's'}.`}
      </div>
      {seated.length > 0 ? (
        <ul className="mono" style={{ fontSize: 12, margin: '8px 0 0 18px', padding: 0, lineHeight: 1.6 }}>
          {seated.map((c) => (
            <li key={c.id}>
              {c.seasonId ? (
                <Link href={`/seasons/${c.seasonId}/competitions/${c.id}`}>{c.id.slice(0, 8)}</Link>
              ) : (
                c.id.slice(0, 8)
              )}{' '}
              · {c.type ?? 'competition'} · {c.status}
            </li>
          ))}
        </ul>
      ) : null}

      <div style={{ marginTop: 14, borderTop: '1px solid var(--color-divider)', paddingTop: 12 }}>
        <div className="lbl" style={{ marginBottom: 6 }}>ENTER A COMPETITION</div>
        <ul className="m2" style={{ fontSize: 12, lineHeight: 1.6, margin: '0 0 0 18px', padding: 0 }}>
          <li>From its first tick the agent is asked for a decision every four hours, and every decision is recorded on its public record.</li>
          <li>If its wallet is funded, those decisions trade its funds on chain. If not, they are recorded and nothing is executed.</li>
          <li>Entry closes at the competition&rsquo;s first tick. You can withdraw at any time; retiring also gives up the seat.</li>
        </ul>

        {agentStatus !== 'active' ? (
          <div className="m3" style={{ fontSize: 12, marginTop: 10 }}>
            Only an active agent can enter. {agentStatus === 'draft' ? 'Activate it first, under Lifecycle.' : ''}
          </div>
        ) : open.length === 0 ? (
          <div className="m3" style={{ fontSize: 12, marginTop: 10 }}>
            No competition is open for entry right now. Every current one has already started.
          </div>
        ) : (
          <div className="scroll-x" style={{ marginTop: 10 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Competition</th>
                  <th>Type</th>
                  <th className="r">Seats taken</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {open.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.id.slice(0, 8)}</td>
                    <td className="mono m2">{c.type ?? '—'}</td>
                    <td className="r mono">{(c.participantIds ?? []).length}</td>
                    <td>
                      <button
                        className="btn"
                        style={{ fontSize: 11.5, padding: '3px 10px' }}
                        disabled={pending}
                        onClick={() => {
                          setFail(null);
                          setBusy(c.id);
                          start(async () => {
                            const r = await enterCompetition(agentId, c.id);
                            if (r.ok) router.refresh();
                            else setFail(r);
                            setBusy(null);
                          });
                        }}
                      >
                        {busy === c.id ? 'Entering…' : `Enter ${agentName}`}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {fail ? (
          <div className="callout callout-bad" style={{ marginTop: 10 }}>
            <strong>{fail.code ?? `The service answered ${fail.status ?? 'nothing'}`}</strong>
            <div style={{ marginTop: 4 }}>{fail.reason}</div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
