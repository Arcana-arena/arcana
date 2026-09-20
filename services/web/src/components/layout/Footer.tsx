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

/**
 * THE STAMP IS LABELLED BY WHOEVER PASSES IT, and that is a correction.
 *
 * This took an `asOf` and printed it as "read at". The leaderboard passed the
 * score snapshot's timestamp — the moment the SCORING ENGINE last ran — so the
 * footer told a reader the page had been read at a time that was really when
 * the numbers were computed. Those are different facts and the gap between them
 * is hours: the value sat unchanged across refreshes, which reads as a frozen
 * page rather than as fresh page showing settled data.
 *
 * A caller now says what its timestamp means, because only the caller knows.
 */
export function Footer({
  stamp,
  note,
}: {
  stamp?: { label: string; value: string | null } | null;
  note?: string;
}) {
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
      {/*
        THE ONE LINK ON THIS SITE THAT LEAVES IT, so it is the one that carries
        rel="noopener noreferrer": without `noopener` the page it opens can
        reach back through window.opener and navigate this tab somewhere else.
        A plain <a>, not next/link, because there is no route here to prefetch.

        The handle is written out rather than labelled "X" — somebody deciding
        whether to follow an account wants to see which account it is.
      */}
      <a
        href="https://x.com/Arcana_Arena"
        target="_blank"
        rel="noopener noreferrer"
        title="ARCANA on X"
      >
        @Arcana_Arena
      </a>
      <span className="mono m3" style={{ marginLeft: 'auto', fontSize: 10.5, textAlign: 'right' }}>
        {/* No house style note by default. "this page reads; it computes
            nothing" is a thing the authors say to each other, and a footer is
            not where a visitor goes to read it. */}
        {note ?? ''}
        {stamp?.value ? ` · ${stamp.label} ${stamp.value}` : ''}
      </span>
    </footer>
  );
}
