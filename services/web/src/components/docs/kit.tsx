'use client';

import { useState, type ReactNode } from 'react';

/**
 * The pieces a documentation page is built from.
 *
 * A CODE BLOCK WITH A COPY BUTTON IS A CLIENT COMPONENT AND NOTHING ELSE IS.
 * Copying needs the clipboard, which needs the browser; the rest of the docs
 * render on the server and stay readable with no JavaScript at all. The button
 * is the only thing that would not work, and it is the only thing shipped.
 */

export function CodeBlock({ children, label }: { children: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // A refused clipboard is not worth a dialog: the text is on the page and
      // selectable. Saying nothing beats a modal explaining a browser setting.
      setCopied(false);
    }
  };
  return (
    <div style={{ position: 'relative' }}>
      {label ? (
        <div className="lbl" style={{ marginBottom: 4 }}>
          {label}
        </div>
      ) : null}
      <pre className="code">
        <button className="code-copy" onClick={copy} type="button" aria-label="Copy this block">
          {copied ? 'COPIED' : 'COPY'}
        </button>
        {children}
      </pre>
    </div>
  );
}

/**
 * A parameter table.
 *
 * `value` may be null, and a null renders as an em-dash with the reason in the
 * title — the same rule the rest of the site follows. A documentation table
 * that prints 0 where the platform holds nothing teaches a reader a number that
 * was never measured, and documentation is exactly where that becomes canon.
 */
export function ParamTable({
  head = ['Parameter', 'What it is', 'Value'],
  rows,
}: {
  head?: [string, string, string];
  rows: Array<{ name: string; about: ReactNode; value: ReactNode; why?: string }>;
}) {
  return (
    <div className="param-table">
      <div className="param-row">
        <span className="param-head">{head[0]}</span>
        <span className="param-head">{head[1]}</span>
        <span className="param-head" style={{ textAlign: 'right' }}>
          {head[2]}
        </span>
      </div>
      {rows.map((r) => (
        <div className="param-row" key={r.name}>
          <span>{r.name}</span>
          <span className="m2">{r.about}</span>
          <span className="mono" style={{ textAlign: 'right' }} title={r.why}>
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Warn({ title, children, tone = 'warn' }: { title?: string; children: ReactNode; tone?: 'warn' | 'bad' | 'note' }) {
  return (
    <div className={`callout callout-${tone}`} style={{ margin: '0 0 16px' }}>
      {title ? <strong>{title}</strong> : null} {children}
    </div>
  );
}
