/**
 * A line chart that draws every point it was given.
 *
 * THE ONE THING THIS MUST NOT DO IS THIN THE SERIES. The backend already
 * decided the resolution: when a range holds more points than a page, it buckets
 * them and keeps the FIRST, the MIN, the MAX and the LAST of each bucket, which
 * is why each point carries an `agg` marker. Those extremes are the whole
 * purpose — a drawdown is a minimum, and a chart that resamples "every third
 * point" for smoothness is a chart that deletes the worst moment of the record
 * and draws a calmer line than the one that happened.
 *
 * So: no decimation, no smoothing, no interpolation between points, no
 * curve-fitting. Vertices are plotted where the values are. The only arithmetic
 * here is mapping a value onto pixels, which is what a chart is.
 *
 * The y-axis bounds come from the points on screen. That is a drawing decision,
 * not a claim, and the axis labels print the actual bounds so the reader can see
 * the scale rather than infer it from the shape.
 */
import { ABSENT } from '@/lib/format';

export type Point = { ts: string; value: number | null; agg?: string | null; season_id?: string | null };

export type Marker = { ts: string; label: string; tone?: 'amber' | 'red' | 'accent' };

function scale(points: Point[]) {
  const vals = points.map((p) => p.value).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (vals.length === 0) return null;
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (lo === hi) {
    // A flat series is a real series. Give it a band so the line is visible
    // rather than collapsing to the top edge, and say in the axis what the
    // single value is.
    lo = lo - 1;
    hi = hi + 1;
  }
  const times = points.map((p) => Date.parse(p.ts)).filter((t) => Number.isFinite(t));
  return { lo, hi, t0: Math.min(...times), t1: Math.max(...times) };
}

