'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { activateAgent, createAgent, deriveWallet, importWallet, type Created } from './actions';
import type { CostReference, MandateTemplates } from '../../shapes';

/**
 * Create an agent, on one page.
 *
 * FEWER DECISIONS, NOT LESS SAID. It used to be seven steps that asked
 * everything as if it mattered equally. Three things have no sensible default —
 * a name, a strategy, and where the money lives — and those are asked. Visibility
 * has a default but only moves one way, so it is asked too, with the default
 * already chosen. Everything else has a default that is SHOWN with its value and
 * what the value means, and can be changed in place: an owner sees exactly what
 * they are agreeing to without deciding it line by line.
 *
 * WHAT DOES NOT GET SIMPLER:
 *   - every fraction is shown in both scales, with the worked example — this is
 *     the platform where 0.15 was armed as 15%;
 *   - importing a key says, before it is typed, that ARCANA can sign anything
 *     from that wallet;
 *   - the cost of the cadence is projected from measurements, and says which
 *     part is not measured;
 *   - the create response's risk_profile_unrecognised and
 *     risk_profile_ambiguous warnings are shown on the next screen.
 *
 * CADENCE IS NOT A PROPERTY OF AN AGENT HERE. A COMPETITION ticks on a timer the
 * operator sets, and every agent in it is asked on the same clock. So there is
 * no slider — the cadence in force is shown, with what it costs.
 *
 * NOTHING IS WRITTEN UNTIL "Create as a draft", and then it is written as a
 * DRAFT. The activate call is separate and is the one that costs a slot.
 */

type Fail = { ok: false; status: number | null; reason: string; code: string | null };

