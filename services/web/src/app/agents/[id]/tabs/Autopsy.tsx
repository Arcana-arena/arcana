/**
 * Autopsy — what the record supports, and an explicit list of what it does not.
 *
 * THE `not_analysed` LIST IS THE MOST VALUABLE THING ON THIS TAB AND IT IS
 * RENDERED IN FULL. Every section the autopsy declined to analyse comes back
 * with the reason it declined, and those reasons are printed word for word. A
 * report that quietly omits the analyses it could not do reads as a complete
 * report; the omissions are the part a reader most needs.
 *
 * The same applies inside the report: `decision_timing.analysed: false` with
 * "only 3 trades; 5 are needed" is not an empty section to hide, it is a
 * finding about how much can be said.
 *
 * PROTECTIVE EXITS ARE EXCLUDED FROM THE TRADE COUNTS AND THE AUTOPSY SAYS SO
 * IN `excluded_from`. That list is printed, because the difference between
 * "3 trades" and "3 trades plus 2 exits a level took" is the difference between
 * measuring an agent and measuring a safety net.
 */
import { agent } from '@/lib/api';
import { int, money, num, pct, utc } from '@/lib/format';
import { ActionTag, Key, Lbl, Num, Tag } from '@/components/ds/primitives';
import { Callout, Empty, Failed } from '@/components/ds/states';
import type { Autopsy } from '../shapes';

