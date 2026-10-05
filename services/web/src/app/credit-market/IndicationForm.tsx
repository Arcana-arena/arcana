'use client';

/**
 * Say what you would supply to this agent, change it, or take it back.
 *
 * WHAT A PERSON SEES BEFORE PRESSING: the unit (USDG), that the rate is
 * optional and yearly, and — on the button itself — that this records interest
 * and sends nothing. After: what stands, as the service stored it, or the rule
 * that refused it.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { indicate, withdrawIndication } from './actions';

type Fail = { ok: false; status: number | null; reason: string; code: string | null };

export function IndicationForm({
  agentId,
  standing,
  minUsdg,
  maxUsdg,
}: {
  agentId: string;
  /** This wallet's standing indication for the agent, if it has one. */
  standing: { amount_usdg: number; rate_bps: number | null } | null;
  minUsdg: number;
  maxUsdg: number;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState(standing ? String(standing.amount_usdg) : '');
  const [rate, setRate] = useState(standing?.rate_bps ? String(standing.rate_bps / 100) : '');
  const [fail, setFail] = useState<Fail | null>(null);
  const [pending, start] = useTransition();

  const local = (reason: string, code: string): Fail => ({ ok: false, status: null, reason, code });

  const submit = () => {
    setFail(null);
    const n = Number(amount);
    if (!Number.isFinite(n) || n < minUsdg || n > maxUsdg) {
      setFail(local(`Enter an amount between ${minUsdg} and ${maxUsdg.toLocaleString('en-US')} USDG.`, 'amount_out_of_range'));
      return;
    }
    let bps: number | null = null;
    if (rate.trim() !== '') {
      const pct = Number(rate);
      bps = Math.round(pct * 100);
      if (!Number.isFinite(pct) || bps < 1 || bps > 10000) {
        setFail(local('The rate is a percentage a year, between 0.01 and 100, or left empty.', 'rate_out_of_range'));
        return;
      }
    }
    start(async () => {
      const r = await indicate(agentId, n, bps);
      if (r.ok) router.refresh();
      else setFail(r);
    });
  };

  const withdraw = () => {
    setFail(null);
    start(async () => {
      const r = await withdrawIndication(agentId);
      if (r.ok) {
        setAmount('');
        setRate('');
        router.refresh();
      } else setFail(r);
    });
  };

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="input" type="number" step="any" min={minUsdg} max={maxUsdg} placeholder="amount"
          aria-label="Amount in USDG" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={pending}
          style={{ width: 130 }} />
        <span className="mono m3" style={{ fontSize: 11 }}>USDG</span>
        <input className="input" type="number" step="any" min={0.01} max={100} placeholder="rate, optional"
          aria-label="Yearly rate in percent, optional" value={rate} onChange={(e) => setRate(e.target.value)}
          disabled={pending} style={{ width: 130 }} />
        <span className="mono m3" style={{ fontSize: 11 }}>% a year</span>
        <button className="btn btn-primary" onClick={submit} disabled={pending || amount === ''}>
          {pending ? 'Recording…' : standing ? 'Change indication' : 'Record indication'}
        </button>
        {standing ? (
          <button className="btn btn-ghost" onClick={withdraw} disabled={pending}>
            Withdraw
          </button>
        ) : null}
      </div>
      <p className="m3" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
        Records what you would supply. Nothing is signed, sent or reserved, and you can change or withdraw it at any
        time.
      </p>
      {fail ? (
        <div className="callout callout-bad" style={{ marginTop: 8 }}>
          <strong>{fail.code ?? `The service answered ${fail.status ?? 'nothing'}`}</strong>
          <div style={{ marginTop: 4 }}>{fail.reason}</div>
        </div>
      ) : null}
    </div>
  );
}
