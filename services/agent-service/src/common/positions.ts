/**
 * What counts as holding something, on the reading side.
 *
 * THIS NUMBER IS NOT CHOSEN HERE. It is the precision of decisions.quantity,
 * numeric(20,8): eight decimals is the finest quantity ARCANA is able to write
 * down, so a holding smaller than 1e-8 shares cannot be recorded as a trade,
 * cannot therefore be sold, and cannot become anything. It is not a small
 * position — it is a quantity the record has no way to express.
 *
 * The decision engine derives the same number the same way, as
 * engine.DustFloor in services/decision-engine/internal/engine/position.go, and
 * docs-verify fails if the two stop agreeing or if either stops agreeing with
 * the column. Two languages cannot share an import; they can share a derivation
 * and a guard that checks they still agree.
 *
 * WHY THE READERS STILL FILTER even though the engine now prunes dust before
 * writing a snapshot: rows written before the prune existed are still in the
 * table. Filtering here is what keeps a chart or a DNA vector computed over old
 * rows comparable with one computed over new rows, instead of the definition
 * quietly changing in the middle of an agent's history.
 *
 * See docs/positions.md.
 */
export const DUST_FLOOR = 1e-8;

/** True when this quantity is a position rather than a residue. */
export function isPosition(qty: number | null | undefined): boolean {
  return typeof qty === 'number' && Number.isFinite(qty) && qty >= DUST_FLOOR;
}

/** The entries of a holdings map that are actually positions. */
export function positionsOf(
  holdings: Record<string, number> | null | undefined,
): Array<[string, number]> {
  return Object.entries(holdings ?? {}).filter(([, qty]) => isPosition(qty));
}