export async function AutopsyTab({ id }: { id: string }) {
  const r = await agent<Autopsy>(`/v1/agents/${id}/autopsy`);
  if (!r.ok) return <Failed what="The autopsy" error={r} />;
  const a = r.data;

  if (!a.analysed) {
    return (
      <Empty title="This agent has not been analysed">
        {a.reason ?? 'The autopsy declined to run and gave no reason, which is itself worth reporting.'}
      </Empty>
    );
  }

  const s = a.summary;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 26 }}>
      <section>
        <Key>Window analysed</Key>
        <div className="stat-grid" style={{ marginTop: 10, border: '1px solid var(--color-divider)' }}>
          <div className="stat-cell">
            <Lbl>TICKS</Lbl>
            <div className="stat-value">
              <Num value={int(s?.ticks)} />
            </div>
          </div>
          <div className="stat-cell">
            <Lbl>DECISIONS</Lbl>
            <div className="stat-value">
              <Num value={int(s?.decisions)} />
            </div>
          </div>
          <div className="stat-cell">
            <Lbl>TRADES · THE AGENT&rsquo;S</Lbl>
            <div className="stat-value">
              <Num value={int(s?.trades)} />
            </div>
            <div className="stat-sub">protective exits are not counted here</div>
          </div>
          <div className="stat-cell">
            <Lbl>INCLUDING PROTECTIVE</Lbl>
            <div className="stat-value">
              <Num value={int(s?.trades_including_protective)} />
            </div>
            <div className="stat-sub">
              <Num value={int(s?.protective_exits)} /> taken by a level
            </div>
          </div>
          <div className="stat-cell">
            <Lbl>NAV · FIRST</Lbl>
            <div className="stat-value" style={{ fontSize: 20 }}>
              <Num value={money(s?.first_nav)} />
            </div>
          </div>
          <div className="stat-cell">
            <Lbl>NAV · LAST</Lbl>
            <div className="stat-value" style={{ fontSize: 20 }}>
              <Num value={money(s?.last_nav)} />
            </div>
          </div>
          <div className="stat-cell">
            <Lbl>RETURN</Lbl>
            <div className="stat-value" style={{ fontSize: 20 }}>
              <Num value={pct(s?.return_pct, 4)} tone={(s?.return_pct ?? 0) > 0 ? 'up' : (s?.return_pct ?? 0) < 0 ? 'dn' : 'flat'} />
            </div>
          </div>
          <div className="stat-cell">
            <Lbl>PERIOD</Lbl>
            <div className="mono" style={{ fontSize: 12, marginTop: 4 }}>
              {utc(s?.first_tick)}
              <br />
              {utc(s?.last_tick)}
            </div>
          </div>
        </div>
      </section>

      {a.protective_exits ? (
        <section>
          <Key>Protective exits</Key>
          <div style={{ marginTop: 8 }}>
            <Callout tone={a.protective_exits.count ? 'warn' : 'note'}>
              {a.protective_exits.note ?? 'No note.'}
              {a.protective_exits.excluded_from?.length ? (
                <div className="mono m3" style={{ fontSize: 10.5, marginTop: 6 }}>
                  excluded from: {a.protective_exits.excluded_from.join(', ')}
                </div>
              ) : null}
            </Callout>
          </div>
        </section>
      ) : null}

      {a.allocation ? (
        <section>
          <Key>Where the P&amp;L came from</Key>
          <div className="scroll-x">
            <table className="table" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th style={{ width: 120 }}>Symbol</th>
                  <th className="r" style={{ width: 140 }}>
                    P&amp;L
                  </th>
                  <th className="r" style={{ width: 180 }}>
                    % of starting NAV
                  </th>
                  <th>How it was obtained</th>
                </tr>
              </thead>
              <tbody>
                {(a.allocation.by_symbol ?? []).map((row) => (
                  <tr key={row.symbol}>
                    <td className="mono">{row.symbol}</td>
                    <td className="r">
                      <Num
                        value={money(row.pnl)}
                        tone={(row.pnl ?? 0) > 0 ? 'up' : (row.pnl ?? 0) < 0 ? 'dn' : 'flat'}
                      />
                    </td>
                    <td className="r">
                      <Num value={num(row.pct_of_starting_nav, 4)} />
                    </td>
                    <td className="m2" style={{ fontSize: 11.5 }}>
                      exact, from held quantity × price change
                    </td>
                  </tr>
                ))}
                {a.allocation.cash ? (
                  <tr>
                    <td className="mono m2">cash drag</td>
                    <td className="r m3">—</td>
                    <td className="r">
                      <Num value={num(a.allocation.cash.pct_of_starting_nav, 4)} />
                    </td>
                    <td className="m2" style={{ fontSize: 11.5 }} title={a.allocation.cash.sign ?? undefined}>
                      {a.allocation.cash.method ?? 'method not stated'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {a.allocation.evidence?.note ? (
            <div style={{ marginTop: 10 }}>
              <Callout tone="note">
                {a.allocation.evidence.note}
                {typeof a.allocation.evidence.ticks_paired === 'number' ? (
                  <>
                    {' '}
                    <span className="mono">{int(a.allocation.evidence.ticks_paired)}</span> ticks could be paired.
                  </>
                ) : null}
              </Callout>
            </div>
          ) : null}
        </section>
      ) : null}

      <section>
        <Key>Risk</Key>
        {!a.risk ? (
          <div className="m3" style={{ fontSize: 12, marginTop: 6 }}>
            the report carried no risk block
          </div>
        ) : !a.risk.analysed ? (
          <div style={{ marginTop: 8 }}>
            <Callout tone="note">
              <strong>Not analysed.</strong> {a.risk.reason ?? 'No reason was given.'}
            </Callout>
          </div>
        ) : (
          <>
            <div className="stat-grid" style={{ marginTop: 10, border: '1px solid var(--color-divider)' }}>
              <div className="stat-cell">
                <Lbl>MAX DRAWDOWN</Lbl>
                <div className="stat-value" style={{ fontSize: 20 }}>
                  <Num value={num(a.risk.max_drawdown_pct, 4)} tone="dn" />
                  <span className="m3" style={{ fontSize: 13 }}>
                    {' '}
                    %
                  </span>
                </div>
              </div>
              <div className="stat-cell">
                <Lbl>PEAK → TROUGH</Lbl>
                <div className="mono" style={{ fontSize: 12, marginTop: 4 }}>
                  {money(a.risk.peak?.nav)} → {money(a.risk.trough?.nav)}
                </div>
                <div className="stat-sub">
                  {utc(a.risk.peak?.ts)} → {utc(a.risk.trough?.ts)}
                </div>
              </div>
              <div className="stat-cell">
                <Lbl>DURATION</Lbl>
                <div className="stat-value" style={{ fontSize: 20 }}>
                  <Num value={int(a.risk.duration_ticks)} /> <span className="m3" style={{ fontSize: 13 }}>ticks</span>
                </div>
              </div>
              <div className="stat-cell">
                <Lbl>RECOVERED?</Lbl>
                <div className="stat-value" style={{ fontSize: 20 }}>
                  {a.risk.recovered === true ? (
                    <span className="up">yes</span>
                  ) : a.risk.recovered === false ? (
                    <span className="dn">not yet</span>
                  ) : (
                    <span className="m3">not reported</span>
                  )}
                </div>
                {a.risk.recovered_at ? <div className="stat-sub">{utc(a.risk.recovered_at)}</div> : null}
              </div>
            </div>
            {/*
              THE TRADES INSIDE THE DRAWDOWN, AND WHO MADE THEM. A drawdown with
              two protective exits in it reads completely differently from one
              with two of the agent's own trades: in the first the platform was
              cutting losses, in the second the agent was still trading into
              them. The sample was already listed; it was listed without saying
              which it was.
            */}
            {(a.risk.decisions_during_drawdown?.sample ?? []).length > 0 ? (
              <div className="scroll-x" style={{ marginTop: 12 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 168 }}>Time (UTC)</th>
                      <th style={{ width: 62 }}>Action</th>
                      <th style={{ width: 160 }}>Decided by</th>
                      <th style={{ width: 78 }}>Symbol</th>
                      <th className="r" style={{ width: 96 }}>
                        Quantity
                      </th>
                      <th>Rationale</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(a.risk.decisions_during_drawdown?.sample ?? []).map((t, i) => (
                      <tr key={`${t.ts}-${i}`}>
                        <td className="mono m2" style={{ fontSize: 11.5 }}>
                          {utc(t.ts)}
                        </td>
                        <td>
                          <ActionTag action={t.action} />
                        </td>
                        <td>
                          {t.decided_by ? (
                            <Tag
                              tone={
                                t.decided_by.category === 'protective_held_back'
                                  ? 'red'
                                  : t.decided_by.category.startsWith('protective')
                                    ? 'amber'
                                    : t.decided_by.category === 'unattributed'
                                      ? 'dashed'
                                      : 'neutral'
                              }
                              title={t.decided_by.note}
                            >
                              {t.decided_by.label}
                            </Tag>
                          ) : (
                            <span className="mono m3" style={{ fontSize: 10.5 }}>
                              not reported
                            </span>
                          )}
                        </td>
                        <td className="mono">{t.symbol ?? '—'}</td>
                        <td className="r">
                          <Num value={num(t.quantity, 4)} />
                        </td>
                        <td className="m2" style={{ fontSize: 12 }}>
                          {t.rationale || <span className="m3">no rationale recorded</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {a.risk.decisions_during_drawdown?.note ? (
              <div style={{ marginTop: 10 }}>
                <Callout tone="note">{a.risk.decisions_during_drawdown.note}</Callout>
              </div>
            ) : null}
          </>
        )}
      </section>

      <section>
        <Key>Decision timing</Key>
        {!a.decision_timing ? null : a.decision_timing.analysed ? (
          <div className="mono m2" style={{ fontSize: 12, marginTop: 6 }}>
            {JSON.stringify(a.decision_timing)}
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <Callout tone="note">
              <strong>Not analysed.</strong> {a.decision_timing.reason ?? 'No reason was given.'}
            </Callout>
          </div>
        )}
      </section>

      {a.volatility ? (
        <section>
          <Key>Volatility</Key>
          <div className="stat-grid" style={{ marginTop: 10, border: '1px solid var(--color-divider)' }}>
            {Object.entries(a.volatility)
              .filter(([, v]) => typeof v === 'number')
              .map(([k, v]) => (
                <div className="stat-cell" key={k}>
                  <Lbl>{k.replace(/_/g, ' ')}</Lbl>
                  <div className="stat-value" style={{ fontSize: 19 }}>
                    <Num value={num(v as number, 6)} />
                  </div>
                </div>
              ))}
          </div>
          {typeof a.volatility.reading === 'string' ? (
            <div style={{ marginTop: 10 }}>
              <Callout tone="note">{a.volatility.reading}</Callout>
            </div>
          ) : null}
          {typeof a.volatility.attribution === 'string' ? (
            <div style={{ marginTop: 8 }}>
              <Callout tone="note">{a.volatility.attribution}</Callout>
            </div>
          ) : null}
        </section>
      ) : null}

      <section>
        <Key>What was NOT analysed, and why</Key>
        {!a.not_analysed || a.not_analysed.length === 0 ? (
          <div className="m3" style={{ fontSize: 12, marginTop: 6 }}>
            the report lists nothing as skipped
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
            {a.not_analysed.map((n) => (
              <Callout key={n.section} tone="warn">
                <strong>{n.section.replace(/_/g, ' ')}</strong> — {n.reason}
              </Callout>
            ))}
          </div>
        )}
      </section>

      {a.market_provenance || a.caveat ? (
        <section>
          <Key>Provenance</Key>
          <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
            {a.market_provenance ? (
              <Callout tone={a.market_provenance.simulated ? 'warn' : 'note'}>
                Prices came from{' '}
                <span className="mono">{(a.market_provenance.sources ?? ['unknown']).join(', ')}</span>.{' '}
                {a.market_provenance.simulated
                  ? 'This is SIMULATED market data — findings describe conduct in a simulation, not in the market.'
                  : 'This is real market data.'}
              </Callout>
            ) : null}
            {a.caveat ? <Callout tone="note">{a.caveat}</Callout> : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
