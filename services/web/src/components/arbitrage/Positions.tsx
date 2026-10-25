/**
 * The two objects this surface exists to show, in one place.
 *
 * RANGE, NOT TICKS. A concentrated-liquidity position is a price interval, and
 * the question a reader brings is where the current price sits inside it. Two
 * tick integers cannot answer that without arithmetic nobody performs in their
 * head, so the range is drawn: bounds at the ends, the current tick marked
 * between them, and a sentence saying which side of the edge it is on.
 *
 * SCROLLING THAT A KEYBOARD CAN REACH. Every wide table here sits in a region
 * that takes focus and says what it contains. Without it the columns that
 * matter most — verdict, freshness — are pointer-only on a laptop.
 *
 * Nothing is computed beyond placement. Verdicts, amounts and statuses are the
 * service's own words.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ago, int, num, txShort, tone, usd, utc } from '@/lib/format';
import { Tag } from '@/components/ds/primitives';
import {
  REC_TONE,
  shortId,
  stepTone,
  units,
  type LPPosition,
  type LPPnLPosition,
  type LPVenueToken,
} from '@/lib/lp';

export function ScrollRegion({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="lp-scroll">
      {hint ? (
        <div className="lp-scroll-hint" aria-hidden="true">
          {hint}
        </div>
      ) : null}
      <div className="scroll-x" role="region" aria-label={label} tabIndex={0}>
        {children}
      </div>
    </div>
  );
}

export function RangeRail({
  lower,
  upper,
  current,
  inRange,
}: {
  lower: number;
  upper: number;
  current: number | null;
  inRange: boolean | null;
}) {
  if (current === null) {
    return (
      <div className="lp-range">
        <div
          className="lp-rail lp-rail-unknown"
          role="img"
          aria-label="The current price has not been read, so the position's place in its range is unknown"
          title={`ticks ${lower} … ${upper}, current price not read`}
        />
        <span className="lp-rail-cap">price not read</span>
      </div>
    );
  }

  const span = Math.max(1, upper - lower);
  const ratio = Math.min(1, Math.max(0, (current - lower) / span));
  const pct = Math.round(ratio * 100);
  const side = current < lower ? 'below' : current > upper ? 'above' : 'inside';
  const caption = side === 'inside' ? `${pct}% into the range` : `${side} the range`;
  const label =
    side === 'inside'
      ? `Current price sits ${pct}% of the way from the lower bound to the upper bound, inside the range`
      : `Current price is ${side} the range`;

  return (
    <div className="lp-range">
      <div
        className={`lp-rail ${side === 'inside' ? '' : 'lp-rail-out'}`}
        role="img"
        aria-label={label}
        title={`ticks ${lower} … ${upper}, current ${current}`}
      >
        <span className="lp-rail-mark" style={{ left: `${pct}%` }} />
      </div>
      <span className="lp-rail-cap">{caption}</span>
    </div>
  );
}

function AgentCell({ id }: { id: string }) {
  return (
    <Link href={`/agents/${id}`} className="mono" style={{ fontSize: 12 }} title={id}>
      {shortId(id)}
    </Link>
  );
}

export function PositionsTable({
  positions,
  token,
  showAgent = false,
  dense = false,
}: {
  positions: LPPosition[];
  token: (address: string) => LPVenueToken;
  showAgent?: boolean;
  dense?: boolean;
}) {
  return (
    <ScrollRegion label="LP positions" hint="Scroll the table sideways for verdict and sync time.">
      <table className={`table ${dense ? 'table-dense' : ''}`} style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th style={{ width: 165 }}>Pair</th>
            {showAgent ? <th style={{ width: 92 }}>Agent</th> : null}
            <th style={{ width: 232 }}>Where the price sits</th>
            <th style={{ width: 78 }}>In range</th>
            <th className="r" style={{ width: 150 }}>
              Holds
            </th>
            <th className="r" style={{ width: 190 }}>
              <span title="tokensOwed stored at the last position touch, a lower bound on the accrual. The position endpoint reports the exact number for one NFT at a time.">
                Stored fees
              </span>
            </th>
            <th style={{ width: 92 }}>Verdict</th>
            <th style={{ width: 118 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const t0 = token(p.token0);
            const t1 = token(p.token1);
            const a0 = units(p.amount0, t0.decimals);
            const a1 = units(p.amount1, t1.decimals);
            const f0 = units(p.tokens_owed0, t0.decimals);
            const f1 = units(p.tokens_owed1, t1.decimals);
            const archived = p.status !== 'open';
            return (
              <tr key={`${p.position_manager}-${p.token_id}`} style={archived ? { color: 'var(--ink-2)' } : undefined}>
                <td>
                  <span className="mono">
                    {t0.symbol} / {t1.symbol}
                  </span>
                  <div className="m2" style={{ fontSize: 11.5, marginTop: 2 }}>
                    #{p.token_id} · {(p.fee_tier / 10000).toFixed(2)}%
                  </div>
                </td>
                {showAgent ? (
                  <td>
                    <AgentCell id={p.agent_id} />
                  </td>
                ) : null}
                <td>
                  <RangeRail
                    lower={p.tick_lower}
                    upper={p.tick_upper}
                    current={p.current_tick}
                    inRange={p.in_range}
                  />
                  <div className="m2 mono" style={{ fontSize: 11, marginTop: 2 }} title="lower and upper tick bounds">
                    {int(p.tick_lower)} … {int(p.tick_upper)}
                  </div>
                </td>
                <td>
                  {p.in_range === null ? (
                    <span className="m2">not read</span>
                  ) : p.in_range ? (
                    <Tag tone="accent">IN</Tag>
                  ) : (
                    <Tag tone="amber">OUT</Tag>
                  )}
                </td>
                <td className="mono r">
                  {a0 === null && a1 === null ? (
                    <span className="m2">not read</span>
                  ) : (
                    <>
                      {num(a0, 4)} {t0.symbol}
                      <br />
                      {num(a1, 4)} {t1.symbol}
                    </>
                  )}
                </td>
                <td className="mono r">
                  {f0 === null && f1 === null ? (
                    <span className="m2">not read</span>
                  ) : (
                    <>
                      {num(f0, 4)} {t0.symbol}
                      <br />
                      {num(f1, 4)} {t1.symbol}
                    </>
                  )}
                </td>
                <td>
                  {p.recommendation ? (
                    <Tag tone={REC_TONE[p.recommendation] ?? 'neutral'}>{p.recommendation}</Tag>
                  ) : (
                    <span className="m2">—</span>
                  )}
                </td>
                <td>
                  <Tag tone={p.status === 'open' ? 'neutral' : 'outline'}>{p.status}</Tag>
                  <div className="m2 mono" style={{ fontSize: 11, marginTop: 2 }} title={p.last_synced_at ?? undefined}>
                    {p.last_synced_at ? `synced ${ago(p.last_synced_at)}` : 'never synced'}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

export type ActivityRow = {
  key: string;
  ts: string | null;
  kind: string;
  agentId: string;
  position: string | null;
  detail: string;
  /** A second line, shown small under the detail: an error, a size, a symbol. */
  note?: string;
  status: string;
  statusClass: string;
  tx?: string;
};

