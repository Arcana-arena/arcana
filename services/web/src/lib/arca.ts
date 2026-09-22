/**
 * The $ARCA token, as one set of facts the whole site reads.
 *
 * A PLAIN MODULE, NOT A COMPONENT FILE, and that is the point of it existing.
 * These constants first lived in ContractAddress.tsx, which carries
 * `'use client'`. A server component that imports from a client module does
 * not get the value — Next replaces the module with a client reference, so
 * `ARCA_CONTRACT.slice(...)` threw "is not a function" and took /docs/arca to
 * a 500. Values that both halves need belong in a module that declares
 * neither.
 *
 * VERIFIED ON CHAIN before any of it was published: name() ARCANA, symbol()
 * ARCA, decimals() 18, totalSupply() 1,000,000,000, code deployed. A contract
 * address on a site under a name nobody checked is worth less than no address.
 */

export const ARCA_CONTRACT = '0xc00c26b09d602a04a83e6d7f8224affa3ecc4ca7';

/** 1,000,000,000 — written out so no page derives it from a raw supply read. */
export const ARCA_SUPPLY = '1,000,000,000';

export const ARCA_DECIMALS = 18;

/**
 * Where it can be bought.
 *
 * BUILT FROM THE ADDRESS ABOVE, never pasted separately. A buy link pointing
 * at a different contract than the one displayed beside it is how somebody
 * ends up holding a lookalike, and two literals in two files is exactly how
 * that happens quietly.
 */
export const ARCA_BUY_URL = `https://www.ponsfamily.com/launchpad/${ARCA_CONTRACT}`;
