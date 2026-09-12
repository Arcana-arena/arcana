/**
 * Positions — what is open, and what is watching it.
 *
 * THIS TAB EXISTS BECAUSE OF A SPECIFIC FAILURE. An owner who asked for "get me
 * out if it drops 0.15%" ended up with a stop 15% away. Both numbers are
 * legitimate levels; the record stated the one that was armed; and nobody was
 * ever shown the two side by side. So every level here is printed in BOTH
 * scales — the fraction the engine stores and the percent a person reads —
 * because 0.15 and 0.15% only look like the same number until one of them fires.
 *
 * AN UNPROTECTED POSITION LOOKS UNPROTECTED. It gets its own block, in warning
 * colour, with the smallest level its pool would have accepted, so the answer to
 * "why isn't there a stop on this" is on the same row as the question.
 *
 * A guard that was REFUSED is not a guard. The backend returns refused rows as
 * `unprotected`, and this page keeps them there.
 *
 * `held_back_since` IS LOUDER THAN EVERYTHING ELSE. It means the price crossed a
 * level and the exit was not taken. A position that is armed but held back is
 * more dangerous than one with no level at all, because its owner believes it is
 * covered.
 */
import { agent } from '@/lib/api';
import { frac, money, num, utc } from '@/lib/format';
import { Key, Lbl, Num } from '@/components/ds/primitives';
import { Callout, Empty, Failed } from '@/components/ds/states';
import type { Err } from '@/lib/api';
import type { DecisionsResponse, Passport } from '../shapes';

