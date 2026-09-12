/**
 * Where a row came from, recorded rather than guessed.
 *
 * WHY. Cleanup of verification fixtures used to match NAMES, and one mechanism
 * failed in both directions at once: it could not see fixtures whose creator
 * handle nobody had thought to list, and it pointed straight at an agent called
 * `Phase 8c buy leg` — which holds the only wallet still trading. A name is a
 * label someone chose; provenance is a fact about how the row was made.
 *
 * Every verification suite already sends this header on every call, through the
 * shared `req()` helper in infra/verify/lib/rate-aware.mjs. Until now nothing on
 * this side read it.
 *
 * WHAT THIS IS NOT. It is not a security boundary, and it is not pretending to
 * be one: a header is whatever the caller says it is. What it guarantees is the
 * direction that matters. A production client — a browser, a wallet, anything a
 * real creator uses — never sends this header, so a live row cannot acquire the
 * mark by accident. Sending it deliberately marks only your own new row, and
 * cannot reach anybody else's.
 *
 * The real protection against deleting something that matters is that the sweep
 * ALSO refuses to touch a row with a wallet, an execution, or a seat in a
 * competition — an independent condition that holds even if this one is wrong.
 */
export const VERIFICATION_HEADER = 'x-arcana-verification';

export type Provenance = 'live' | 'verification';

/**
 * Exactly '1' counts. Anything else — absent, empty, 'true', '0' — is live,
 * because a mark this one decides deletions by should be given deliberately.
 */
export function provenanceFrom(header?: string): Provenance {
  return header === '1' ? 'verification' : 'live';
}

/**
 * How many creators the verification path may hold at once.
 *
 * THE PRODUCT LIMIT WAS NEVER THE PROBLEM. MAX_ACTIVE_AGENTS_PER_CREATOR = 3 is
 * the right unit for a person: it says how many agents one creator may run. It
 * was simply never reachable, because every suite run minted a FRESH creator —
 * 81 of them, each with its own three slots, so the brake never touched the
 * floor. The count of active agents was bounded only by how often the suites ran.
 *
 * This bounds the other side, and only on the verification path, so nothing
 * about how real creators sign up changes. It is deliberately generous: a suite
 * that cleans up after itself never approaches it, and one that has stopped
 * cleaning up hits a loud refusal naming the sweep instead of quietly adding to
 * a pile nobody is counting.
 */
export const MAX_VERIFICATION_CREATORS = 25;