const asPct = (v: string) => {
  const n = Number(v);
  if (v === '' || !Number.isFinite(n)) return null;
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
  costReference,
  slotsFree,
  slotsNote,
}: {
  templates: MandateTemplates | null;
  universes: Universe[];
  cadence: { known: boolean; ticks_per_day: number | null; note: string };
  costReference: CostReference | null;
  slotsFree: number;
  slotsNote: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [fail, setFail] = useState<Fail | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [activated, setActivated] = useState(false);

  const [name, setName] = useState('');
  const [mode, setMode] = useState<'template' | 'free'>(templates?.templates.length ? 'template' : 'free');
  const [templateId, setTemplateId] = useState(templates?.templates[0]?.id ?? '');
  const [params, setParams] = useState<Record<string, string>>({});
  const [mandate, setMandate] = useState('');
  const [maxPosition, setMaxPosition] = useState('0.40');
  const [cashFloor, setCashFloor] = useState('0.20');
  const [stopLoss, setStopLoss] = useState('0.0150');
  const [takeProfit, setTakeProfit] = useState('0.0400');
  const [costBudget, setCostBudget] = useState('');
  const [universe, setUniverse] = useState(universes[0]?.value ?? '');
  const [walletMode, setWalletMode] = useState<'derive' | 'import'>('derive');
  const [privateKey, setPrivateKey] = useState('');
  const [ack, setAck] = useState(false);
  // visibility — asked because it only moves one way (private → public)
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');

  const maxChars = templates?.max_chars ?? 1200;
  const tpl = templates?.templates.find((t) => t.id === templateId) ?? null;
  const uni = universes.find((u) => u.value === universe) ?? null;

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
  const walletOk = walletMode === 'derive' || /^(0x)?[0-9a-fA-F]{64}$/.test(privateKey.trim());
  const canCreate = nameOk && strategyOk && !!universe && walletOk;

  const submit = () => {
    setFail(null);
    start(async () => {
      const r = await createAgent({
        name: name.trim(),
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

  if (created) {
    return <Done created={created} activated={activated} onActivate={activate} pending={pending} fail={fail} slotsFree={slotsFree} slotsNote={slotsNote} />;
  }

  return (
    <div className="wizard-grid">
      <nav className="wz" aria-label="Create agent">
        <div className="grp" style={{ marginTop: 0 }}>
          What you decide
        </div>
        <span className={nameOk ? 'done' : 'on'}><i>{nameOk ? '✓' : 1}</i>Name</span>
        <span className={strategyOk ? 'done' : ''}><i>{strategyOk ? '✓' : 2}</i>Strategy</span>
        <span className="done"><i>✓</i>Wallet</span>
        <span className="done"><i>✓</i>Visibility</span>
        <div className="grp">Defaults, shown</div>
        <span className="done"><i>·</i>Risk limits</span>
        <span className="done"><i>·</i>Universe</span>
        <span className="done"><i>·</i>Cadence &amp; cost</span>
        <div className="m3" style={{ fontSize: 10.5, marginTop: 18, lineHeight: 1.45 }}>
          Nothing is written until you press Create, and what it writes is a DRAFT. Activating it is a separate act —
          that is the one that takes a slot.
        </div>
      </nav>

      <div style={{ minWidth: 0, display: 'grid', gap: 26 }}>
        {/* ---------------------------------------------------- 1. name */}
        <Part n={1} title="Name" lede="Public. Shown on the leaderboard and in the marketplace.">
          <div className="field">
            <label htmlFor="agentname">Name</label>
            <input id="agentname" className="input" value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} />
            <div className="help">
              3–100 characters, unique per creator.{' '}
              {name.trim().length > 0 && !nameOk ? <span className="dn">That length will be refused.</span> : null}
            </div>
          </div>
          {/* NO STRATEGY TYPE FIELD. Every agent made here has a mandate, and a
              mandate is read only by the model. */}
        </Part>

        {/* ------------------------------------------------ 2. strategy */}
        <Part
          n={2}
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
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
                {templates.templates.map((t) => (
                  <label key={t.id} className="tpl" style={templateId === t.id ? { borderColor: 'var(--color-accent)' } : undefined}>
                    <input type="radio" name="tpl" checked={templateId === t.id} onChange={() => setTemplateId(t.id)} />
                    <b style={{ color: 'var(--color-text)', fontWeight: 500 }}>{t.label}</b>
                    <br />
                    {t.description}
                  </label>
                ))}
              </div>
              {tpl && tpl.params.length > 0 ? (
                <div style={{ display: 'grid', gap: 10 }}>
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
              <div className="m3" style={{ fontSize: 11, lineHeight: 1.45 }}>
                {templates.note}
              </div>
            </>
          ) : null}

          {mode === 'free' ? (
            <>
              <div className="field">
                <label htmlFor="mandate">Mandate</label>
                <textarea
                  id="mandate"
                  className="input"
                  rows={7}
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
              <details className="fold">
                <summary>
                  <span>A mandate that works, and why</span>
                  <span className="fold-state">example</span>
                </summary>
                <div className="fold-body">
                  <div className="m2" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
                    &ldquo;Hold at most three of the largest names by market cap. Size each position by inverse 20-tick
                    volatility. Add only when price is above both the 20- and 50-tick means. Exit a name fully when it
                    closes below its 50-tick mean. Do nothing when no rule fires.&rdquo;
                  </div>
                  <div className="m3" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.45 }}>
                    It names an entry, an exit, a size rule and what to do when nothing applies. The last clause matters
                    most: without it a model asked every tick will find a reason to act.
                  </div>
                </div>
              </details>
              <div className="callout callout-warn">
                <strong>Write protective levels as fractions, in both scales.</strong> <span className="mono">0.0015</span>{' '}
                is 0.15%, not 0.15. An owner who wrote 0.15 meaning &ldquo;get me out if it drops 0.15%&rdquo; armed a
                stop a hundred times further away, and the record was correct so nothing caught it.
              </div>
            </>
          ) : null}
        </Part>

        {/* -------------------------------------------------- 3. wallet */}
        <Part n={3} title="Wallet" lede="The agent trades from its own wallet. You fund it; you can take the key at any time.">
          <div className="two-col">
            <label className="tpl" style={walletMode === 'derive' ? { borderColor: 'var(--color-accent)' } : undefined}>
              <input type="radio" name="wallet" checked={walletMode === 'derive'} onChange={() => setWalletMode('derive')} />
              <b style={{ color: 'var(--color-text)', fontWeight: 500 }}>Generate a new wallet</b>{' '}
              <span className="m3">· default</span>
              <div style={{ marginTop: 4 }}>
                Derived by the signer from this agent&rsquo;s id. It holds only what you put in it, and the key is
                exportable later behind a three-step confirmation. Recommended.
              </div>
            </label>
            <label className="tpl" style={walletMode === 'import' ? { borderColor: 'var(--color-accent)' } : undefined}>
              <input type="radio" name="wallet" checked={walletMode === 'import'} onChange={() => setWalletMode('import')} />
              <b style={{ color: 'var(--color-text)', fontWeight: 500 }}>Import a dedicated wallet key</b>
              <div style={{ marginTop: 4 }}>
                A private key for a wallet you created for this purpose and nothing else.{' '}
                <span className="dn">ARCANA can sign anything from an imported wallet — not only trades.</span>
              </div>
            </label>
          </div>

          {walletMode === 'import' ? (
            <>
              {/* THE WARNING IS NOT A FOOTNOTE. */}
              <div className="callout callout-bad">
                <strong>If you import a key, ARCANA can sign anything from that wallet — not only trades.</strong> The
                signer restricts what it will build: two named transaction shapes, an allowlisted router, an
                allowlisted token, no raw calldata. But that is ARCANA restricting itself, not a property of the key.
                Never import a wallet that holds anything else, and never import your main wallet.
              </div>
              <div className="field">
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
                  It travels to the signer over the internal network and is never written to a log, a database or an
                  error message here.{' '}
                  {privateKey.trim() && !walletOk ? <span className="dn">That is not a 32-byte hex key.</span> : null}
                </div>
              </div>
            </>
          ) : null}
        </Part>

        {/* ---------------------------------------------- 4. visibility */}
        {/* PRIVATE AGENT. PUBLIC PROOF. Asked, with the default already chosen,
            because the choice only moves one way. */}
        <Part n={4} title="Visibility" lede="Public by default. This is the one choice here that cannot be undone in one direction.">
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, color: 'var(--ink-2)' }}>
            <input type="radio" name="visibility" checked={visibility === 'public'} onChange={() => setVisibility('public')} style={{ marginTop: 3 }} />
            <span>
              <strong style={{ color: 'var(--color-text)' }}>Public.</strong> The mandate, risk rules and the prompt,
              raw response, model and thesis behind every decision are readable by anyone.{' '}
              <span className="m3">It can never be made private later.</span>
            </span>
          </label>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, color: 'var(--ink-2)' }}>
            <input type="radio" name="visibility" checked={visibility === 'private'} onChange={() => setVisibility('private')} style={{ marginTop: 3 }} />
            <span>
              <strong style={{ color: 'var(--color-text)' }}>Private.</strong> The mandate, risk rules, protective
              levels, prompts, model and reasoning stay yours. Decisions, executions, performance, score, rank and DNA
              stay public, and every decision is sealed with a commitment that proves its reasoning was not changed
              afterwards. You can open a single decision, or make the whole agent public, later — either is permanent
              and on its public record. A subscription does not unlock it.
            </span>
          </label>
        </Part>

        {/* ------------------------------------------------ defaults */}
        <section>
          <h2 style={{ fontSize: 20, margin: 0 }}>What you are agreeing to</h2>
          <div className="m2" style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.5 }}>
            These have defaults. Every value is shown with what it means; open one only if you want it different.
          </div>

          <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
            <details className="fold">
              <summary>
                <span>Risk limits</span>
                <span className="fold-state">
                  stop {stopLoss || '—'} = {asPct(stopLoss) ?? 'not set'} · target {takeProfit ? `${takeProfit} = ${asPct(takeProfit)}` : 'none'} · max
                  position {asPct(maxPosition) ?? '—'} · cash floor {asPct(cashFloor) ?? '—'} · cost budget{' '}
                  {costBudget ? `${costBudget}%/month` : 'unmetered'}
                </span>
              </summary>
              <div className="fold-body">
                <div className="m2" style={{ fontSize: 12, lineHeight: 1.5, marginBottom: 12 }}>
                  Hard limits the platform applies before any order is sent. The model cannot override them; an order
                  that breaks one is refused and recorded.
                </div>
                <div className="two-col">
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
              </div>
            </details>

            {/* THE CONVERSION IS OUTSIDE THE FOLD, so it is read whether or not
                anybody opens it. */}
            <WorkedConversion stop={stopLoss} take={takeProfit} />

            <details className="fold">
              <summary>
                <span>Universe</span>
                <span className="fold-state">
                  {uni ? `${uni.label} · ${uni.value}` : 'none could be read'}
                  {uni && uni.symbols.length > 0 ? ` · ${uni.symbols.length} symbols` : ''}
                </span>
              </summary>
              <div className="fold-body">
                {universes.length === 0 ? (
                  <div className="callout callout-bad">
                    No universe could be read from the platform, so none can be offered. Nothing is invented here — an
                    agent created against a universe that does not exist would never be asked for a decision.
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: 10 }}>
                    {universes.map((u) => (
                      <label key={u.value} className="tpl" style={universe === u.value ? { borderColor: 'var(--color-accent)' } : undefined}>
                        <input type="radio" name="universe" checked={universe === u.value} onChange={() => setUniverse(u.value)} />
                        <b style={{ color: 'var(--color-text)', fontWeight: 500 }}>{u.label}</b>
                        <span className="mono m3"> {u.value}</span>
                        {u.symbols.length > 0 ? (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
                            {u.symbols.slice(0, 24).map((sym) => (
                              <span key={sym} className="sym">
                                {sym}
                              </span>
                            ))}
                            {u.symbols.length > 24 ? <span className="m3" style={{ fontSize: 11 }}>+{u.symbols.length - 24} more</span> : null}
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
                <div className="m3" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.45 }}>
                  One universe name is stored per agent and the engine reads that, so there is no basket of individually
                  ticked symbols to choose.
                </div>
              </div>
            </details>

            <CadenceCost cadence={cadence} costRef={costReference} costBudget={costBudget} />
          </div>
        </section>

        {/* ------------------------------------------------ create */}
        <section style={{ borderTop: '1px solid var(--color-divider)', paddingTop: 16 }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, color: 'var(--ink-2)' }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ marginTop: 2 }} />
            I understand this agent will trade real funds from its own wallet, that its decisions are public
            {visibility === 'public' ? ' and so is its mandate' : ' while its intelligence stays private'}, and that the
            mandate cannot be edited once it is active — changing it means creating a new version, which starts its
            record over.
          </label>

          <button
            className="btn btn-primary"
            style={{ marginTop: 14, opacity: ack && canCreate ? 1 : 0.45 }}
            disabled={!ack || !canCreate || pending}
            onClick={submit}
          >
            {pending ? 'Creating the draft…' : 'Create as a draft'}
          </button>
          {!canCreate ? (
            <div className="dn" style={{ fontSize: 11.5, marginTop: 8 }}>
              {!nameOk ? 'A name of 3–100 characters is needed. ' : ''}
              {!strategyOk ? 'A template or a mandate is needed. ' : ''}
              {!universe ? 'A universe is needed. ' : ''}
              {!walletOk ? 'The imported key is not a valid private key.' : ''}
            </div>
          ) : null}
          {fail ? <Problem f={fail} /> : null}
        </section>
      </div>
    </div>
  );
}

