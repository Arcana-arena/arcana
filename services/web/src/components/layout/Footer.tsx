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
import { SocialLinks } from './SocialLinks';
import { ContractAddress } from './ContractAddress';

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
      {/* The marks, not the handles spelled out. See components/layout/SocialLinks. */}
      <SocialLinks />
      <ContractAddress compact />
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
