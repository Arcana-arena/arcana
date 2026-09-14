'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ensureWallet,
  evolveAgent,
  exportKey,
  pauseAgent,
  resumeAgent,
  retireAgent,
  setRisk,
} from './actions';
import { activateAgent } from '../new/actions';
import type { PauseResult, RiskResult, Triggers } from '../../shapes';

/**
 * The controls that change something, and the words that go with them.
 *
 * EVERY DESTRUCTIVE ACTION STATES WHAT IT ACTUALLY DOES BEFORE IT IS PRESSED,
 * and where this platform's behaviour differs from what the design promised,
 * the platform's behaviour is what is printed. Three of those differences are
 * on this screen:
 *
 *   PAUSE keeps protective exits running, and this screen used to say the
 *   opposite because the engine did the opposite: the guard watcher read only
 *   guards whose agent was ACTIVE, so a pause left open positions with no stop
 *   while the rows still said "armed". The engine was changed rather than the
 *   warning — a pause stops the AGENT deciding and leaves the OWNER's standing
 *   instruction about their own position running. Retire is the way to stand
 *   everything down.
 *
 *   RETIRE does not close positions and does not return funds. It sets the
 *   status, gives up the agent's seat in every running competition, and takes
 *   its protective levels DOWN — with the reason written on each row, rather
 *   than leaving them saying "armed" with nothing watching. The design says it
 *   sells out at market. It does not.
 *
 *   EVOLVE does not lose the seat — activating the child hands the parent's
 *   seat over. What it loses is the RECORD: the child starts at zero decisions
 *   and is unranked until it has enough, and the parent's score freezes.
 *
 * THE MANDATE IS NOT EDITABLE AND THE FORM SAYS SO RATHER THAN FINDING OUT.
 * The service refuses a mandate edit on anything past draft with a sentence
 * explaining evolve; letting somebody type a new mandate and then showing them
 * that refusal is a worse way to learn the same thing.
 */

type Fail = { ok: false; status: number | null; reason: string; code: string | null };

function Problem({ f }: { f: Fail }) {
  return (
    <div className="callout callout-bad" style={{ marginTop: 12 }}>
      <strong>{f.code ?? `The service answered ${f.status ?? 'nothing'}`}</strong>
      <div style={{ marginTop: 4 }}>{f.reason}</div>
    </div>
  );
}

// ---------------------------------------------------------------- risk

const FRACTION_KEYS = new Set([
  'stop_loss_fraction', 'stopLossFraction', 'take_profit_fraction', 'takeProfitFraction',
  'stop_loss_pct', 'stopLossPct', 'take_profit_pct', 'takeProfitPct',
  'max_position_pct', 'maxPositionPct', 'cash_floor_pct', 'cashFloorPct',
  'trade_size_pct', 'tradeSizePct', 'rebalance_band_pct', 'rebalanceBandPct',
]);

const asPct = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return `${(n * 100).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}%`;
};

/**
 * The keys the engine reads that an owner most often sets, as fields.
 * Canonical spellings only; a retired spelling (stop_loss_pct) still shows in
 * the JSON below and the save response names it as ambiguous.
 */
const RISK_FIELDS: Array<{ key: string; label: string; help: string; percent?: boolean }> = [
  { key: 'stop_loss_fraction', label: 'Stop loss', help: 'Armed on every fill; fires as a protective exit. 0.015 = 1.5% below entry.' },
  { key: 'take_profit_fraction', label: 'Take profit', help: 'Empty lets the mandate decide exits. 0.04 = 4% above entry.' },
  { key: 'max_position_pct', label: 'Max position', help: 'The largest one symbol may be. A fraction: 0.4 = 40%.' },
  { key: 'cash_floor_pct', label: 'Cash floor', help: 'A buy that would take cash below this is refused. 0.2 = 20%.' },
  { key: 'trade_size_pct', label: 'Trade size', help: 'How much of the book one trade may commit. 0.5 = 50%.' },
  {
    key: 'cost_budget_monthly_pct',
    label: 'Cost budget',
    help: 'A PERCENTAGE, unlike the rest: 2 means 2% of capital a month on gas and pool fees. Empty = unmetered.',
    percent: true,
  },
];