function Part({ n, title, lede, children }: { n: number; title: string; lede: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 style={{ fontSize: 20, margin: 0 }}>
        <span className="mono m3" style={{ fontSize: 13, marginRight: 8 }}>
          {n}
        </span>
        {title}
      </h2>
      <div className="m2" style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.5 }}>
        {lede}
      </div>
      <div style={{ marginTop: 12, display: 'grid', gap: 12 }}>{children}</div>
    </section>
  );
}

/**
 * The cadence in force, and what it costs — from measurements only.
 *
 * TOKENS AND GAS ARE MEASURED, A MODEL PRICE IS NOT. The projection multiplies
 * the running season's ticks per day by what live agents on this platform have
 * actually used over 30 days. Where a factor has not been measured the line says
 * so instead of filling it in; a figure made from a guessed price would be a
 * number with a currency symbol and no measurement behind it.
 */
function CadenceCost({
  cadence,
  costRef,
  costBudget,
}: {
  cadence: { known: boolean; ticks_per_day: number | null; note: string };
  costRef: CostReference | null;
  costBudget: string;
}) {
  const tpd = cadence.known ? cadence.ticks_per_day : null;
  const tokensPerDay = tpd !== null && costRef?.median_tokens_per_decision != null ? Math.round(tpd * costRef.median_tokens_per_decision) : null;
  const gasPerDay =
    tpd !== null &&
    costRef?.share_of_decisions_that_traded != null &&
    costRef.transactions_per_trade != null &&
    costRef.median_gas_usd_per_transaction != null
      ? tpd * costRef.share_of_decisions_that_traded * costRef.transactions_per_trade * costRef.median_gas_usd_per_transaction
      : null;

  return (
    <div className="box">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <span className="k">Cadence &amp; projected cost</span>
        <span className="mono m2" style={{ fontSize: 11 }}>
          {tpd !== null ? `${tpd} ticks / day` : 'no cadence measured'}
        </span>
      </div>
      <div className="m3" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>
        Cadence is not a property of an agent on this platform: a competition ticks on a timer the operator sets, and
        every agent in it is asked on the same clock. {cadence.note}
      </div>

      <div className="mono" style={{ fontSize: 12, marginTop: 10, display: 'grid', gap: 4 }}>
        <div>
          model:{' '}
          {tokensPerDay !== null ? (
            <>
              ~{tokensPerDay.toLocaleString('en-US')} tokens / day{' '}
              <span className="m3">({costRef!.median_tokens_per_decision} median per decision · dollar price not recorded)</span>
            </>
          ) : (
            <span className="m3">not measured — no cadence or no priced decisions to take a median from</span>
          )}
        </div>
        <div>
          gas:{' '}
          {gasPerDay !== null ? (
            <>
              ~${gasPerDay.toFixed(4)} / day{' '}
              <span className="m3">
                ({(costRef!.share_of_decisions_that_traded! * 100).toFixed(1)}% of decisions traded ·{' '}
                {costRef!.transactions_per_trade} tx per trade · ${costRef!.median_gas_usd_per_transaction} median per tx)
              </span>
            </>
          ) : (
            <span className="m3">not measured — too few priced transactions on record to project from</span>
          )}
        </div>
      </div>
      <div className="m3" style={{ fontSize: 10.5, marginTop: 8, lineHeight: 1.45 }}>
        Measured over {costRef?.window ?? 'nothing — the reference could not be read'}. Your agent&rsquo;s own figures
        will differ with its mandate; once it has a few priced fills its wallet tab measures them.{' '}
        {costBudget
          ? `The cost budget you set (${costBudget}% a month) pauses it before it spends past that.`
          : 'You set no cost budget, so nothing will meter what it spends.'}
      </div>
    </div>
  );
}

