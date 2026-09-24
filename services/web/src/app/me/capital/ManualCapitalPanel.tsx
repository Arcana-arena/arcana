'use client';

/**
 * Supply, borrow, repay or withdraw by hand.
 *
 * THE OWNER PICKS THE AMOUNT, NOT THE LIMITS. The engine applies the same rule
 * the mandate runs under — the health-factor floor (the mandate's, or 1.5
 * without one), the platform's caps, a trusted oracle, the market's liquidity —
 * and the signer applies its own caps again. A refusal comes back with the
 * rule that refused it and nothing is signed.
 *
 * WHAT A PERSON SEES BEFORE PRESSING: the unit of the amount (NVDA for supply,
 * USDG otherwise), the headroom the floor leaves, and that two transactions may
 * be signed. After: the outcome and its transaction, as the engine reported it.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { capitalManual, type ManualOutcome } from './actions';

type Fail = { ok: false; status: number | null; reason: string; code: string | null };

export function ManualCapitalPanel({
  agentId,
  collateralSymbol,
  debt,
  walletUSDG,
  borrowHeadroom,
  withdrawMax,
  mandateActive,
}: {
  agentId: string;
  collateralSymbol: string;
  debt: number;
  walletUSDG: number | null;
  /** USDG that keeps the worst-case health factor at the floor; null when unknown. */
  borrowHeadroom: number | null;
  /** Collateral that can come back without leaving the debt under the floor; null when unknown. */
  withdrawMax: number | null;
  mandateActive: boolean;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<'supply' | 'borrow' | 'repay' | 'withdraw'>('borrow');
  const [amount, setAmount] = useState('');
  const [out, setOut] = useState<ManualOutcome | null>(null);
  const [fail, setFail] = useState<Fail | null>(null);
  const [pending, start] = useTransition();

  const unit = kind === 'supply' || kind === 'withdraw' ? collateralSymbol : 'USDG';
  const submit = () => {
    setOut(null);
    setFail(null);
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setFail({ ok: false, status: null, reason: 'Enter an amount above zero.', code: 'amount_not_positive' });
      return;
    }
    start(async () => {
      const r = await capitalManual(agentId, kind, n);
      if (r.ok) {
        setOut(r.data);
        router.refresh();
      } else setFail(r);
    });
  };

  // USDG is filled to 6 decimals, rounded down. Collateral is filled at full
  // precision: rounding it down would leave dust posted, and the engine clamps
  // a withdrawal to what is posted on chain, so full precision cannot overshoot.
  const fill = (v: number | null, exact = false) =>
    v !== null && v > 0 ? () => setAmount(exact ? String(v) : String(Math.floor(v * 1e6) / 1e6)) : undefined;

  return (
    <div className="box" style={{ marginTop: 12 }}>
      <span className="k">By hand</span>

      {mandateActive ? (
        <div className="callout callout-warn" style={{ marginTop: 8, fontSize: 12 }}>
          A mandate is active on this agent. It keeps running after a manual action and may undo it on its next
          cycle — a manual borrow can be repaid as excess cash, a manual repay borrowed back under the trigger.
          Stop the mandate first if you want the position to stay where you put it.
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        {(['supply', 'borrow', 'repay', 'withdraw'] as const).map((k) => (
          <button key={k} className={kind === k ? 'btn btn-primary' : 'btn'} onClick={() => setKind(k)} disabled={pending}>
            {k === 'supply' ? `Post ${collateralSymbol}` : k === 'borrow' ? 'Borrow USDG' : k === 'repay' ? 'Repay USDG' : `Withdraw ${collateralSymbol}`}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="input" type="number" step="any" min={0} placeholder={`amount in ${unit}`}
          value={amount} onChange={(e) => setAmount(e.target.value)} disabled={pending} style={{ maxWidth: 220 }} />
        <span className="mono m3" style={{ fontSize: 11 }}>{unit}</span>
        {kind === 'borrow' && borrowHeadroom !== null ? (
          <button className="btn btn-ghost" onClick={fill(borrowHeadroom)} disabled={pending || borrowHeadroom <= 0}>
            up to the floor: {borrowHeadroom.toFixed(4)}
          </button>
        ) : null}
        {kind === 'repay' ? (
          <button className="btn btn-ghost" onClick={fill(walletUSDG === null ? debt : Math.min(debt, walletUSDG))}
            disabled={pending || debt <= 0}>
            all of the debt: {debt.toFixed(6)}
          </button>
        ) : null}
        {kind === 'withdraw' && withdrawMax !== null ? (
          <button className="btn btn-ghost" onClick={fill(withdrawMax, true)} disabled={pending || withdrawMax <= 0}>
            all that is safe: {withdrawMax.toFixed(6)}
          </button>
        ) : null}
        <button className="btn btn-primary" onClick={submit} disabled={pending || amount === ''}>
          {pending ? 'Signing and waiting for the chain…' : 'Send'}
        </button>
      </div>

      <p className="m3" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
        {kind === 'supply'
          ? `Moves ${collateralSymbol} from the agent's wallet into the market as collateral. Posting is not a sale.`
          : kind === 'borrow'
            ? 'Borrows USDG into the agent’s own wallet — there is no other destination. Refused if it would put the worst-case health factor under the floor, or over the platform’s caps.'
            : kind === 'repay'
              ? 'Repays USDG from the agent’s wallet. Repaying is never capped; the whole debt is repaid by shares, so nothing is left behind.'
              : `Takes ${collateralSymbol} back from the market into the agent’s own wallet. With debt outstanding, only what keeps the health factor above the floor; with none, all of it.`}{' '}
        {kind === 'withdraw' || kind === 'borrow' ? 'One transaction is signed' : 'Up to two transactions are signed (an approval, then the action)'}, paid from the agent&rsquo;s gas.
        {walletUSDG !== null ? ` The wallet holds ${walletUSDG.toFixed(6)} USDG.` : ''}
      </p>

      {out ? (
        <div className={`callout ${out.status === 'mined' ? '' : 'callout-bad'}`} style={{ marginTop: 10 }}>
          <strong>
            {out.kind} {out.amount} — {out.status}
          </strong>
          {out.refusal_code ? <div className="mono" style={{ fontSize: 11.5 }}>{out.refusal_code}</div> : null}
          {out.refusal_detail ? <div style={{ fontSize: 12 }}>{out.refusal_detail}</div> : null}
          {out.approve_tx_hash ? (
            <div className="mono" style={{ fontSize: 11 }}>
              approval {out.approve_tx_hash}
            </div>
          ) : null}
          {out.tx_hash ? (
            <div className="mono" style={{ fontSize: 11 }}>
              transaction {out.tx_hash}
            </div>
          ) : null}
        </div>
      ) : null}
      {fail ? (
        <div className="callout callout-bad" style={{ marginTop: 10 }}>
          <strong>{fail.code ?? `The service answered ${fail.status ?? 'nothing'}`}</strong>
          <div style={{ marginTop: 4 }}>{fail.reason}</div>
        </div>
      ) : null}
    </div>
  );
}
