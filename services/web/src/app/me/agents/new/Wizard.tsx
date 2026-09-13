'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { activateAgent, createAgent, deriveWallet, importWallet, type Created } from './actions';
import type { MandateTemplates } from '../../shapes';

/**
 * Seven steps, and two of them say the platform does not work the way the
 * design drew it.
 *
 * CADENCE IS NOT A PROPERTY OF AN AGENT HERE. The design has a slider from 5
 * minutes to 24 hours with a live cost projection. This platform ticks a
 * COMPETITION, on a timer the operator sets, and every agent in it is asked on
 * the same clock — there is no per-agent interval column and nothing would read
 * one. So the step shows the cadence actually in force and the cost that
 * follows from it, and says the slider is not something to move.
 *
 * THE UNIVERSE IS A NAMED SET, NOT A BASKET OF TICKED SYMBOLS. `assetUniverse`
 * is one string. The step lists the universes that exist and the symbols each
 * one contains, rather than offering checkboxes that would be collapsed into a
 * single value on the way out.
 *
 * NOTHING IS WRITTEN UNTIL STEP 7, and then it is written as a DRAFT. The
 * activate call is separate and is the one that costs a slot, so abandoning the
 * wizard leaves a row nobody is trading, not an agent running on a
 * half-finished configuration.
 *
 * EVERY FRACTION IS SHOWN IN BOTH SCALES AS IT IS TYPED. This is the platform
 * where 0.15 was armed as 15%, and a form that shows only the number in the box
 * is where that happens again.
 */

type Fail = { ok: false; status: number | null; reason: string; code: string | null };

const STEPS = ['Identity', 'Strategy', 'Risk', 'Cadence', 'Universe', 'Wallet', 'Review'] as const;

const asPct = (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return `${(n * 100).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}%`;
};

export type Universe = {
  value: string;
  label: string;
  symbols: string[];
  note: string | null;
};