export function RiskEditor({
  agentId,
  initial,
  editable,
}: {
  agentId: string;
  initial: Record<string, unknown> | null;
  editable: boolean;
}) {
  const [text, setText] = useState(JSON.stringify(initial ?? {}, null, 2));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [result, setResult] = useState<RiskResult | null>(null);
  const [fail, setFail] = useState<Fail | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // ONE SOURCE OF TRUTH: the JSON text. The fields below read from it and write
  // back into it, so the fields and the raw profile can never disagree about
  // what Save will send. A field being typed ("0.0") keeps its own draft until
  // it is a number, so typing is not fought by the round trip.
  let parsed: Record<string, unknown> | null = null;
  try {
    const p = JSON.parse(text);
    parsed = p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }

  const setField = (key: string, v: string) => {
    setDrafts((d) => ({ ...d, [key]: v }));
    if (!parsed) return;
    const next = { ...parsed };
    if (v.trim() === '') delete next[key];
    else if (Number.isFinite(Number(v))) next[key] = Number(v);
    else return;
    setText(JSON.stringify(next, null, 2));
  };

  // LIVE CONVERSION WHILE TYPING. This is the platform where 0.15 was armed as
  // 15%; a field that shows only the fraction is where it happens again. The
  // preview is drawn from the text in the box, so it reacts before anything is
  // saved rather than confirming afterwards.
  const preview: Array<[string, string]> = parsed
    ? Object.entries(parsed)
        .filter(([k, v]) => FRACTION_KEYS.has(k) && Number.isFinite(Number(v)))
        .map(([k, v]) => [k, `${v} = ${asPct(v)}`])
    : [];
  const fieldKeys = new Set(RISK_FIELDS.map((f) => f.key));
  const otherKeys = parsed ? Object.keys(parsed).filter((k) => !fieldKeys.has(k)) : [];

  const save = () => {
    setFail(null);
    setResult(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
      setParseError(null);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
      return;
    }
    start(async () => {
      const r = await setRisk(agentId, parsed);
      if (r.ok) setResult(r.data);
      else setFail(r);
    });
  };

  return (
    <section className="box">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="k">Risk limits</span>
        <span className={editable ? 'up' : 'm3'} style={{ fontSize: 11 }}>
          {editable ? 'editable live' : 'this agent is retired — its limits are part of a finished record'}
        </span>
      </div>

      {/* ALWAYS SHOWN, not only once a number is typed. */}
      <div className="callout callout-warn" style={{ marginTop: 10 }}>
        <strong>These are FRACTIONS.</strong> <span className="mono">0.0015</span> means 0.15%, not 0.15. An owner
        who wrote 0.15 meaning &ldquo;get me out if it drops 0.15%&rdquo; armed a stop a hundred times further away,
        and the record was correct so nothing caught it.
      </div>

      {parsed ? (
        <div className="two-col" style={{ marginTop: 12 }}>
          {RISK_FIELDS.map((f) => {
            const raw = drafts[f.key] ?? (parsed![f.key] === undefined ? '' : String(parsed![f.key]));
            const meaning =
              raw === ''
                ? 'not set'
                : !Number.isFinite(Number(raw))
                  ? 'not a number'
                  : f.percent
                    ? `${raw}% of capital a month`
                    : `= ${asPct(raw)}`;
            return (
              <div className="field" key={f.key}>
                <label htmlFor={`risk-${f.key}`}>
                  {f.label} <span className="mono m3" style={{ fontSize: 10 }}>{f.key}</span>
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    id={`risk-${f.key}`}
                    className="input mono"
                    value={raw}
                    onChange={(e) => setField(f.key, e.target.value)}
                    disabled={!editable}
                    inputMode="decimal"
                    style={{ flex: 1 }}
                  />
                  <span className="mono m3" style={{ fontSize: 11, minWidth: 110, textAlign: 'right' }}>
                    {meaning}
                  </span>
                </div>
                <div className="help">{f.help}</div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="callout callout-bad" style={{ marginTop: 10 }}>
          <strong>The profile below is not valid JSON, so the fields cannot read it.</strong> Fix it below; nothing is
          sent while it is invalid.
        </div>
      )}

      {/* THE RAW PROFILE, for every key the fields do not cover. It is the same
          object the fields edit — and it is what Save sends. */}
      <details className="fold" style={{ marginTop: 12 }} open={!parsed || otherKeys.length > 0}>
        <summary>
          <span>Every key, as JSON</span>
          <span className="fold-state">
            {otherKeys.length > 0 ? `${otherKeys.length} other key${otherKeys.length === 1 ? '' : 's'}: ${otherKeys.join(', ')}` : 'no other keys'}
          </span>
        </summary>
        <div className="fold-body">
          <textarea
            className="input mono"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setDrafts({});
            }}
            rows={9}
            spellCheck={false}
            disabled={!editable}
            style={{ width: '100%', fontSize: 12, lineHeight: 1.5 }}
            aria-label="Risk profile"
          />
          {preview.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <div className="lbl">WHAT THESE NUMBERS MEAN</div>
              <div className="mono" style={{ fontSize: 11.5, marginTop: 4, display: 'grid', gap: 2 }}>
                {preview.map(([k, v]) => (
                  <div key={k}>
                    <span className="m3">{k}</span> {v}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </details>

      {parseError ? (
        <div className="callout callout-bad" style={{ marginTop: 10 }}>
          <strong>That is not valid JSON, so nothing was sent.</strong>
          <div className="mono" style={{ marginTop: 4, fontSize: 11 }}>{parseError}</div>
        </div>
      ) : null}

      {editable ? (
        <>
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={save} disabled={pending}>
            {pending ? 'Saving…' : 'Save risk limits'}
          </button>
          <div className="m3" style={{ fontSize: 10.5, marginTop: 8, lineHeight: 1.45 }}>
            This REPLACES the profile. A key you remove stops applying — that is deliberate, because a merge cannot
            express taking a limit off, and the response names what disappeared.
          </div>
        </>
      ) : null}

      {fail ? <Problem f={fail} /> : null}
      {result ? <RiskResultView r={result} /> : null}
    </section>
  );
}

function RiskResultView({ r }: { r: RiskResult }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div className="callout callout-note">
        <strong>Saved. Applies from {r.applies_from}.</strong>
        <div style={{ marginTop: 4 }}>{r.applies_note}</div>
        {r.changed.length > 0 ? (
          <div className="mono" style={{ marginTop: 6, fontSize: 11 }}>
            changed: {r.changed.join(', ')}
          </div>
        ) : null}
      </div>
      {r.removed.length > 0 ? (
        <div className="callout callout-warn" style={{ marginTop: 8 }}>
          <strong>{r.removed.length} limit(s) were removed.</strong>
          <div style={{ marginTop: 4 }}>{r.removed_note}</div>
        </div>
      ) : null}
      {/* THE TWO WARNINGS THAT MUST REACH THE OWNER. A key nothing reads is
          silence where silence is indistinguishable from working; a key whose
          name lies about its scale is the hundredfold mistake by another route. */}
      {r.risk_profile_unrecognised?.length ? (
        <div className="callout callout-warn" style={{ marginTop: 8 }}>
          <strong>Some keys will never be read.</strong>
          <div style={{ marginTop: 4 }}>{r.risk_profile_note}</div>
        </div>
      ) : null}
      {r.risk_profile_ambiguous?.length ? (
        <div className="callout callout-warn" style={{ marginTop: 8 }}>
          <strong>A key is named in a way that has already cost somebody a hundredfold.</strong>
          <div style={{ marginTop: 4 }}>{r.risk_profile_ambiguous_note}</div>
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------- lifecycle

export function LifecyclePanel({
  agentId,
  agentName,
  status,
  armedSymbols,
  visibility,
}: {
  agentId: string;
  agentName: string;
  status: string;
  armedSymbols: string[];
  visibility: 'public' | 'private';
}) {
  const [childPrivate, setChildPrivate] = useState(false);
  const router = useRouter();
  const [pending, start] = useTransition();
  const [fail, setFail] = useState<Fail | null>(null);
  const [paused, setPaused] = useState<PauseResult | null>(null);
  const [confirm, setConfirm] = useState<'pause' | 'retire' | 'evolve' | null>(null);
  const [typed, setTyped] = useState('');
  const [because, setBecause] = useState('');
  const [newMandate, setNewMandate] = useState('');

  const run = (fn: () => Promise<{ ok: true; data: unknown } | Fail>, after?: (d: unknown) => void) => {
    setFail(null);
    start(async () => {
      const r = await fn();
      if (r.ok) {
        setConfirm(null);
        setTyped('');
        after?.(r.data);
        router.refresh();
      } else {
        setFail(r);
      }
    });
  };

  return (
    <section className="box">
      <span className="k">Lifecycle</span>

      {status === 'active' ? (
        <>
          {confirm !== 'pause' ? (
            <button className="btn" style={{ marginTop: 10 }} onClick={() => setConfirm('pause')}>
              Pause
            </button>
          ) : (
            <div className="callout callout-note" style={{ marginTop: 10 }}>
              {/* WHAT STOPS AND WHAT DOES NOT, both stated before the click.
                  Saying only "this pauses the agent" would leave somebody to
                  guess about the stops, and the guess that costs money is the
                  one where they assume wrong in either direction. */}
              <strong>Pausing stops {agentName} deciding. Your protective levels keep running.</strong>
              <div style={{ marginTop: 4 }}>
                No new positions are opened or closed by the agent until you resume. Stops and take-profits you
                already have stay armed and stay checked against the price — they are your standing instruction
                about your own position, not part of the agent&rsquo;s turn to speak.
                {armedSymbols.length > 0 ? (
                  <>
                    {' '}
                    <span className="mono">{armedSymbols.join(', ')}</span> will still be watched, and will still
                    act if crossed.
                  </>
                ) : (
                  ' This agent has no armed level right now, so there is none to keep.'
                )}{' '}
                To stand everything down instead, retire it.
              </div>
              <input
                className="input"
                placeholder="why (optional, recorded for you)"
                value={because}
                onChange={(e) => setBecause(e.target.value)}
                style={{ width: '100%', marginTop: 10, fontSize: 12 }}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button
                  className="btn"
                  disabled={pending}
                  onClick={() =>
                    run(
                      () => pauseAgent(agentId, because),
                      (d) => setPaused(d as PauseResult),
                    )
                  }
                >
                  {pending ? 'Pausing…' : 'Pause deciding'}
                </button>
                <button className="btn btn-ghost" onClick={() => setConfirm(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      ) : null}

      {/* A DRAFT IS ACTIVATED HERE TOO. The wizard's last screen used to be the
          only door, so an owner who left it had a draft nothing could start. */}
      {status === 'draft' ? (
        <div className="callout callout-note" style={{ marginTop: 10 }}>
          <strong>{agentName} is a draft. Nothing ticks for it and nothing is scored.</strong>
          <div style={{ marginTop: 4 }}>
            Activating takes one of your active slots. It does not enter a competition — an agent is asked for a
            decision only on the ticks of a competition it has a seat in, which you choose under Competitions. Until
            its wallet holds the settlement token its decisions are still recorded but nothing is executed, and until
            it holds gas it cannot send a transaction or fire a protective stop.
          </div>
          <button
            className="btn btn-primary"
            style={{ marginTop: 10 }}
            disabled={pending}
            onClick={() => run(() => activateAgent(agentId))}
          >
            {pending ? 'Activating…' : `Activate ${agentName}`}
          </button>
        </div>
      ) : null}

      {status === 'paused' ? (
        <button
          className="btn btn-primary"
          style={{ marginTop: 10 }}
          disabled={pending}
          onClick={() => run(() => resumeAgent(agentId), (d) => setPaused(d as PauseResult))}
        >
          {pending ? 'Resuming…' : 'Resume deciding'}
        </button>
      ) : null}

      {paused?.protection_note ? (
        <div className={paused.protection_stops ? 'callout callout-bad' : 'callout callout-note'} style={{ marginTop: 10 }}>
          {paused.protection_note}
        </div>
      ) : null}

      {status !== 'retired' ? (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--color-divider)', paddingTop: 12 }}>
          {confirm !== 'evolve' ? (
            <button className="btn" onClick={() => setConfirm('evolve')}>
              Evolve to a new version
            </button>
          ) : (
            <div className="callout callout-warn">
              <strong>Evolving starts a new record. It does not lose the seat.</strong>
              <div style={{ marginTop: 4 }}>
                This creates a DRAFT next version. Nothing changes until you activate it — and activating it retires{' '}
                {agentName} in the same transaction and hands its seat in any running competition to the new version.
                What starts over is the record: the new version has no decisions, is unranked until it has enough, and{' '}
                {agentName}&rsquo;s score freezes where it stands. A new version is also the only way to change a
                mandate.
              </div>
              <textarea
                className="input mono"
                placeholder="the new version's mandate (leave empty to copy this one)"
                value={newMandate}
                onChange={(e) => setNewMandate(e.target.value)}
                rows={4}
                style={{ width: '100%', marginTop: 10, fontSize: 12 }}
              />
              {/* VISIBILITY OF THE NEW VERSION, stated before the button. A
                  version of a private agent is private; a version of a public
                  one may start private, and what that does NOT hide is said. */}
              {visibility === 'private' ? (
                <div className="m2" style={{ fontSize: 12, marginTop: 10 }}>
                  The new version is private, like {agentName}: its template, parameters and risk rules come from it.
                </div>
              ) : (
                <div style={{ marginTop: 10 }}>
                  <label className="m2" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    <input type="checkbox" checked={childPrivate} onChange={(e) => setChildPrivate(e.target.checked)} />
                    Start the new version private
                  </label>
                  {childPrivate ? (
                    <div className="m2" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
                      Its prompts, responses and theses are withheld from its first decision, each sealed with a
                      commitment. Its decisions, trades, performance and score stay public. It cannot be made private
                      again once public. <strong>What it does not hide:</strong>{' '}
                      {newMandate.trim()
                        ? `the mandate you typed is new, but the risk rules are copied from ${agentName}, which are already public.`
                        : `with the mandate box empty, its template, parameters and risk rules are copied from ${agentName}, which has already published them.`}
                    </div>
                  ) : null}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button
                  className="btn btn-primary"
                  disabled={pending}
                  onClick={() =>
                    run(
                      () => evolveAgent(agentId, newMandate, visibility === 'public' && childPrivate ? 'private' : undefined),
                      (d) => {
                        const id = (d as { id?: string })?.id;
                        if (id) router.push(`/me/agents/${id}`);
                      },
                    )
                  }
                >
                  {pending ? 'Creating…' : 'Create the draft'}
                </button>
                <button className="btn btn-ghost" onClick={() => setConfirm(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {status !== 'retired' ? (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--color-divider)', paddingTop: 12 }}>
          {confirm !== 'retire' ? (
            <button
              className="btn"
              style={{ color: 'var(--red)', borderColor: 'rgba(210,96,91,.4)' }}
              onClick={() => setConfirm('retire')}
            >
              Retire agent
            </button>
          ) : (
            <div className="callout callout-bad">
              <strong>Retiring is permanent, and it does NOT sell anything.</strong>
              <div style={{ marginTop: 4 }}>
                {agentName} stops deciding and gives up its seat in every running competition. Its positions are{' '}
                <em>not</em> closed and its funds are <em>not</em> returned — whatever it holds stays in its wallet.
                Its protective levels are taken down: unlike a pause, which leaves your stops running, retiring
                stands everything down, and the watcher closes each level with the reason written on the row rather
                than leaving it saying ARMED with nothing behind it. Anything still open is then yours to manage —
                the key is exportable afterwards exactly as before. A retired agent cannot be restarted: its record
                has closed, and attaching new decisions to a finished one would misdescribe it.
              </div>
              <div className="field" style={{ marginTop: 10 }}>
                <label htmlFor="confirmname">Type {agentName} to confirm</label>
                <input
                  id="confirmname"
                  className="input mono"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  style={{ width: '100%', fontSize: 12 }}
                />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button
                  className="btn"
                  style={{ color: 'var(--red)', borderColor: 'rgba(210,96,91,.4)', opacity: typed === agentName ? 1 : 0.45 }}
                  disabled={pending || typed !== agentName}
                  onClick={() => run(() => retireAgent(agentId))}
                >
                  {pending ? 'Retiring…' : 'Retire permanently'}
                </button>
                <button className="btn btn-ghost" onClick={() => setConfirm(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {fail ? <Problem f={fail} /> : null}
    </section>
  );
}

// ---------------------------------------------------------------- wallet

/**
 * The key export, behind three steps.
 *
 * The service rate limits this to three an hour because it returns key
 * material; the three steps here are the other half of the same argument. A
 * control that hands out a private key should not be one stray click from a
 * dashboard, and the key is shown once and never written anywhere by this page.
 */
export function ExportKeyPanel({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [step, setStep] = useState(0);
  const [typed, setTyped] = useState('');
  const [key, setKey] = useState<{ address: string; private_key: string } | null>(null);
  const [fail, setFail] = useState<Fail | null>(null);
  const [pending, start] = useTransition();

  if (key) {
    return (
      <div className="callout callout-bad">
        <strong>This is shown once and is not stored by this page.</strong>
        <div className="lbl" style={{ marginTop: 10 }}>ADDRESS</div>
        <div className="mono brk" style={{ fontSize: 11.5 }}>{key.address}</div>
        <div className="lbl" style={{ marginTop: 10 }}>PRIVATE KEY</div>
        <div className="mono brk addr-box" style={{ marginTop: 4 }}>{key.private_key}</div>
        <div style={{ marginTop: 10 }}>
          Anyone holding this key controls everything in that wallet. ARCANA will never ask you for it. Close this
          panel when you have stored it.
        </div>
        <button className="btn" style={{ marginTop: 10 }} onClick={() => { setKey(null); setStep(0); setTyped(''); }}>
          Done
        </button>
      </div>
    );
  }

  if (step === 0) {
    return (
      <button
        className="btn"
        style={{ color: 'var(--red)', borderColor: 'rgba(210,96,91,.4)' }}
        onClick={() => setStep(1)}
      >
        Export private key
      </button>
    );
  }

  return (
    <div className="callout callout-bad">
      <div className="lbl" style={{ marginBottom: 6 }}>EXPORT PRIVATE KEY · STEP {step} OF 3</div>
      {step === 1 ? (
        <>
          <strong>Before you continue</strong>
          <div style={{ marginTop: 4 }}>
            Anyone with this key controls everything in {agentName}&rsquo;s wallet. ARCANA will never ask you for it,
            and nobody here can recover it if it is lost or taken. Exporting does not remove ARCANA&rsquo;s own ability
            to sign — after this, both of you can.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn btn-ghost" onClick={() => setStep(0)}>Cancel</button>
            <button
              className="btn"
              style={{ color: 'var(--red)', borderColor: 'rgba(210,96,91,.4)' }}
              onClick={() => setStep(2)}
            >
              I understand · continue
            </button>
          </div>
        </>
      ) : null}
      {step === 2 ? (
        <>
          <strong>Type the agent&rsquo;s name</strong>
          <div className="field" style={{ marginTop: 8 }}>
            <label htmlFor="exportname">{agentName}</label>
            <input
              id="exportname"
              className="input mono"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              style={{ width: '100%', fontSize: 12 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn btn-ghost" onClick={() => { setStep(0); setTyped(''); }}>Cancel</button>
            <button
              className="btn"
              style={{ color: 'var(--red)', borderColor: 'rgba(210,96,91,.4)', opacity: typed === agentName ? 1 : 0.45 }}
              disabled={typed !== agentName}
              onClick={() => setStep(3)}
            >
              Continue
            </button>
          </div>
        </>
      ) : null}
      {step === 3 ? (
        <>
          <strong>Last step</strong>
          <div style={{ marginTop: 4 }}>
            This is rate limited to three exports an hour, so that a stolen session cannot quietly drain every agent
            you own. The key appears once, on this page, and is not stored by it.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn btn-ghost" onClick={() => { setStep(0); setTyped(''); }}>Cancel</button>
            <button
              className="btn"
              style={{ color: 'var(--red)', borderColor: 'rgba(210,96,91,.4)' }}
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await exportKey(agentId);
                  if (r.ok) setKey(r.data);
                  else setFail(r);
                })
              }
            >
              {pending ? 'Asking the signer…' : 'Show the key once'}
            </button>
          </div>
        </>
      ) : null}
      {fail ? <Problem f={fail} /> : null}
    </div>
  );
}

/** Derive the trading wallet. Idempotent, so there is nothing to get wrong. */
export function DeriveWalletButton({ agentId }: { agentId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [fail, setFail] = useState<Fail | null>(null);
  return (
    <>
      <button
        className="btn btn-primary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await ensureWallet(agentId);
            if (r.ok) router.refresh();
            else setFail(r);
          })
        }
      >
        {pending ? 'Deriving…' : 'Derive this agent’s wallet'}
      </button>
      {fail ? <Problem f={fail} /> : null}
    </>
  );
}

/** The armed conditions, and the ones this platform does not evaluate. */
export function TriggersPanel({ t }: { t: Triggers }) {
  const [showUnavailable, setShowUnavailable] = useState(false);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 20 }}>
      <section className="box">
        <span className="k">Armed conditions · {t.armed.length + (t.cost_meter.armed ? 1 : 0)}</span>
        {t.armed.length === 0 && !t.cost_meter.armed ? (
          <div className="m3" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
            Nothing is armed on this agent. No protective level is set on any position, and no cost budget is set.
            That is a checked result, not an empty panel.
          </div>
        ) : null}

        {t.armed.map((g) => (
          <div key={g.id} style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--color-divider)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <span className="mono">{g.symbol}</span>
              <span className={g.held_back_since ? 'mono dn' : g.watched ? 'mono up' : 'mono am'} style={{ fontSize: 10.5 }}>
                {g.held_back_since ? 'ARMED · HELD BACK' : g.watched ? 'ARMED · WATCHED' : 'ARMED · NOT WATCHED'}
              </span>
            </div>
            <div className="mono m2" style={{ fontSize: 11.5, marginTop: 4 }}>
              {g.stop_loss_fraction !== null ? (
                <>
                  stop {g.stop_loss_price ?? '—'} <span className="m3">({g.stop_loss_fraction} = {g.stop_loss_percent}%)</span>
                </>
              ) : (
                <span className="m3">no stop armed</span>
              )}
              <br />
              {g.take_profit_fraction !== null ? (
                <>
                  target {g.take_profit_price ?? '—'}{' '}
                  <span className="m3">({g.take_profit_fraction} = {g.take_profit_percent}%)</span>
                </>
              ) : (
                <span className="m3">no target armed</span>
              )}
            </div>
            {/* ARMED AND UNWATCHED IS THE STATE NOBODY EXPECTS. */}
            {!g.watched && g.watched_note ? (
              <div className="callout callout-bad" style={{ marginTop: 8 }}>
                {g.watched_note}
              </div>
            ) : null}
            {g.held_back_since ? (
              <div className="dn" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>
                Crossed and NOT taken since {g.held_back_since.replace('T', ' ').slice(0, 19)}Z —{' '}
                {g.held_back_because ?? 'no reason recorded'}.
              </div>
            ) : null}
          </div>
        ))}

        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--color-divider)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5 }}>Cost budget</span>
            <span className={t.cost_meter.armed ? 'mono up' : 'mono m3'} style={{ fontSize: 10.5 }}>
              {t.cost_meter.armed ? `ARMED · ${t.cost_meter.budget_monthly_pct}% / month` : 'NOT SET'}
            </span>
          </div>
          <div className="m3" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.45 }}>
            {t.cost_meter.note}
          </div>
        </div>
      </section>

      {t.refused.length > 0 ? (
        <section className="box" style={{ borderColor: 'rgba(210,96,91,.4)' }}>
          <span className="k">Refused levels · {t.refused.length}</span>
          {t.refused.map((g) => (
            <div key={g.id} style={{ marginTop: 8, fontSize: 12, lineHeight: 1.5 }}>
              <span className="mono">{g.symbol}</span> — {g.because ?? 'no reason recorded'}
              {g.smallest_accepted_percent !== null ? (
                <div className="mono m3" style={{ fontSize: 11 }}>
                  smallest this pool accepts: {g.smallest_accepted_fraction} = {g.smallest_accepted_percent}%
                </div>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      <section className="box">
        <span className="k">Fired · history</span>
        {t.fired.length === 0 ? (
          <div className="m3" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
            Nothing armed on this agent has ever fired. A counted zero: the record was read and holds none.
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table" style={{ marginTop: 8, fontSize: 11.5 }}>
              <tbody>
                {t.fired.slice(0, 15).map((f, i) => (
                  <tr key={`${f.at}-${i}`}>
                    <td className="mono m2" style={{ whiteSpace: 'nowrap' }}>
                      {f.at ? f.at.replace('T', ' ').slice(0, 16) : '—'}
                    </td>
                    <td>{f.what}</td>
                    <td className="m2">{f.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* THE EDITOR THAT IS NOT HERE, AND WHY. */}
      <section className="box" style={{ borderColor: 'rgba(212,162,74,.45)' }}>
        <span className="k am">Conditions this platform does not evaluate · {t.not_available.length}</span>
        <div className="m2" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
          {t.not_available_note}
        </div>
        <button className="btn-link" style={{ marginTop: 8 }} onClick={() => setShowUnavailable(!showUnavailable)}>
          {showUnavailable ? 'Hide' : 'Show'} what is missing
        </button>
        {showUnavailable
          ? t.not_available.map((n) => (
              <div key={n.condition} style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--color-divider)' }}>
                <div className="mono" style={{ fontSize: 12 }}>
                  {n.condition} → {n.action}
                </div>
                <div className="m3" style={{ fontSize: 11, marginTop: 2, lineHeight: 1.45 }}>
                  {n.missing}
                </div>
              </div>
            ))
          : null}
      </section>
    </div>
  );
}
