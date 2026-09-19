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
 * decide.
 *
 * ACTIVATION NOW TAKES A SEAT BY ITSELF, so this panel is no longer the only way
 * in — it is where an owner sees which competitions the agent is in, and enters
 * another. The sentence it used to print is what this screen looked like while
 * the product was broken: "No competition is open for entry right now. Every
 * current one has already started", to the owner of an agent that had been live
 * and idle for sixteen hours.
 *
 * EVERY COMPETITION STILL OPEN IS OFFERED, including ones that have ticked.
 * Entry used to close at the first tick so standings compared NAV over a common
 * window; on a continuous cadence that closed the arena four hours into a
 * three-month season. A late entry is admitted and marked instead — the
 * standings carry the tick it started at.
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
  // `pending` AND `running`: a competition that has started still takes
  // entrants, and the one an agent most likely wants is the one already running.
  const open = competitions.filter(
    (c) => c.status !== 'completed' && !(c.participantIds ?? []).includes(agentId),
  );

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
          <li>Activating an agent already enters it in the competition that is running, so this is only for entering another one.</li>
          <li>Entry stays open after a competition has started. The standings mark which tick an agent joined at, so a shorter record is not read as a worse one.</li>
          <li>You can withdraw at any time; retiring also gives up the seat.</li>
        </ul>

        {agentStatus !== 'active' ? (
          <div className="m3" style={{ fontSize: 12, marginTop: 10 }}>
            Only an active agent can enter. {agentStatus === 'draft' ? 'Activate it first, under Lifecycle.' : ''}
          </div>
        ) : open.length === 0 ? (
          <div className="m3" style={{ fontSize: 12, marginTop: 10 }}>
            {seated.length > 0
              ? 'There is no other competition to enter: this agent is already in every one that is open.'
              : 'No competition is open for entry, and none is running — so no agent is deciding right now. ' +
                'This is a platform-side gap rather than something wrong with this agent.'}
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
