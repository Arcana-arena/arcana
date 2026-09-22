'use client';

import { useState } from 'react';
import { ARCA_BUY_URL, ARCA_CONTRACT } from '@/lib/arca';



export function ContractAddress({ compact = false, buy = false }: { compact?: boolean; buy?: boolean }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ARCA_CONTRACT);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // A refused clipboard is not worth a dialog: the address is on the page
      // and selectable. Saying nothing beats a modal about a browser setting.
      setCopied(false);
    }
  };

  return (
    <span className={compact ? 'px-ca px-ca-compact' : 'px-ca'}>
      <span className="px-ca-label">$ARCA CA</span>
      <code className="px-ca-value mono" title="The $ARCA token contract on Robinhood Chain">
        {ARCA_CONTRACT}
      </code>
      <button type="button" className="px-ca-copy" onClick={copy} aria-label="Copy the $ARCA contract address">
        {copied ? 'COPIED' : 'COPY'}
      </button>
      {buy ? (
        <a
          href={ARCA_BUY_URL}
          target="_blank"
          // It leaves the site and it leads to money. noopener stops the opened
          // page reaching back through window.opener to navigate this tab —
          // which is the shape of a swap-the-page-under-you attack, and this is
          // the one link here where that would pay.
          rel="noopener noreferrer"
          className="px-ca-buy"
          aria-label="Buy $ARCA on the pons launchpad"
        >
          BUY ↗
        </a>
      ) : null}
    </span>
  );
}
