import type { ReactNode } from 'react';

/**
 * A meaning, on request.
 *
 * WHERE A NUMBER NEEDS A SENTENCE TO BE READ CORRECTLY, that sentence exists —
 * it just does not have to be printed under every figure. This keeps it one tap
 * or hover away: the text is in the document (so it is found, read by screen
 * readers, and checked by the verification suites), and shown only when asked.
 *
 * NO JAVASCRIPT. It opens on hover and on focus, and a tap on a phone focuses
 * the button. Hidden with display:none rather than visibility, so a popover near
 * the edge of a narrow screen cannot widen the page while it is closed.
 *
 * Not for use inside a horizontally scrolling table: the scroll box would clip
 * it. Put it beside the table instead.
 */
export function Hint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="hint">
      <button type="button" className="hint-btn" aria-label={label}>
        i
      </button>
      <span role="tooltip" className="hint-pop">
        {children}
      </span>
    </span>
  );
}
