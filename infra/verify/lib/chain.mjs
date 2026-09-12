/**
 * lib/chain.mjs — read the chain, and prove things from the transaction rather
 * than from the state the chain happens to be in now.
 *
 * WHY THIS IS SHARED AND NOT COPIED. The same two defects were written twice, in
 * subscription-chain-verify and in guard-chain-verify, and found a week apart:
 *
 *   1. rpc() returned `(await r.json()).result`, which is undefined the moment
 *      the node replies with an error, and undefined then flowed into
 *      `BigInt(x || '0x0')` = 0n — "the wallet holds nothing" — PASSING a custody
 *      claim on no data whatsoever.
 *
 *   2. "the exit emptied the position" was asserted against the balance at
 *      'latest'. The fan-out and the agent both re-buy the same symbols into the
 *      same wallets, so any re-entry after the exit made a perfectly clean exit
 *      read as a residue. It cannot be repaired by reading at the exit's own
 *      block either: the endpoint refuses historical state outright ("Archive
 *      requests require a personal token"), five hundred blocks back as surely as
 *      two hundred thousand. Measured, not assumed.
 *
 * Two copies agree on every day they still agree. guard-chain-verify sat red for
 * four false failures while its sibling had been fixed, and nobody could tell
 * from either file that the other one knew better.
 *
 * THE RULE THIS ENCODES. What a transaction DID is in its receipt, and a receipt
 * is immutable and always served. What a wallet HOLDS is state, it is whatever
 * the last transaction left, and it answers a different question than the one
 * these suites are asking. So custody is proved from the Transfer logs of the
 * exit itself, against the quantity the guard was protecting.
 *
 * Nothing here writes: eth_call and eth_getTransactionReceipt only. No suite
 * built on this can spend anything.
 */
import { readFileSync } from 'node:fs';

// keccak256('Transfer(address,address,uint256)')
export const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export class RpcError extends Error {
  constructor(method, message, code) {
    super(`${method}: ${message}`);
    this.code = code;
  }
}

/**
 * makeRpc returns a JSON-RPC caller that REFUSES rather than returning undefined.
 * `result: null` is preserved, because that is a real answer: the node saying it
 * does not know that transaction.
 */
export function makeRpc(url) {
  return async function rpc(method, params) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!r.ok) throw new RpcError(method, `HTTP ${r.status} from ${url}`, r.status);
    const j = await r.json();
    if (j.error) throw new RpcError(method, j.error.message || JSON.stringify(j.error), j.error.code);
    if (!('result' in j)) throw new RpcError(method, 'a reply carrying neither result nor error');
    return j.result;
  };
}

/**
 * balanceOf, for the questions where current state really is the subject.
 * A balance nobody could read is not a balance of zero, and an empty address is
 * refused: ''.slice(2) padded is balanceOf(0x0), which answers 0 and would read
 * as an emptied position.
 */
export async function balanceOf(rpc, token, wallet, block = 'latest') {
  if (!/^0x[0-9a-f]{40}$/i.test(wallet || '')) {
    throw new Error(`${JSON.stringify(wallet)} is not an address, and balanceOf(0x0) answers 0`);
  }
  const hex = await rpc('eth_call',
    [{ to: token, data: '0x70a08231' + wallet.slice(2).toLowerCase().padStart(64, '0') }, block]);
  if (typeof hex !== 'string' || !/^0x[0-9a-f]*$/i.test(hex)) {
    throw new RpcError('eth_call', `balanceOf answered ${JSON.stringify(hex)}`);
  }
  return BigInt(hex === '0x' ? '0x0' : hex);
}

/**
 * transferredOut sums the ERC-20 Transfer logs in one receipt that move `token`
 * OUT of `wallet`. This is the archive-free way to ask what a transaction did:
 * receipts are served for any age, and no later trade can change one.
 */
export function transferredOut(receipt, token, wallet) {
  const from = '0x' + wallet.slice(2).toLowerCase().padStart(64, '0');
  return (receipt.logs || [])
    .filter((l) => (l.address || '').toLowerCase() === token.toLowerCase() &&
      (l.topics || [])[0] === TRANSFER &&
      ((l.topics || [])[1] || '').toLowerCase() === from)
    .reduce((a, l) => a + BigInt(l.data), 0n);
}

/**
 * emptied compares what left the wallet against what was being guarded.
 * Returns {ok, sent, want, tol} so the caller can word its own check.
 *
 * The tolerance is a tenth of a percent plus the dust floor, because entry_qty is
 * NUMERIC(20,8) and the chain counts base units: at 18 decimals the column cannot
 * express the last ten digits of the number it is being compared to.
 */
export function emptied(receipt, tok, wallet, guardedQty) {
  const sent = transferredOut(receipt, tok.address, wallet);
  const want = BigInt(Math.round(Number(guardedQty) * 10 ** tok.decimals));
  const tol = want / 1000n + dustFloor(tok);
  const diff = sent > want ? sent - want : want - sent;
  return { ok: sent > 0n && diff <= tol, sent, want, tol };
}

/**
 * The dust floor in base units: a hundredth of a millionth of a share, at
 * whatever precision the token is denominated in. NOT hardcoded to 18 — the quote
 * token in this project's own allowlist is 6 decimals.
 */
export function dustFloor(tok) {
  return 10n ** BigInt(tok.decimals - 8);
}

/**
 * The allowlist, read once. A symbol that is not in it returns null rather than
 * throwing: an uncaught throw in a verifier kills the run before the summary
 * prints, and the summary is the only part anybody reads.
 */
export function loadAllowlist(repo) {
  const path = process.env.EXECUTION_ALLOWLIST_FILE ||
    `${repo}/services/signer/allowlist/robinhood-mainnet.json`;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function tokenOf(allowlist, symbol) {
  return (allowlist.tokens || []).find((t) => t.symbol === symbol) || null;
}

export function quoteDecimals(allowlist) {
  return (allowlist.quote_token && allowlist.quote_token.decimals) || 6;
}

/**
 * chainReader turns a failed chain read into a FAILED CHECK rather than an
 * exception. Returns undefined when the read failed — distinct from null, which
 * is the node's own answer.
 */
export function chainReader(check) {
  return async function chainRead(what, fn) {
    try {
      return await fn();
    } catch (e) {
      check(what, false, `the chain could not be read: ${e.message}`);
      return undefined;
    }
  };
}