export function Wizard({
  templates,
  universes,
  cadence,
  slotsFree,
  slotsNote,
}: {
  templates: MandateTemplates | null;
  universes: Universe[];
  cadence: { known: boolean; ticks_per_day: number | null; note: string };
  slotsFree: number;
  slotsNote: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [pending, start] = useTransition();
  const [fail, setFail] = useState<Fail | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [activated, setActivated] = useState(false);

  // identity
  const [name, setName] = useState('');
  const [strategyType, setStrategyType] = useState('');
  // strategy
  const [mode, setMode] = useState<'template' | 'free'>(templates?.templates.length ? 'template' : 'free');
  const [templateId, setTemplateId] = useState(templates?.templates[0]?.id ?? '');
  const [params, setParams] = useState<Record<string, string>>({});
  const [mandate, setMandate] = useState('');
  // risk
  const [maxPosition, setMaxPosition] = useState('0.40');
  const [cashFloor, setCashFloor] = useState('0.20');
  const [stopLoss, setStopLoss] = useState('0.0150');
  const [takeProfit, setTakeProfit] = useState('0.0400');
  const [costBudget, setCostBudget] = useState('');
  // universe
  const [universe, setUniverse] = useState(universes[0]?.value ?? '');
  // wallet
  const [walletMode, setWalletMode] = useState<'derive' | 'import'>('derive');
  const [privateKey, setPrivateKey] = useState('');
  const [ack, setAck] = useState(false);
  // visibility — chosen here because it only moves one way (private → public)
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');

  const maxChars = templates?.max_chars ?? 1200;
  const tpl = templates?.templates.find((t) => t.id === templateId) ?? null;

  const riskProfile = useMemo(() => {
    const out: Record<string, unknown> = {};
    const put = (k: string, v: string) => {
      const n = Number(v);
      if (v !== '' && Number.isFinite(n)) out[k] = n;
    };
    put('max_position_pct', maxPosition);
    put('cash_floor_pct', cashFloor);
    put('stop_loss_fraction', stopLoss);
    put('take_profit_fraction', takeProfit);
    put('cost_budget_monthly_pct', costBudget);
    return out;
  }, [maxPosition, cashFloor, stopLoss, takeProfit, costBudget]);

  const nameOk = name.trim().length >= 3 && name.trim().length <= 100;
  const strategyOk = mode === 'template' ? !!templateId : mandate.trim().length > 0 && mandate.length <= maxChars;
  const canReview = nameOk && strategyOk && !!universe;

  const submit = () => {
    setFail(null);
    start(async () => {
      const r = await createAgent({
        name: name.trim(),
        strategyType: strategyType.trim() || undefined,
        assetUniverse: universe,
        mandate: mode === 'free' ? mandate : undefined,
        mandateTemplate: mode === 'template' ? templateId : undefined,
        mandateParams: mode === 'template' ? coerceParams(tpl, params) : undefined,
        riskProfile,
        visibility,
      });
      if (!r.ok) {
        setFail(r);
        return;
      }
      setCreated(r.data);

      // The wallet is attached to the DRAFT, before activation, so an agent
      // never goes live with nowhere for its money to be.
      if (walletMode === 'import' && privateKey.trim()) {
        const w = await importWallet(r.data.id, privateKey.trim());
        if (!w.ok) setFail(w);
        setPrivateKey('');
      } else {
        const w = await deriveWallet(r.data.id);
        if (!w.ok) setFail(w);
      }
    });
  };

  const activate = () => {
    if (!created) return;
    setFail(null);
    start(async () => {
      const r = await activateAgent(created.id);
      if (r.ok) {
        setActivated(true);
        router.refresh();
      } else {
        setFail(r);
      }
    });
  };

  return (
    <div className="wizard-grid">
      <nav className="wz" aria-label="Create agent">
        <div className="grp" style={{ marginTop: 0 }}>
          Create agent
        </div>
        {STEPS.map((s, i) => (
          <span key={s} className={i === step ? 'on' : i < step ? 'done' : ''}>
            <i>{i < step ? '✓' : i + 1}</i>
            {s}
          </span>
        ))}
        <div className="m3" style={{ fontSize: 10.5, marginTop: 18, lineHeight: 1.45 }}>
          Nothing is written until step 7, and what step 7 writes is a DRAFT. Activating it is a separate act — that
          is the one that takes a slot.
        </div>
      </nav>

      <div style={{ minWidth: 0 }}>
        {created ? (
          <Done created={created} activated={activated} onActivate={activate} pending={pending} fail={fail} slotsFree={slotsFree} slotsNote={slotsNote} />
        ) : (
          <>
            {step === 0 ? (
              <Step title="Identity" lede="Public. Shown on the leaderboard and in the marketplace.">
                <div className="field">
                  <label htmlFor="agentname">Name</label>
                  <input
                    id="agentname"
                    className="input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    style={{ width: '100%' }}
                  />
                  <div className="help">
                    3–100 characters, unique per creator. {name.trim().length > 0 && !nameOk ? (
                      <span className="dn">That length will be refused.</span>
                    ) : null}
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="strategytype">Strategy type · optional</label>
                  <input
                    id="strategytype"
                    className="input"
                    value={strategyType}
                    onChange={(e) => setStrategyType(e.target.value)}
                    placeholder="momentum, mean_reversion, buy_and_hold…"
                    style={{ width: '100%' }}
                  />
                  <div className="help">
                    A label, and one the platform checks you against: the strategy factor compares what you declare
                    here with what the agent is observed doing, and a mislabelled agent keeps less of what it earned.
                  </div>
                </div>
              </Step>
            ) : null}

            {step === 1 ? (
              <Step
                title="Strategy"
                lede="A template, or your own words. The mandate is what the model is given every tick, and what the agent is judged against."
              >
                {templates?.templates.length ? (
                  <div className="seg" style={{ fontSize: 12, width: 'max-content' }}>
                    <button className="seg-opt" aria-current={mode === 'template' ? 'true' : undefined} onClick={() => setMode('template')}>
                      Template
                    </button>
                    <button className="seg-opt" aria-current={mode === 'free' ? 'true' : undefined} onClick={() => setMode('free')}>
                      Free-form mandate
                    </button>
                  </div>
                ) : null}

                {mode === 'template' && templates ? (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, marginTop: 12 }}>
                      {templates.templates.map((t) => (
                        <label key={t.id} className="tpl" style={templateId === t.id ? { borderColor: 'var(--color-accent)' } : undefined}>
                          <input
                            type="radio"
                            name="tpl"
                            checked={templateId === t.id}
                            onChange={() => setTemplateId(t.id)}
                          />
                          <b style={{ color: 'var(--color-text)', fontWeight: 500 }}>{t.label}</b>
                          <br />
                          {t.description}
                        </label>
                      ))}
                    </div>
                    {tpl && tpl.params.length > 0 ? (
                      <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
                        {tpl.params.map((p) => (
                          <TemplateParam
                            key={String(p.name)}
                            p={p}
                            value={params[String(p.name)] ?? String(p.default ?? '')}
                            onChange={(v) => setParams({ ...params, [String(p.name)]: v })}
                          />
                        ))}
                      </div>
                    ) : null}
                    <div className="m3" style={{ fontSize: 11, marginTop: 12, lineHeight: 1.45 }}>
                      {templates.note}
                    </div>
                  </>
                ) : null}

                {mode === 'free' ? (
                  <>
                    <div className="field" style={{ marginTop: 12 }}>
                      <label htmlFor="mandate">Mandate</label>
                      <textarea
                        id="mandate"
                        className="input"
                        rows={8}
                        value={mandate}
                        onChange={(e) => setMandate(e.target.value)}
                        style={{ width: '100%', lineHeight: 1.55 }}
                      />
                      <div className="help" style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                        <span>Be concrete: what to hold, when to enter, when to exit, what to do when unsure.</span>
                        <span className={mandate.length > maxChars ? 'mono dn' : 'mono'}>
                          {mandate.length} / {maxChars}
                        </span>
                      </div>
                    </div>
                    <div className="box" style={{ marginTop: 12 }}>
                      <div className="lbl">A MANDATE THAT WORKS, AND WHY</div>
                      <div className="m2" style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.55 }}>
                        &ldquo;Hold at most three of the largest names by market cap. Size each position by inverse
                        20-tick volatility. Add only when price is above both the 20- and 50-tick means. Exit a name
                        fully when it closes below its 50-tick mean. Do nothing when no rule fires.&rdquo;
                      </div>
                      <div className="m3" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.45 }}>
                        It names an entry, an exit, a size rule and what to do when nothing applies. The last clause
                        matters most: without it a model asked every tick will find a reason to act.
                      </div>
                    </div>
                    <div className="callout callout-warn" style={{ marginTop: 12 }}>
                      <strong>Write protective levels as fractions, in both scales.</strong>{' '}
                      <span className="mono">0.0015</span> is 0.15%, not 0.15. An owner who wrote 0.15 meaning
                      &ldquo;get me out if it drops 0.15%&rdquo; armed a stop a hundred times further away, and the
                      record was correct so nothing caught it.
                    </div>
                  </>
                ) : null}
              </Step>
            ) : null}

            {step === 2 ? (
              <Step
                title="Risk"
                lede="Hard limits the platform applies before any order is sent. The model cannot override them; an order that breaks one is refused and recorded."
              >
                <div className="two-col" style={{ marginTop: 4 }}>
                  <Fraction label="Max position size" value={maxPosition} onChange={setMaxPosition} help="The largest a single symbol may be, at fill." />
                  <Fraction label="Cash floor" value={cashFloor} onChange={setCashFloor} help="A buy that would take cash below this is refused." />
                  <Fraction label="stop_loss_fraction" value={stopLoss} onChange={setStopLoss} help="Armed on every fill. Fires as a protective exit — recorded as the platform's act, not as the agent's decision." accent />
                  <Fraction label="take_profit_fraction · optional" value={takeProfit} onChange={setTakeProfit} help="Leave empty to let the mandate decide exits." />
                  <Fraction
                    label="cost_budget_monthly_pct · optional"
                    value={costBudget}
                    onChange={setCostBudget}
                    help="A percentage, not a fraction: 2 means 2% of capital a month on gas and pool fees. Leave empty and nothing meters what this agent spends — which is the default."
                    percentUnits
                  />
                </div>

                <WorkedConversion stop={stopLoss} take={takeProfit} />

                <div className="callout callout-note" style={{ marginTop: 12 }}>
                  A key this platform does not read is accepted, stored, and silently ignored — so the response to
                  step 7 names every key the engine will not read, and every key whose NAME lies about its scale. Read
                  it; that is the moment a typo costs you the protection you think you just set.
                </div>
              </Step>
            ) : null}

            {step === 3 ? (
              <Step title="Cadence" lede="How often the agent is asked for a decision.">
                {/* THE STEP THAT SAYS THE SLIDER DOES NOT EXIST. */}
                <div className="callout callout-warn">
                  <strong>Cadence is not a property of an agent on this platform.</strong> A COMPETITION ticks on a
                  timer the operator sets, and every agent in it is asked on the same clock. There is no per-agent
                  interval to choose here, and a slider offering one would be a control that changes nothing.
                </div>
                <div className="box" style={{ marginTop: 12 }}>
                  <div className="lbl">THE CADENCE ACTUALLY IN FORCE</div>
                  <div className="mono" style={{ fontSize: 22, marginTop: 4 }}>
                    {cadence.known && cadence.ticks_per_day !== null ? (
                      <>
                        {cadence.ticks_per_day} <span className="m3" style={{ fontSize: 12 }}>ticks / day</span>
                      </>
                    ) : (
                      <span className="m3">—</span>
                    )}
                  </div>
                  <div className="m3" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>
                    {cadence.note}
                  </div>
                </div>
                <div className="box" style={{ marginTop: 12 }}>
                  <div className="lbl">WHAT EACH TICK COSTS</div>
                  <div className="m2" style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.55 }}>
                    A tick costs a model call; a tick that trades also costs gas and a pool fee. This platform does not
                    publish a price-per-call or a gas estimate before an agent has traded, so no projection is offered
                    here — a figure made from a guessed model price and a guessed fill rate would be a number with a
                    currency symbol and no measurement behind it.
                  </div>
                  <div className="m3" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.45 }}>
                    Once the agent has made a few priced executions, its wallet page reports the median gas of its own
                    fills and how many more transactions the balance covers. That figure is measured.
                    {costBudget
                      ? ` And the cost budget you set (${costBudget}% a month) pauses it before it spends past that.`
                      : ' You set no cost budget, so nothing will meter what it spends.'}
                  </div>
                </div>
              </Step>
            ) : null}

            {step === 4 ? (
              <Step title="Universe" lede="The set of symbols this agent may trade. It decides which seasons it can enter.">
                {universes.length === 0 ? (
                  <div className="callout callout-bad">
                    No universe could be read from the platform, so none can be offered. Nothing is invented here — an
                    agent created against a universe that does not exist would never be asked for a decision.
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: 10 }}>
                    {universes.map((u) => (
                      <label
                        key={u.value}
                        className="tpl"
                        style={universe === u.value ? { borderColor: 'var(--color-accent)' } : undefined}
                      >
                        <input type="radio" name="universe" checked={universe === u.value} onChange={() => setUniverse(u.value)} />
                        <b style={{ color: 'var(--color-text)', fontWeight: 500 }}>{u.label}</b>
                        <span className="mono m3"> {u.value}</span>
                        {u.symbols.length > 0 ? (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
                            {u.symbols.slice(0, 24).map((s) => (
                              <span key={s} className="sym">
                                {s}
                              </span>
                            ))}
                            {u.symbols.length > 24 ? (
                              <span className="m3" style={{ fontSize: 11 }}>
                                +{u.symbols.length - 24} more
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                        {u.note ? (
                          <div className="m3" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>
                            {u.note}
                          </div>
                        ) : null}
                      </label>
                    ))}
                  </div>
                )}
                <div className="m3" style={{ fontSize: 11, marginTop: 12, lineHeight: 1.45 }}>
                  The design offers a basket of individually ticked symbols. This platform stores ONE universe name per
                  agent and the engine reads that, so choosing symbols one by one would be a control whose result is
                  thrown away on the way out.
                </div>
              </Step>
            ) : null}

            {step === 5 ? (
              <Step title="Wallet" lede="The agent trades from its own wallet. You fund it; you can take the key at any time.">
                <div className="two-col">
                  <label className="tpl" style={walletMode === 'derive' ? { borderColor: 'var(--color-accent)' } : undefined}>
                    <input type="radio" name="wallet" checked={walletMode === 'derive'} onChange={() => setWalletMode('derive')} />
                    <b style={{ color: 'var(--color-text)', fontWeight: 500 }}>Generate a new wallet</b>
                    <div style={{ marginTop: 4 }}>
                      Derived by the signer from this agent&rsquo;s id. It holds only what you put in it, and the key
                      is exportable later behind a three-step confirmation. Recommended.
                    </div>
                  </label>
                  <label className="tpl" style={walletMode === 'import' ? { borderColor: 'var(--color-accent)' } : undefined}>
                    <input type="radio" name="wallet" checked={walletMode === 'import'} onChange={() => setWalletMode('import')} />
                    <b style={{ color: 'var(--color-text)', fontWeight: 500 }}>Import a dedicated wallet key</b>
                    <div style={{ marginTop: 4 }}>
                      A private key for a wallet you created for this purpose and nothing else.
                    </div>
                  </label>
                </div>

                {walletMode === 'import' ? (
                  <>
                    {/* THE WARNING IS NOT A FOOTNOTE. */}
                    <div className="callout callout-bad" style={{ marginTop: 12 }}>
                      <strong>If you import a key, ARCANA can sign anything from that wallet — not only trades.</strong>{' '}
                      The signer restricts what it will build: two named transaction shapes, an allowlisted router, an
                      allowlisted token, no raw calldata. But that is ARCANA restricting itself, not a property of the
                      key. Never import a wallet that holds anything else, and never import your main wallet.
                    </div>
                    <div className="field" style={{ marginTop: 12 }}>
                      <label htmlFor="pk">Private key</label>
                      <input
                        id="pk"
                        className="input mono"
                        type="password"
                        value={privateKey}
                        onChange={(e) => setPrivateKey(e.target.value)}
                        placeholder="0x…"
                        style={{ width: '100%', fontSize: 12 }}
                      />
                      <div className="help">
                        It travels to the signer over the internal network and is never written to a log, a database
                        or an error message here.
                      </div>
                    </div>
                  </>
                ) : null}
              </Step>
            ) : null}

            {step === 6 ? (
              <Step title="Review" lede="Nothing has been written yet. Creating writes a draft; activating is the step that takes a slot.">
                <div className="two-col">
                  <div className="box">
                    <Row k="Name" v={name || '—'} />
                    <Row k="Strategy type" v={strategyType || 'not stated'} />
                    <Row k="Universe" v={universe || '—'} />
                    <Row k="Wallet" v={walletMode === 'derive' ? 'new · derived by the signer' : 'imported key'} />
                  </div>
                  <div className="box">
                    <Row k="max_position_pct" v={`${maxPosition} = ${asPct(maxPosition) ?? '—'}`} />
                    <Row k="cash_floor_pct" v={`${cashFloor} = ${asPct(cashFloor) ?? '—'}`} />
                    <Row k="stop_loss_fraction" v={`${stopLoss} = ${asPct(stopLoss) ?? '—'}`} />
                    <Row k="take_profit_fraction" v={takeProfit ? `${takeProfit} = ${asPct(takeProfit)}` : 'none'} />
                    <Row k="cost_budget_monthly_pct" v={costBudget ? `${costBudget}% a month` : 'unmetered'} />
                  </div>
                </div>

                <div style={{ borderLeft: '2px solid var(--color-accent)', padding: '4px 0 4px 14px', marginTop: 16 }}>
                  <div className="k" style={{ marginBottom: 6 }}>
                    {mode === 'template' ? 'Mandate · rendered from the template at creation' : 'Mandate · stored verbatim'}
                  </div>
                  <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>
                    {mode === 'template'
                      ? `${tpl?.label ?? templateId} — the platform renders the text from this template and the answers above, and stores the result.`
                      : mandate || <span className="m3">nothing written</span>}
                  </div>
                </div>

                {/* PRIVATE AGENT. PUBLIC PROOF. Chosen here, with what each choice
                    means stated before anything is written, because the choice
                    only moves one way: private can later become public, public can
                    never become private. */}
                <div className="box" style={{ marginTop: 16 }}>
                  <div className="k" style={{ marginBottom: 8 }}>Visibility</div>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, color: 'var(--ink-2)' }}>
                    <input type="radio" name="visibility" checked={visibility === 'public'} onChange={() => setVisibility('public')} style={{ marginTop: 3 }} />
                    <span>
                      <strong style={{ color: 'var(--color-text)' }}>Public.</strong> The mandate, risk rules and the
                      prompt, raw response, model and thesis behind every decision are readable by anyone.{' '}
                      <span className="m3">It can never be made private later.</span>
                    </span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, color: 'var(--ink-2)', marginTop: 10 }}>
                    <input type="radio" name="visibility" checked={visibility === 'private'} onChange={() => setVisibility('private')} style={{ marginTop: 3 }} />
                    <span>
                      <strong style={{ color: 'var(--color-text)' }}>Private.</strong> The mandate, risk rules, protective
                      levels, prompts, model and reasoning stay yours. Decisions, executions, performance, score, rank
                      and DNA stay public, and every decision is sealed with a commitment that proves its reasoning was
                      not changed afterwards. You can open a single decision, or make the whole agent public, later —
                      either is permanent and on its public record. A subscription does not unlock it.
                    </span>
                  </label>
                </div>

                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, marginTop: 16, color: 'var(--ink-2)' }}>
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ marginTop: 2 }} />
                  I understand this agent will trade real funds from its own wallet, that its decisions are public
                  {visibility === 'public' ? ' and so is its mandate' : ' while its intelligence stays private'}, and
                  that the mandate cannot be edited once it is active — changing it means creating a new version,
                  which starts its record over.
                </label>

                <button
                  className="btn btn-primary"
                  style={{ marginTop: 14, opacity: ack && canReview ? 1 : 0.45 }}
                  disabled={!ack || !canReview || pending}
                  onClick={submit}
                >
                  {pending ? 'Creating the draft…' : 'Create as a draft'}
                </button>
                {!canReview ? (
                  <div className="dn" style={{ fontSize: 11.5, marginTop: 8 }}>
                    A name, a strategy and a universe are all required before anything can be written.
                  </div>
                ) : null}
                {fail ? <Problem f={fail} /> : null}
              </Step>
            ) : null}

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 18, paddingTop: 12, borderTop: '1px solid var(--color-divider)' }}>
              <button className="btn" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>
                Back
              </button>
              {step < 6 ? (
                <button className="btn btn-primary" onClick={() => setStep(step + 1)}>
                  Next · {STEPS[step + 1]}
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Step({ title, lede, children }: { title: string; lede: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 style={{ fontSize: 22, margin: 0 }}>{title}</h2>
      <div className="m2" style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.5 }}>
        {lede}
      </div>
      <div style={{ marginTop: 16, display: 'grid', gap: 14 }}>{children}</div>
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, padding: '3px 0' }}>
      <span className="m3">{k}</span>
      <span className="mono" style={{ textAlign: 'right', wordBreak: 'break-word' }}>
        {v}
      </span>
    </div>
  );
}

