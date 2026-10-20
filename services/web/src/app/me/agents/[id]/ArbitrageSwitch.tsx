'use client';

/**
 * The creator's arbitrage switch for one agent.
 *
 * THE DEFAULT IS OFF AND THE PANEL SAYS SO IN THOSE WORDS. "Not enabled yet" is
 * a different sentence from "disabled", and the state line distinguishes them
 * (an agent that has never been switched on has no setting row at all).
 *
 * WHAT THE BUTTON DOES NOT PRETEND. Switching off does not close anything and
 * does not stop fees being collected — the wind-down rule keeps harvesting and
 * closing, and only new exposure (opening, rebalancing) stops. The panel states
 * that before the click, so nobody disables an agent expecting its position to
 * be liquidated.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { utc } from '@/lib/format';
import { saveArbitrage, type ArbitrageSettingView } from './actions';

type Fail = { ok: false; status: number | null; reason: string; code: string | null };

export function ArbitrageSwitch({
  agentId,
  initial,
  agentStatus,
}: {
  agentId: string;
  initial: ArbitrageSettingView;
  agentStatus: string;
}) {
  const [setting, setSetting] = useState(initial);
  const [fail, setFail] = useState<Fail | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  const flip = () => {
    setFail(null);
    start(async () => {
      const r = await saveArbitrage(agentId, !setting.enabled);
      if (r.ok) {
        setSetting(r.data);
        router.refresh();
      } else {
        setFail(r);
      }
    });
  };

  const retired = agentStatus === 'retired';

  return (
    <section className="box">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="k">Arbitrage · this agent</span>
        <span className="mono" style={{ fontSize: 11 }}>
          {setting.enabled ? (
            <span className="up">ENABLED</span>
          ) : setting.exists ? (
            <span className="m3">DISABLED</span>
          ) : (
            <span className="m3">NOT ENABLED</span>
          )}
          {setting.enabled && setting.enabled_at ? (
            <span className="m3"> · since {utc(setting.enabled_at).slice(0, 10)}</span>
          ) : null}
        </span>
      </div>

      <div className="m2" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
        {setting.enabled ? (
          <>
            This agent may hold liquidity positions. The executor opens a position only through the capped open command
            (you fund the wallet and type the ceiling), then harvests accrued fees once they cross the reviewed
            threshold, rebalances a range the price has left, and closes positions that have been emptied.
          </>
        ) : (
          <>
            Off means no <strong>new</strong> exposure: nothing is opened, and a range the price has left is not
            rebalanced (a rebalance mints a new position). Fees already accrued are still collected and an emptied
            position is still closed — switching this off cannot strand funds in a pool.
          </>
        )}
      </div>

      <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          className={setting.enabled ? 'btn' : 'btn btn-primary'}
          onClick={flip}
          disabled={pending || (retired && !setting.enabled)}
        >
          {pending
            ? 'Saving…'
            : setting.enabled
              ? 'Switch arbitrage off'
              : retired
                ? 'A retired agent cannot be enabled'
                : 'Switch arbitrage on'}
        </button>
        {setting.updated_by ? (
          <span className="mono m3" style={{ fontSize: 10.5 }} title={setting.updated_by}>
            last changed by {setting.updated_by.slice(0, 6)}…{setting.updated_by.slice(-4)}
            {setting.updated_at ? ` · ${utc(setting.updated_at)}` : ''}
          </span>
        ) : null}
      </div>

      {fail ? (
        <div className="callout callout-bad" style={{ marginTop: 12 }}>
          <strong>{fail.code ?? `The service answered ${fail.status ?? 'nothing'}`}</strong>
          <div style={{ marginTop: 4 }}>{fail.reason}</div>
        </div>
      ) : null}
    </section>
  );
}