/**
 * What the position has actually earned: collected fees minus gas, per row.
 *
 * The sign is printed, not only coloured, and a null means the service could
 * not establish the number — it is not a zero. Fees still accruing inside the
 * position are absent here on purpose; the accretion is in the position table
 * above and the sentence under this one says so.
 */
export function RealisedTable({ rows }: { rows: LPPnLPosition[] }) {
  return (
    <ScrollRegion label="Realised profit and loss" hint="Scroll the table sideways for net and harvests.">
      <table className="table" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th style={{ width: 160 }}>Pair</th>
            <th className="r" style={{ width: 190 }}>Collected</th>
            <th className="r" style={{ width: 180 }}>Gas</th>
            <th className="r" style={{ width: 130 }}>Net</th>
            <th style={{ width: 170 }}>Harvests</th>
            <th style={{ width: 100 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const last = p.harvests.length > 0 ? p.harvests[p.harvests.length - 1] : null;
            return (
              <tr key={`${p.position_manager}-${p.token_id}`}>
                <td>
                  <span className="mono">
                    {p.token0.symbol} / {p.token1.symbol}
                  </span>
                  <div className="m2" style={{ fontSize: 11.5, marginTop: 2 }}>
                    #{p.token_id}
                  </div>
                </td>
                <td className="mono r">
                  {num(p.token0.human, 8)} {p.token0.symbol}
                  <br />
                  {num(p.token1.human, 8)} {p.token1.symbol}
                </td>
                <td className="mono r">
                  {usd(p.gas.value_usdg, 4)}
                  <div className="m2" style={{ fontSize: 11.5, marginTop: 2 }}>
                    {p.gas.txs} tx{p.gas.reverted > 0 ? `, ${p.gas.reverted} reverted` : ''} · {num(p.gas.gas_eth, 8)} ETH
                  </div>
                </td>
                <td className={`mono r ${tone(p.net_usdg)}`} title="collected fees minus gas, both valued at their current prices">
                  {usd(p.net_usdg, 4)}
                </td>
                <td className="mono">
                  {last ? (
                    <span title={last.tx_hash}>
                      {p.harvests.length} collect{p.harvests.length === 1 ? '' : 's'} · {txShort(last.tx_hash)}
                    </span>
                  ) : (
                    <span className="m2">none</span>
                  )}
                </td>
                <td>
                  <Tag tone={p.status === 'open' ? 'neutral' : 'outline'}>{p.status}</Tag>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

export function ActivityTable({ rows, label }: { rows: ActivityRow[]; label: string }) {
  return (
    <ScrollRegion label={label} hint="Scroll the table sideways for status and transaction.">
      <table className="table" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th style={{ width: 132 }}>When</th>
            <th style={{ width: 96 }}>Kind</th>
            <th style={{ width: 100 }}>Agent</th>
            <th style={{ width: 92 }}>Position</th>
            <th>Detail</th>
            <th style={{ width: 112 }}>Status</th>
            <th style={{ width: 108 }}>Tx</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="mono m2" style={{ whiteSpace: 'nowrap' }} title={r.ts ?? undefined}>
                {r.ts ? utc(r.ts).slice(0, 16) : '—'}
              </td>
              <td className="mono" style={{ fontSize: 11, letterSpacing: '.06em' }}>
                {r.kind}
              </td>
              <td>
                <AgentCell id={r.agentId} />
              </td>
              <td className="mono">{r.position ?? '—'}</td>
              <td className="mono" style={{ fontSize: 12 }}>
                {r.detail}
                {r.note ? (
                  <div className="m2" style={{ fontSize: 11.5, marginTop: 2 }}>
                    {r.note}
                  </div>
                ) : null}
              </td>
              <td className={r.statusClass} style={{ fontSize: 12 }}>
                {r.status}
              </td>
              <td className="mono m2" style={{ fontSize: 12 }}>
                {r.tx ? <span title={r.tx}>{txShort(r.tx)}</span> : <span className="m2">not sent</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
