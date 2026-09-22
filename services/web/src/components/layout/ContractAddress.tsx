'use client';

import { useState } from 'react';

/**
 * The $ARCA contract address, in full and copyable.
 *
 * IN FULL, NOT TRUNCATED. Everywhere else on this site an address is shortened
 * — `0x8e4f…5ffe` is enough to recognise a wallet you already know. This one is
 * the opposite case: people arrive looking for it, and what they do with it is
 * paste it into something that will spend money. A truncated token address is a
 * shape somebody can match against a lookalike contract, which is exactly how a
 * fake token gets bought. So it is shown whole, it is selectable, and the copy
 * button hands over the same string the page displays.
 *
 * THE ONLY CLIENT COMPONENT IN THE FOOTER, and only because copying needs the
 * clipboard. With no JavaScript the address is still there and still
 * selectable; the button is the one thing that stops working.
 *
 * VERIFIED ON CHAIN BEFORE IT WAS PUT HERE: name() returns ARCANA, symbol()
 * returns ARCA, decimals() 18, totalSupply() 1,000,000,000. A contract address
 * published under a name nobody checked is worth less than no address at all.
 */

export const ARCA_CONTRACT = '0xc00c26b09d602a04a83e6d7f8224affa3ecc4ca7';

/**
 * Where the token can be bought.
 *
 * THE ADDRESS IN THIS URL IS THE ADDRESS ABOVE, and that is the only reason
 * this link is safe to put on the page: a buy button pointing at a different
 * contract than the one displayed beside it is how somebody ends up holding a
 * lookalike. Checked when it was added — the launchpad answered 200 and titled
 * the page "ARCANA ($ARCA)". If the contract ever changes, both constants move
 * together or neither does.
 */
const BUY_URL = `https://www.ponsfamily.com/launchpad/${ARCA_CONTRACT}`;

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
          href={BUY_URL}
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