export async function PositionsTab({
  id,
  p,
  passportError,
}: {
  id: string;
  p: Passport | null;
  passportError: Err | null;
}) {
  if (passportError) return <Failed what="The protection record" error={passportError} />;

  // The last decision carries the allocation the book was left in. It is the
  // only published statement of what is currently held, so it is read here —
  // and labelled with the moment it was written, because an allocation is only
  // true as of its tick.
  const lastR = await agent<DecisionsResponse>(`/v1/agents/${id}/decisions?page=1&page_size=1`);
  const last = lastR.ok ? lastR.data.decisions[0] : null;
  const allocation = last?.resulting_allocation ?? null;
  const holdings = Object.entries(allocation ?? {});

  const prot = p?.protection ?? null;
  const armed = prot?.armed ?? [];
  const unprotected = prot?.unprotected ?? [];
  const heldBack = armed.filter((g) => g.held_back_since);

  return (
    <div style={{ display: 'grid', gap: 26 }}>
      {heldBack.length > 0 ? (
        <Callout tone="bad">
          <strong>
            {heldBack.length} position{heldBack.length === 1 ? '' : 's'} crossed a level and the exit was not taken.
          </strong>{' '}
          A level that is armed but held back is worse than no level, because the owner believes the position is
          covered.{' '}
          {heldBack.map((g) => `${g.symbol}: ${g.held_back_because ?? 'no reason recorded'}`).join(' · ')}
        </Callout>
      ) : null}

      <section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
          <Key>Holdings · as of the last recorded decision</Key>
          <span className="mono m3" style={{ fontSize: 10.5 }}>
            {last ? utc(last.ts) : 'no decision to read an allocation from'}
          </span>
        </div>
        {!lastR.ok ? (
          <div style={{ marginTop: 8 }}>
            <Failed what="The latest allocation" error={lastR} />
          </div>
        ) : holdings.length === 0 ? (
          <div style={{ marginTop: 8 }}>
            <Empty title="The book holds nothing">
              The last recorded decision left the portfolio with no position in any symbol. This is a recorded
              all-cash book, not a missing reading.
            </Empty>
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th style={{ width: 120 }}>Symbol</th>
                  <th className="r" style={{ width: 160 }}>
                    % of the book
                  </th>
                  <th style={{ width: 200 }}>Protection</th>
                  <th>What is watching it</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map(([symbol, pctOfBook]) => {
                  const guard = armed.find((g) => g.symbol === symbol) ?? null;
                  const refused = unprotected.find((g) => g.symbol === symbol) ?? null;
                  return (
                    <tr key={symbol}>
                      <td className="mono">{symbol}</td>
                      <td className="r">
                        <Num value={num(pctOfBook, 2)} />
                        <span className="m3"> %</span>
                      </td>
                      <td>
                        {guard ? (
                          guard.held_back_since ? (
                            <span className="tag tag-red">ARMED · HELD BACK</span>
                          ) : (
                            <span className="tag tag-accent">ARMED</span>
                          )
                        ) : refused ? (
                          <span className="tag tag-red">UNPROTECTED · REFUSED</span>
                        ) : (
                          <span
                            className="tag tag-amber"
                            title="No guard row exists for this symbol at all — nothing is watching it between ticks."
                          >
                            NOTHING IS WATCHING
                          </span>
                        )}
                      </td>
                      <td className="m2" style={{ fontSize: 12 }}>
                        {guard ? (
                          <span className="mono" style={{ fontSize: 11.5 }}>
                            stop {money(guard.stop_loss)} <span className="m3">({frac(guard.stop_loss_fraction, 6)} = {num(guard.stop_loss_percent, 4)}%)</span>
                            <br />
                            target {money(guard.take_profit)} <span className="m3">({frac(guard.take_profit_fraction, 6)} = {num(guard.take_profit_percent, 4)}%)</span>
                          </span>
                        ) : refused ? (
                          <>
                            {refused.because ?? 'the guard was refused and no reason was recorded'}
                            {refused.smallest_accepted_percent !== null ? (
                              <div className="mono m3" style={{ fontSize: 11, marginTop: 2 }}>
                                the smallest level this pool accepts is {frac(refused.smallest_accepted_fraction, 6)} ={' '}
                                {num(refused.smallest_accepted_percent, 4)}%
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <span className="m3">no stop and no target have been armed for this symbol</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <Key>Armed levels</Key>
        {armed.length === 0 ? (
          <div style={{ marginTop: 8 }}>
            <Callout tone="warn">
              <strong>No protective level is armed.</strong> That is not a failure — a level is armed only when one is
              asked for — but nothing is watching these positions between ticks.
            </Callout>
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Symbol</th>
                  <th className="r" style={{ width: 120 }}>
                    Entry paid
                  </th>
                  <th className="r" style={{ width: 200 }}>
                    Stop · price / fraction / %
                  </th>
                  <th className="r" style={{ width: 200 }}>
                    Target · price / fraction / %
                  </th>
                  <th style={{ width: 170 }}>Armed at</th>
                </tr>
              </thead>
              <tbody>
                {armed.map((g) => (
                  <tr key={`${g.symbol}-${g.set_at}`}>
                    <td className="mono">{g.symbol}</td>
                    <td className="r">
                      <Num value={money(g.entry_price)} />
                    </td>
                    <td className="r">
                      <TwoScales price={g.stop_loss} fraction={g.stop_loss_fraction} percent={g.stop_loss_percent} />
                    </td>
                    <td className="r">
                      <TwoScales
                        price={g.take_profit}
                        fraction={g.take_profit_fraction}
                        percent={g.take_profit_percent}
                      />
                    </td>
                    <td className="mono m3" style={{ fontSize: 11 }}>
                      {utc(g.set_at)}
                      {g.held_back_since ? (
                        <div className="dn" style={{ fontSize: 11 }}>
                          held back since {utc(g.held_back_since)}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {unprotected.length > 0 ? (
        <section>
          <Key>Open and unprotected</Key>
          <div className="scroll-x">
            <table className="table" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Symbol</th>
                  <th className="r" style={{ width: 130 }}>
                    Entry paid
                  </th>
                  <th className="r" style={{ width: 240 }}>
                    Smallest level this pool accepts
                  </th>
                  <th>Why no level is armed</th>
                </tr>
              </thead>
              <tbody>
                {unprotected.map((g) => (
                  <tr key={g.symbol}>
                    <td className="mono">{g.symbol}</td>
                    <td className="r">
                      <Num value={money(g.entry_price)} />
                    </td>
                    <td className="r">
                      {g.smallest_accepted_fraction === null ? (
                        <span className="mono m3">not reported</span>
                      ) : (
                        <span className="mono">
                          {frac(g.smallest_accepted_fraction, 6)} <span className="m3">=</span>{' '}
                          {num(g.smallest_accepted_percent, 4)}%
                        </span>
                      )}
                    </td>
                    <td className="m2" style={{ fontSize: 12 }}>
                      {g.because ?? 'no reason recorded'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {prot?.note ? (
        <section>
          <Key>In words</Key>
          <div style={{ marginTop: 8 }}>
            <Callout tone={armed.length === 0 || unprotected.length > 0 ? 'warn' : 'note'}>{prot.note}</Callout>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/**
 * A level, in both scales, always.
 *
 * The price is what will actually fire. The fraction is what the engine stores
 * and what a mandate should be written in. The percent is what a person reads.
 * Printing any one of them alone is how 0.15 became 15%.
 */
function TwoScales({
  price,
  fraction,
  percent,
}: {
  price: number | null;
  fraction: number | null;
  percent: number | null;
}) {
  if (price === null && fraction === null) {
    return (
      <span className="mono m3" title="No level of this kind is armed on this position.">
        none armed
      </span>
    );
  }
  return (
    <span className="mono" style={{ fontSize: 11.5 }}>
      {money(price)}
      <div className="m3" style={{ fontSize: 10.5 }}>
        {frac(fraction, 6)} = {num(percent, 4)}%
      </div>
    </span>
  );
}
