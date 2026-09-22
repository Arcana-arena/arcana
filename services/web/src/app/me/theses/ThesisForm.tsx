'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createThesis, type ThesisBenchmarkInput } from '@/lib/social-actions';

/**
 * Publishing a thesis.
 *
 * THE LAST MOMENT ANYTHING HERE CAN CHANGE. The service has no edit and no
 * delete for a thesis, by design, so the form asks for an explicit
 * acknowledgement before the button works. A creator who finds out afterwards
 * that the claim was permanent has been surprised by the one rule the feature
 * exists for.
 *
 * THE DEADLINE IS A DATE, RESOLVED AT 00:00 UTC. A datetime picker renders in
 * the browser's zone and would publish an instant the creator never saw
 * written down; a date plus a stated zone is what the thesis page shows back.
 * The bounds mirror the database's 24 hours to 365 days, with a day of margin
 * at the near end so a form left open overnight is not refused.
 *
 * THE AGENT LIST IS WHAT THE SERVICE WILL ACCEPT, AS FAR AS THE PAGE KNOWS:
 * the creator's own active agents. Visibility is not in the dashboard read, so
 * a private agent is still offered and its refusal is explained below rather
 * than guessed at.
 */

export type ThesisAgentChoice = { id: string; name: string };

const DAY_MS = 86_400_000;

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function ThesisForm({ agents }: { agents: ThesisAgentChoice[] }) {
  const router = useRouter();
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [claim, setClaim] = useState('');
  const [kind, setKind] = useState<ThesisBenchmarkInput['kind']>('symbol');
  const [symbols, setSymbols] = useState('SPY');
  const [margin, setMargin] = useState('0');
  const [date, setDate] = useState(() => isoDate(Date.now() + 30 * DAY_MS));
  const [understood, setUnderstood] = useState(false);
  const [pending, start] = useTransition();
  const [fail, setFail] = useState<{ reason: string; code: string | null } | null>(null);

  const minDate = isoDate(Date.now() + 2 * DAY_MS);
  const maxDate = isoDate(Date.now() + 364 * DAY_MS);

  const tickers = symbols
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const marginN = Number(margin);

  const okClaim = claim.trim().length >= 16 && claim.trim().length <= 2000;
  const okBench =
    kind === 'arcana_index' ||
    (kind === 'symbol' && tickers.length === 1) ||
    (kind === 'basket' && tickers.length >= 2 && tickers.length <= 20);
  const okMargin = Number.isInteger(marginN) && marginN >= 0 && marginN <= 100;
  const okDate = date >= minDate && date <= maxDate;
  const ready = Boolean(agentId) && okClaim && okBench && okMargin && okDate && understood;

  const benchmark = (): ThesisBenchmarkInput =>
    kind === 'arcana_index'
      ? { kind }
      : kind === 'symbol'
        ? { kind, symbols: [tickers[0]] }
        : { kind, symbols: tickers };

  const submit = () => {
    setFail(null);
    start(async () => {
      const r = await createThesis({
        linked_agent_id: agentId,
        claim_text: claim.trim(),
        benchmark_ref: benchmark(),
        criteria: { comparison: 'gt', margin_pct: marginN },
        resolves_at: `${date}T00:00:00.000Z`,
      });
      if (r.ok) router.push(`/theses/${r.data.id}`);
      else setFail({ reason: r.reason, code: r.code });
    });
  };

  if (agents.length === 0) {
    return (
      <div className="m2" style={{ fontSize: 13, lineHeight: 1.6, maxWidth: 640 }}>
        A thesis is measured against one of your agents, and you have no active agent to bind it
        to. <Link href="/me/agents/new">Create one</Link>, or reactivate one from your{' '}
        <Link href="/me">dashboard</Link>.
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 780 }}>
      <div className="field">
        <label htmlFor="t-agent">Agent</label>
        <select id="t-agent" className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <div className="m3" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
          The claim is judged on this agent&rsquo;s return. It must be active and public; the agent
          itself is not told it was named.
        </div>
      </div>

      <div className="field" style={{ marginTop: 14 }}>
        <label htmlFor="t-claim">Claim</label>
        <textarea
          id="t-claim"
          className="input"
          value={claim}
          maxLength={2000}
          onChange={(e) => setClaim(e.target.value)}
          rows={5}
          placeholder="What you expect to happen, and why. Write it so someone reading it after the deadline can say plainly whether you were right."
          style={{ width: '100%', resize: 'vertical', lineHeight: 1.6, fontSize: 13.5 }}
        />
        <div className="m3" style={{ fontSize: 11, marginTop: 4 }}>
          {claim.trim().length.toLocaleString('en-US')} / 2,000 · at least 16 characters
        </div>
      </div>

      <div className="field" style={{ marginTop: 16 }}>
        <label htmlFor="t-kind">Benchmark</label>
        <select
          id="t-kind"
          className="input"
          value={kind}
          onChange={(e) => setKind(e.target.value as ThesisBenchmarkInput['kind'])}
        >
          <option value="symbol">One symbol</option>
          <option value="basket">A basket of symbols, equal-weighted</option>
          <option value="arcana_index">The ARCANA market index</option>
        </select>
        {kind !== 'arcana_index' ? (
          <>
            <input
              id="t-symbols"
              className="input"
              style={{ marginTop: 8 }}
              value={symbols}
              onChange={(e) => setSymbols(e.target.value)}
              placeholder={kind === 'symbol' ? 'SPY' : 'SPY, QQQ, AAPL'}
              aria-label="Benchmark symbols"
            />
            <div className="m3" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
              {kind === 'symbol'
                ? 'Exactly one ticker.'
                : 'Two to twenty tickers, separated by commas or spaces.'}{' '}
              Only symbols the market actually prices are accepted; the refusal lists them.
            </div>
          </>
        ) : (
          <div className="m3" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
            Every symbol, equal-weighted, per tick. It takes no symbol list.
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 16 }}>
        <div className="field" style={{ flex: '1 1 200px' }}>
          <label htmlFor="t-margin">Beat it by (percentage points)</label>
          <input
            id="t-margin"
            className="input"
            type="number"
            min={0}
            max={100}
            step={1}
            value={margin}
            onChange={(e) => setMargin(e.target.value)}
          />
          <div className="m3" style={{ fontSize: 11, marginTop: 4 }}>
            0 means any margin. A whole number from 0 to 100.
          </div>
        </div>
        <div className="field" style={{ flex: '1 1 200px' }}>
          <label htmlFor="t-date">Judged on (00:00 UTC)</label>
          <input
            id="t-date"
            className="input"
            type="date"
            min={minDate}
            max={maxDate}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <div className="m3" style={{ fontSize: 11, marginTop: 4 }}>
            Between {minDate} and {maxDate}.
          </div>
        </div>
      </div>

      <label
        className="m2"
        style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, marginTop: 18, lineHeight: 1.5 }}
      >
        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
        <span>
          I understand that once published, this claim, its benchmark, its margin and its deadline
          cannot be edited or deleted, and the verdict is attached automatically.
        </span>
      </label>

      <div style={{ display: 'flex', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary" disabled={!ready || pending} onClick={submit}>
          {pending ? 'Publishing…' : 'Publish thesis'}
        </button>
        <Link href="/me/theses" className="btn btn-ghost">
          Cancel
        </Link>
      </div>

      {fail ? (
        <div className="m2" style={{ fontSize: 12.5, marginTop: 12, lineHeight: 1.55 }}>
          {fail.code === 'thesis_agent_not_public' ? (
            <>
              That agent is private, and a public thesis would publish the performance its visibility
              withholds. Pick a public agent, or make this one public first.
            </>
          ) : fail.code === 'thesis_agent_not_active' ? (
            <>That agent is not active, so there is nothing deciding to measure. {fail.reason}</>
          ) : fail.code === 'forbidden_not_owner' ? (
            <>That agent belongs to another creator. A thesis can only name your own.</>
          ) : fail.code === 'rate_limited' ? (
            <>Ten theses an hour is the limit. Your claim is still on this page — try again later.</>
          ) : (
            <>Not published: {fail.reason}</>
          )}
        </div>
      ) : null}
    </div>
  );
}