/**
 * A number, with what it means beside it, as it is typed.
 *
 * `percentUnits` is the exception that proves the rule: cost_budget_monthly_pct
 * really is a percentage — 2 means 2% — while every other key here is a
 * fraction. Showing "2 = 200%" for it would be the same mistake in reverse, so
 * the one field that differs is marked rather than treated like its neighbours.
 */
function Fraction({
  label,
  value,
  onChange,
  help,
  accent,
  percentUnits,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  help: string;
  accent?: boolean;
  percentUnits?: boolean;
}) {
  const meaning = percentUnits ? (value ? `${value}% of capital a month` : null) : asPct(value);
  return (
    <div className="field">
      <label>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          className="input mono"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ flex: 1, borderColor: accent ? 'var(--color-accent)' : undefined }}
          inputMode="decimal"
        />
        <span className="mono m3" style={{ fontSize: 11, minWidth: 92, textAlign: 'right' }}>
          {value === '' ? 'not set' : (meaning ?? 'not a number')}
        </span>
      </div>
      <div className="help">{help}</div>
    </div>
  );
}

/** The two levels, converted against a worked entry price. */
function WorkedConversion({ stop, take }: { stop: string; take: string }) {
  const entry = 128.4;
  const s = Number(stop);
  const t = Number(take);
  return (
    <div className="box">
      <div className="lbl">WORKED CONVERSION · AN ENTRY AT {entry.toFixed(2)}</div>
      <div className="mono" style={{ fontSize: 12, marginTop: 6, display: 'grid', gap: 3 }}>
        <div>
          stop <span className="m3">{stop || '—'}</span> →{' '}
          {Number.isFinite(s) && stop ? (entry * (1 - s)).toFixed(2) : <span className="m3">—</span>}{' '}
          <span className="m3">({asPct(stop) ?? '—'} below)</span>
        </div>
        <div>
          target <span className="m3">{take || '—'}</span> →{' '}
          {Number.isFinite(t) && take ? (entry * (1 + t)).toFixed(2) : <span className="m3">—</span>}{' '}
          <span className="m3">({asPct(take) ?? '—'} above)</span>
        </div>
      </div>
      <div className="m3" style={{ fontSize: 10.5, marginTop: 8, lineHeight: 1.45 }}>
        If those prices are not where you meant them, the fraction is the thing to change — not the entry.
      </div>
    </div>
  );
}