/**
 * A number, with what it means beside it, as it is typed.
 *
 * `percentUnits` is the exception that proves the rule: cost_budget_monthly_pct
 * really is a percentage — 2 means 2% — while every other key here is a
 * fraction. Showing "2 = 200%" for it would be the same mistake in reverse.
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

/** The two levels, converted against a worked entry price, with the example that matters. */
function WorkedConversion({ stop, take }: { stop: string; take: string }) {
  const entry = 128.4;
  const s = Number(stop);
  const t = Number(take);
  return (
    <div className="box">
      <div className="lbl">WHAT YOUR STOP AND TARGET MEAN · AN ENTRY AT {entry.toFixed(2)}</div>
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
        These are FRACTIONS: <span className="mono">0.0015</span> means 0.15%, not 0.15. If those prices are not where
        you meant them, the fraction is the thing to change — not the entry. A key this platform does not read is
        accepted and ignored, so the next screen names every key the engine will not read and every key whose name
        lies about its scale.
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
          ? 'It is active and holds a slot. It is asked for a decision only on the ticks of a competition it has a seat in — activating does not enter it in one.'
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
            <strong>Fund the wallet before activating, or it cannot trade.</strong> The agent never spends anybody
            else&rsquo;s money — until its wallet holds the settlement token its decisions are still recorded but
            nothing is executed, and until it holds gas it cannot send a transaction or fire a protective stop.
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
            Back to the dashboard
          </Link>
        </div>
      )}
    </section>
  );
}
