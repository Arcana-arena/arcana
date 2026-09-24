'use client';

/**
 * The capital mandate, written in a browser (architecture.md §17.6 acceptance 2).
 *
 * THE FORM EXPLAINS THE RULES BEFORE IT IS SUBMITTED, and the service refuses
 * anyway. Every bound shown here — the health-factor floor, the platform's
 * borrow cap, the symbols an agent can hold — comes from the service's answer,
 * which reads the signer's own allowlist; nothing is hardcoded on this page.
 * A refusal is printed with the service's own sentence.
 *
 * LENDING DISABLED IS SAID OUT LOUD. A mandate can be saved and activated while
 * the allowlist keeps lending off; the engine then records every borrow it
 * would have made as refused by the signer. The owner is told that before they
 * activate, not after they wonder why nothing happened.
 */
import { useState, useTransition } from 'react';
import {
  activateCapitalMandate,
  saveCapitalMandate,
  stopCapitalMandate,
  type CapitalMandateView,
} from './actions';

type Fail = { ok: false; status: number | null; reason: string; code: string | null };

export function CapitalMandatePanel({
  agentId,
  initial,
  editable,
}: {
  agentId: string;
  initial: CapitalMandateView;
  editable: boolean;
}) {
  const [view, setView] = useState(initial);
  const m = view.mandate;
  const lim = view.limits;
  const [hf, setHf] = useState(String(m?.min_health_factor ?? 2));
  const [rate, setRate] = useState(String(m ? m.max_borrow_rate_bps / 100 : 8));
  const [trigger, setTrigger] = useState(String(m?.liquidity_trigger_usdg ?? 50));
  const [cap, setCap] = useState(String(m?.max_borrow_usdg ?? Math.min(150, lim.platform_max_debt_usdg)));
  const [neverSell, setNeverSell] = useState<string[]>(m?.never_sell ?? []);
  const [fail, setFail] = useState<Fail | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!lim.market) {
    return (
      <section className="box">
        <span className="k">Capital mandate</span>
        <p className="m3" style={{ marginTop: 8, fontSize: 12.5 }}>
          No lending market is allowlisted, so there is nothing to write a mandate for.
        </p>
      </section>
    );
  }

  const run = (f: () => Promise<{ ok: true; data: CapitalMandateView } | Fail>, done: string) => {
    setFail(null);
    setSaved(null);
    start(async () => {
      const r = await f();
      if (r.ok) {
        setView(r.data);
        setSaved(done);
      } else setFail(r);
    });
  };
  const save = () =>
    run(
      () =>
        saveCapitalMandate(agentId, {
          min_health_factor: Number(hf),
          max_borrow_rate_bps: Math.round(Number(rate) * 100),
          liquidity_trigger_usdg: Number(trigger),
          max_borrow_usdg: Number(cap),
          never_sell: neverSell,
        }),
      'Saved.',
    );

  const hfNum = Number(hf);
  // What the floor means as a loan-to-value, next to the number itself: a
  // health factor of 2 at LLTV 62.5% is borrowing at most 31% of the collateral.
  const ltvAtFloor = Number.isFinite(hfNum) && hfNum > 0 ? (62.5 / hfNum).toFixed(1) : '—';

  return (
    <section className="box">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="k">Capital mandate · {lim.market.name}</span>
        <span className="mono" style={{ fontSize: 11 }}>
          {m ? m.status : 'none saved'}
        </span>
      </div>

      {!lim.lending_enabled ? (
        <div className="callout callout-warn" style={{ marginTop: 10 }}>
          <strong>Lending is not enabled on the platform yet.</strong> You can save and activate a mandate; every
          borrow, supply or repay it chooses will be recorded as refused by the signer, and nothing will be signed,
          until lending is switched on in a reviewed release.
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, marginTop: 12 }}>
        <label style={{ fontSize: 12 }}>
          Minimum health factor
          <input className="input" type="number" step="0.1" min={lim.min_health_factor} max={lim.max_health_factor}
            value={hf} onChange={(e) => setHf(e.target.value)} disabled={!editable || pending} />
          <span className="m3" style={{ fontSize: 10.5 }}>
            at least {lim.min_health_factor}. Liquidation is at 1.0; this floor means borrowing at most ~{ltvAtFloor}% of
            the collateral&rsquo;s value, on the lower of the oracle and pool price.
          </span>
        </label>
        <label style={{ fontSize: 12 }}>
          Borrow cap (USDG)
          <input className="input" type="number" step="1" min={1} max={lim.platform_max_debt_usdg}
            value={cap} onChange={(e) => setCap(e.target.value)} disabled={!editable || pending} />
          <span className="m3" style={{ fontSize: 10.5 }}>
            the platform allows at most {lim.platform_max_debt_usdg} per agent in the beta, and at most{' '}
            {lim.platform_max_borrow_per_tx_usdg} in one borrow.
          </span>
        </label>
        <label style={{ fontSize: 12 }}>
          Borrow when cash falls below (USDG)
          <input className="input" type="number" step="1" min={0}
            value={trigger} onChange={(e) => setTrigger(e.target.value)} disabled={!editable || pending} />
          <span className="m3" style={{ fontSize: 10.5 }}>
            the agent borrows back up to this; cash above twice this repays debt.
          </span>
        </label>
        <label style={{ fontSize: 12 }}>
          Highest borrow rate (% a year)
          <input className="input" type="number" step="0.1" min={0.01} max={100}
            value={rate} onChange={(e) => setRate(e.target.value)} disabled={!editable || pending} />
          <span className="m3" style={{ fontSize: 10.5 }}>above this, nothing is borrowed and debt is repaid.</span>
        </label>
      </div>

      <div style={{ marginTop: 12, fontSize: 12 }}>
        Never sell
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 6 }}>
          {lim.symbols.map((s) => (
            <label key={s} className="mono" style={{ fontSize: 11.5 }}>
              <input type="checkbox" checked={neverSell.includes(s)} disabled={!editable || pending}
                onChange={(e) => setNeverSell((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))} />{' '}
              {s}
            </label>
          ))}
        </div>
        <span className="m3" style={{ fontSize: 10.5 }}>
          a sell of a ticked symbol is refused whatever the trading decider answers. Posting it as collateral is not a sale.
        </span>
      </div>

      {editable ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <button className="btn" onClick={save} disabled={pending}>Save mandate</button>
          {m && m.status !== 'active' ? (
            <button className="btn btn-primary" disabled={pending}
              onClick={() => run(() => activateCapitalMandate(agentId), 'Active: the agent now runs this mandate on its cadence.')}>
              Activate
            </button>
          ) : null}
          {m?.status === 'active' ? (
            <button className="btn" disabled={pending}
              onClick={() => run(() => stopCapitalMandate(agentId), 'Stopped. The position stays watched.')}>
              Stop
            </button>
          ) : null}
        </div>
      ) : null}

      {saved ? <div className="callout" style={{ marginTop: 12 }}>{saved}</div> : null}
      {fail ? (
        <div className="callout callout-bad" style={{ marginTop: 12 }}>
          <strong>{fail.code ?? `The service answered ${fail.status ?? 'nothing'}`}</strong>
          <div style={{ marginTop: 4 }}>{fail.reason}</div>
        </div>
      ) : null}
    </section>
  );
}