function TemplateParam({
  p,
  value,
  onChange,
}: {
  p: Record<string, unknown>;
  value: string;
  onChange: (v: string) => void;
}) {
  const kind = String(p.kind ?? 'string');
  const options = Array.isArray(p.options) ? (p.options as unknown[]).map(String) : [];
  return (
    <div className="field">
      <label>{String(p.label ?? p.name)}</label>
      {kind === 'enum' && options.length > 0 ? (
        <select className="input" value={value} onChange={(e) => onChange(e.target.value)} style={{ width: '100%' }}>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="input mono"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode={kind === 'int' ? 'numeric' : undefined}
          style={{ width: '100%' }}
        />
      )}
      {p.min !== undefined || p.max !== undefined ? (
        <div className="help">
          {p.min !== undefined ? `min ${String(p.min)}` : ''}
          {p.min !== undefined && p.max !== undefined ? ' · ' : ''}
          {p.max !== undefined ? `max ${String(p.max)}` : ''}
        </div>
      ) : null}
    </div>
  );
}

function coerceParams(tpl: MandateTemplates['templates'][number] | null, raw: Record<string, string>) {
  if (!tpl) return {};
  const out: Record<string, unknown> = {};
  for (const p of tpl.params) {
    const name = String(p.name);
    const v = raw[name] ?? String(p.default ?? '');
    if (v === '') continue;
    out[name] = String(p.kind) === 'int' ? Number(v) : v;
  }
  return out;
}

