/**
 * Presentation only. Nothing in this file decides anything.
 *
 * THE ONE JOB: never let an absent number look like a zero. Every formatter
 * here returns the em-dash placeholder for null/undefined/NaN and the actual
 * digits for 0, because "0.00%" and "we do not know" are different facts and a
 * trading surface that blurs them is lying with a straight face.
 *
 * `toFixed` is a display choice, not a calculation — the value printed is the
 * value the backend sent, rounded for the column width. Where rounding would
 * hide something that matters (a level, a price), the unrounded value is put in
 * the title attribute so it is one hover away rather than gone.
 */

/** What an absent number looks like, everywhere, so it is recognisable. */
export const ABSENT = '—';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function num(v: unknown, dp = 2): string {
  if (!isNum(v)) return ABSENT;
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function int(v: unknown): string {
  if (!isNum(v)) return ABSENT;
  return Math.round(v).toLocaleString('en-US');
}

/** A percentage the backend already expressed in percent units. */
export function pct(v: unknown, dp = 2): string {
  if (!isNum(v)) return ABSENT;
  const sign = v > 0 ? '+' : v < 0 ? '\u2212' : '';
  return `${sign}${Math.abs(v).toFixed(dp)}%`;
}

/** A fraction (0.0231) shown as a percentage, for values stored as fractions. */
export function fracAsPct(v: unknown, dp = 2): string {
  if (!isNum(v)) return ABSENT;
  return `${(v * 100).toFixed(dp)}%`;
}

/** A fraction shown as itself, to the precision the record actually keeps. */
export function frac(v: unknown, dp = 4): string {
  if (!isNum(v)) return ABSENT;
  return v.toFixed(dp);
}

export function score(v: unknown): string {
  if (!isNum(v)) return ABSENT;
  return v.toFixed(1);
}

export function money(v: unknown, dp = 2): string {
  if (!isNum(v)) return ABSENT;
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** 0x7a3f…c21e — the shape an address is recognised by. Never invented. */
export function addr(a: unknown): string {
  if (typeof a !== 'string' || a.length < 12) return typeof a === 'string' && a ? a : ABSENT;
  return `${a.slice(0, 6)}\u2026${a.slice(-4)}`;
}

export function txShort(h: unknown): string {
  if (typeof h !== 'string' || h.length < 14) return typeof h === 'string' && h ? h : ABSENT;
  return `${h.slice(0, 6)}\u2026${h.slice(-4)}`;
}

export function utc(ts: unknown): string {
  if (typeof ts !== 'string' || !ts) return ABSENT;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ABSENT;
  return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

export function utcDate(ts: unknown): string {
  if (typeof ts !== 'string' || !ts) return ABSENT;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ABSENT;
  return d.toISOString().slice(0, 10);
}

export function utcTime(ts: unknown): string {
  if (typeof ts !== 'string' || !ts) return ABSENT;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ABSENT;
  return d.toISOString().slice(11, 19);
}

/** Sign class for colour. Zero is neutral, absent is neutral — neither is a loss. */
export function tone(v: unknown): 'up' | 'dn' | 'flat' {
  if (!isNum(v) || v === 0) return 'flat';
  return v > 0 ? 'up' : 'dn';
}

/** Turn snake_case or lowercase identifiers into something a sentence can hold. */
export function human(s: unknown): string {
  if (typeof s !== 'string' || !s) return ABSENT;
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
