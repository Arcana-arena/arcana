/**
 * The footer, and the one sentence in it that has to stay true.
 *
 * The mockups end every page with "every number on this page is read from the
 * chain · block 8,214,006". That claim is stronger than this surface can
 * currently make: the numbers are read from ARCANA's services, which read the
 * chain and their own record of it, and no block height is exposed to quote. So
 * the line says what is actually true — the page computes nothing — and names
 * the moment the data was read, which the caller passes in from the response
 * itself rather than from the clock on this machine.
 */
import Link from 'next/link';

export function Footer({ asOf, note }: { asOf?: string | null; note?: string }) {
  return (
    <footer className="ftr">
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <img src="/arcana-mark.png" alt="" width={16} height={16} style={{ display: 'block', opacity: 0.7 }} />
        <span className="mono m3" style={{ fontSize: 10, letterSpacing: '.12em' }}>
          ARCANA · ROBINHOOD CHAIN {process.env.NEXT_PUBLIC_ARCANA_CHAIN_ID || '4663'}
        </span>
      </span>
      <Link href="/docs">Docs</Link>
      <Link href="/status">Status</Link>
      <span className="mono m3" style={{ marginLeft: 'auto', fontSize: 10.5, textAlign: 'right' }}>
        {/* No house style note by default. "this page reads; it computes
            nothing" is a thing the authors say to each other, and a footer is
            not where a visitor goes to read it. */}
        {note ?? ''}
        {asOf ? ` · read at ${asOf}` : ''}
      </span>
    </footer>
  );
}