function Problem({ f }: { f: Fail }) {
  return (
    <div className="callout callout-bad" style={{ marginTop: 12 }}>
      <strong>{f.code ?? `The service answered ${f.status ?? 'nothing'}`}</strong>
      <div style={{ marginTop: 4 }}>{f.reason}</div>
    </div>
  );
}

/** The draft exists. What remains is the step that costs something. */
function Done({
  created,
  activated,
  onActivate,
  pending,
  fail,
  slotsFree,
  slotsNote,
}: {
  created: Created;
  activated: boolean;
  onActivate: () => void;
  pending: boolean;
  fail: Fail | null;
  slotsFree: number;
  slotsNote: string;
}) {
  return (
    <section>
      <h2 style={{ fontSize: 22, margin: 0 }}>{activated ? `${created.name} is live` : `${created.name} exists as a draft`}</h2>
      <div className="m2" style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.5 }}>
        {activated
          ? 'It has a seat and will be asked for a decision on the next tick of a competition it is entered in.'
          : 'Nothing ticks for a draft and nothing is scored. Activating is the step that takes a slot.'}
      </div>

      {/* THE WARNINGS FROM THE CREATE RESPONSE, AT THE MOMENT THEY MATTER. */}
      {created.risk_profile_unrecognised?.length ? (
        <div className="callout callout-warn" style={{ marginTop: 14 }}>
          <strong>Some of what you set will never be read.</strong>
          <div style={{ marginTop: 4 }}>{created.risk_profile_note}</div>
        </div>
      ) : null}
      {created.risk_profile_ambiguous?.length ? (
        <div className="callout callout-warn" style={{ marginTop: 10 }}>
          <strong>A key is named in a way that has already cost somebody a hundredfold.</strong>
          <div style={{ marginTop: 4 }}>{created.risk_profile_ambiguous_note}</div>
        </div>
      ) : null}

      {created.mandate ? (
        <div style={{ borderLeft: '2px solid var(--color-accent)', padding: '4px 0 4px 14px', marginTop: 16 }}>
          <div className="k" style={{ marginBottom: 6 }}>
            Mandate · as stored
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>{created.mandate}</div>
        </div>
      ) : null}

      {fail ? <Problem f={fail} /> : null}

      {!activated ? (
        <>
          <div className="callout callout-note" style={{ marginTop: 16 }}>
            <strong>Fund the wallet before activating, or nothing happens.</strong> The agent never spends anybody
            else&rsquo;s money — until its wallet holds the settlement token it will decide and execute nothing, and
            until it holds gas it cannot send a transaction or fire a protective stop.
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={onActivate} disabled={pending || slotsFree < 1}>
              {pending ? 'Activating…' : `Activate ${created.name}`}
            </button>
            <Link href={`/me/agents/${created.id}`} className="btn">
              Open it and fund it first
            </Link>
          </div>
          {slotsFree < 1 ? (
            <div className="am" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.45 }}>
              {slotsNote}
            </div>
          ) : null}
        </>
      ) : (
        <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
          <Link href={`/me/agents/${created.id}`} className="btn btn-primary">
            Manage it
          </Link>
          <Link href={`/agents/${created.id}`} className="btn">
            Public profile
          </Link>
          <Link href="/me" className="btn btn-ghost">
            Back to overview
          </Link>
        </div>
      )}
    </section>
  );
}
