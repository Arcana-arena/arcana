/**
 * The smallest pieces: a number, a label, a badge, a bar.
 *
 * WHY A NUMBER IS A COMPONENT. Because the decision that matters — what to
 * print when there is no number — has to be made in exactly one place. Spread
 * across fifty JSX expressions, `value ?? 0` gets written by accident at least
 * once, and the page then reports a zero that no measurement produced. Here it
 * is impossible: <Num> prints the em-dash for absent and the digits for zero,
 * and takes a `why` so the reader can hover and find out which it is.
 */
import type { ReactNode } from 'react';
import { ABSENT } from '@/lib/format';

export function Mono({ children, className = '', title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span className={`mono ${className}`} title={title}>
      {children}
    </span>
  );
}

/**
 * A number, or the mark that says there is no number.
 *
 * `value` is already formatted by the caller (from lib/format) — this component
 * decides presentation, never arithmetic.
 */
export function Num({
  value,
  tone = 'flat',
  title,
  className = '',
}: {
  value: string;
  tone?: 'up' | 'dn' | 'am' | 'flat';
  title?: string;
  className?: string;
}) {
  const absent = value === ABSENT;
  return (
    <span
      className={`mono ${absent ? 'm3' : tone} ${className}`}
      title={title ?? (absent ? 'No value was recorded. This is not a zero.' : undefined)}
    >
      {value}
    </span>
  );
}

/** A field label in the small uppercase key used throughout the mockups. */
export function Key({ children }: { children: ReactNode }) {
  return <div className="k">{children}</div>;
}

export function Lbl({ children }: { children: ReactNode }) {
  return <div className="lbl">{children}</div>;
}

export type TagTone = 'neutral' | 'accent' | 'red' | 'amber' | 'outline' | 'dashed';

export function Tag({
  children,
  tone = 'neutral',
  title,
  dot = false,
}: {
  children: ReactNode;
  tone?: TagTone;
  title?: string;
  dot?: boolean;
}) {
  return (
    <span className={`tag tag-${tone}`} title={title}>
      {dot ? <span style={{ width: 5, height: 5, background: 'currentColor' }} className="pulse" /> : null}
      {children}
    </span>
  );
}

/**
 * An agent's lifecycle status, in the vocabulary the API actually uses.
 *
 * Anything the API sends that is not in this map is printed as itself rather
 * than folded into "unknown": a status this page has not been taught is still a
 * fact about the agent, and hiding it would be the page editing the record.
 */
export function StatusTag({ status }: { status: string | null | undefined }) {
  if (!status) return <Tag tone="dashed" title="The API did not send a status for this agent.">NO STATUS</Tag>;
  const s = status.toLowerCase();
  if (s === 'active') return <Tag tone="accent" dot>LIVE</Tag>;
  if (s === 'paused') return <Tag tone="amber">PAUSED</Tag>;
  if (s === 'retired') return <Tag tone="outline">RETIRED</Tag>;
  if (s === 'draft') return <Tag tone="outline">DRAFT</Tag>;
  return <Tag tone="outline">{status.toUpperCase()}</Tag>;
}

/**
 * BUY / SELL / HOLD, in the colours the mockups give them.
 *
 * THE FALLBACK IS ABBREVIATED, NOT PRINTED WHOLE. The decision log carries
 * actions beyond the three the design anticipated — `trade_failed` is a real
 * one — and rendering it at full length blew a 52px column wide enough to
 * collide with the symbol beside it. The short form keeps the column, the title
 * keeps the word, and nothing is hidden: an action this component has not been
 * taught still gets its own colour and its own text rather than being folded
 * into HOLD.
 */
const ACTION_SHORT: Record<string, { label: string; cls: string }> = {
  buy: { label: 'BUY', cls: 'act-buy' },
  sell: { label: 'SELL', cls: 'act-sell' },
  hold: { label: 'HOLD', cls: 'act-hold' },
  trade_failed: { label: 'FAILED', cls: 'act-sell' },
};

export function ActionTag({ action }: { action: string | null | undefined }) {
  const raw = action || '';
  const known = ACTION_SHORT[raw.toLowerCase()];
  if (known) {
    return (
      <span className={known.cls} title={raw}>
        {known.label}
      </span>
    );
  }
  // Initials of an unknown action, so a new vocabulary word is visible and
  // legible without silently becoming one of the three above.
  const short = raw ? raw.replace(/[^a-z0-9]+/gi, ' ').trim().split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 4) : ABSENT;
  return (
    <span className="act-hold" title={raw || 'no action recorded'}>
      {short}
    </span>
  );
}

/**
 * A horizontal bar for a 0–100 sub-score.
 *
 * An absent score gets no bar at all — not a bar of width zero, which reads as
 * "measured, and it was nothing".
 */
export function ScoreBar({ value, max = 100 }: { value: number | null | undefined; max?: number }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return (
      <div className="bar" title="Not scored. An empty bar here would read as a score of zero." style={{ background: 'transparent', border: '1px dashed var(--ink-4)' }} />
    );
  }
  const w = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="bar">
      <div style={{ width: `${w}%` }} />
    </div>
  );
}

export function Divider() {
  return <div style={{ borderTop: '1px solid var(--color-divider)' }} />;
}