export function LineChart({
  points,
  height = 200,
  markers = [],
  baseline,
  baselineLabel,
  unit,
  resolutionNote,
  tone = 'accent',
}: {
  points: Point[];
  height?: number;
  markers?: Marker[];
  baseline?: number | null;
  baselineLabel?: string;
  unit?: string;
  resolutionNote?: string | null;
  tone?: 'accent' | 'red';
}) {
  const s = scale(points);
  if (!s || points.length === 0) {
    return (
      <div
        className="m3"
        style={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px dashed var(--ink-4)',
          fontSize: 12,
        }}
      >
        no points in this range — the series is empty, not flat at zero
      </div>
    );
  }

  const W = 1000;
  const H = height;
  const padR = 58;
  const innerW = W - padR;
  const x = (ts: string) => {
    if (s.t1 === s.t0) return 0;
    return ((Date.parse(ts) - s.t0) / (s.t1 - s.t0)) * innerW;
  };
  const y = (v: number) => H - 6 - ((v - s.lo) / (s.hi - s.lo)) * (H - 14);

  const drawn = points.filter((p) => typeof p.value === 'number' && Number.isFinite(p.value)) as Array<
    Point & { value: number }
  >;
  const poly = drawn.map((p) => `${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `M${poly.split(' ').join(' L')} L${innerW},${H} L0,${H}Z`;
  const stroke = tone === 'red' ? 'var(--red)' : 'var(--color-accent)';
  const fill = tone === 'red' ? 'rgba(210,96,91,.07)' : 'rgba(47,232,140,.07)';

  const gridVals = [s.hi, s.lo + (s.hi - s.lo) * 0.66, s.lo + (s.hi - s.lo) * 0.33, s.lo];

  return (
    <div>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        <g stroke="rgba(228,237,231,.08)">
          {gridVals.map((v, i) => (
            <line key={i} x1="0" y1={y(v)} x2={innerW} y2={y(v)} />
          ))}
        </g>
        <g fontFamily="var(--font-mono)" fontSize="10" fill="#5a6a60">
          {gridVals.map((v, i) => (
            <text key={i} x={innerW + 6} y={y(v) + 3}>
              {v.toLocaleString('en-US', { maximumFractionDigits: 2 })}
            </text>
          ))}
        </g>
        {typeof baseline === 'number' && baseline >= s.lo && baseline <= s.hi ? (
          <>
            <line x1="0" y1={y(baseline)} x2={innerW} y2={y(baseline)} stroke="#5a6a60" strokeDasharray="3 3" />
            <text x="4" y={y(baseline) - 5} fontFamily="var(--font-mono)" fontSize="10" fill="#5a6a60">
              {baselineLabel ?? `start ${baseline.toLocaleString('en-US')}`}
            </text>
          </>
        ) : null}
        {drawn.length > 1 ? <path d={area} fill={fill} /> : null}
        <polyline fill="none" stroke={stroke} strokeWidth="1.6" points={poly} />
        {/* Every point is a vertex. Drawn small so a dense series stays readable,
            drawn at all so nothing is silently absent from the line. */}
        {drawn.length <= 400
          ? drawn.map((p, i) => (
              <circle
                key={i}
                cx={x(p.ts)}
                cy={y(p.value)}
                r={p.agg === 'min' || p.agg === 'max' ? 2.2 : 1.2}
                fill={stroke}
                opacity={p.agg === 'min' || p.agg === 'max' ? 0.95 : 0.45}
              >
                <title>{`${p.ts} · ${p.value}${unit ? ` ${unit}` : ''}${p.agg ? ` · ${p.agg} of its bucket` : ''}`}</title>
              </circle>
            ))
          : null}
        {markers.map((m, i) => {
          const mx = x(m.ts);
          const colour = m.tone === 'red' ? 'var(--red)' : m.tone === 'accent' ? 'var(--color-accent)' : 'var(--amber)';
          return (
            <g key={i} stroke={colour} strokeWidth="1.5">
              <path d={`M${mx},0 v${H}`} opacity="0.55" />
              <title>{m.label}</title>
            </g>
          );
        })}
      </svg>
      <div
        style={{ display: 'flex', gap: 18, fontSize: 10.5, color: 'var(--ink-3)', marginTop: 4, flexWrap: 'wrap' }}
      >
        <span className="mono">
          {drawn.length} point{drawn.length === 1 ? '' : 's'} plotted
          {points.length !== drawn.length ? ` · ${points.length - drawn.length} carried no value` : ''}
        </span>
        {resolutionNote ? <span className="mono">{resolutionNote}</span> : null}
        {markers.length > 0 ? (
          <span>
            <span style={{ display: 'inline-block', width: 2, height: 8, background: 'var(--amber)', verticalAlign: 'middle' }} />{' '}
            {markers.length} protective exit{markers.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The small inline line used inside a table cell.
 *
 * Same rule: it draws the points it is handed, in order, and nothing else. If
 * there are no points it says so instead of drawing a flat line, because a flat
 * line is a claim that the value did not move.
 */
export function Sparkline({ points, width = 110, height = 22 }: { points: Point[]; width?: number; height?: number }) {
  const drawn = points.filter((p) => typeof p.value === 'number' && Number.isFinite(p.value)) as Array<
    Point & { value: number }
  >;
  if (drawn.length < 2) {
    return (
      <span className="mono m3" style={{ fontSize: 10 }} title="Fewer than two points — nothing to draw a line between.">
        {ABSENT}
      </span>
    );
  }
  const vals = drawn.map((p) => p.value);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const step = 100 / (drawn.length - 1);
  const pts = drawn.map((p, i) => `${(i * step).toFixed(1)},${(20 - ((p.value - lo) / span) * 18).toFixed(1)}`).join(' ');
  const rising = drawn[drawn.length - 1].value >= drawn[0].value;
  return (
    <svg width={width} height={height} viewBox="0 0 100 22" preserveAspectRatio="none">
      <polyline fill="none" stroke={rising ? '#2FE88C' : '#d2605b'} strokeWidth="1.2" points={pts} />
    </svg>
  );
}
