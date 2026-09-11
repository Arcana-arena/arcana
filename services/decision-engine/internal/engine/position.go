package engine

import "math/big"

// What counts as holding something.
//
// THE NUMBER COMES FROM THE RECORD, NOT FROM TASTE.
//
// decisions.quantity is numeric(20,8). Eight decimals is the finest quantity
// ARCANA is able to write down, so a holding smaller than 1e-8 shares cannot be
// recorded as a trade, cannot therefore be sold, and cannot become anything.
// It is not a small position. It is a quantity the record has no way to express.
//
// This is the same derivation already written down for OnChainQtyStep, and the
// same shape of derivation as the sixty-second cadence floor, which comes from
// the minute resolution of a snapshot ref rather than from anyone's preference.
// One number, from one column, used everywhere the question "does this agent
// hold X" is asked.
//
// WHY THE QUESTION CAME UP. A sell that emptied a position on chain left one
// wei of GOOGL behind — 0.000000000000000001 shares. Not a rounding choice made
// for safety: the fill was 17704874344043495 base units, seventeen significant
// digits, and a float64 carries about fifteen to seventeen. The snapshot stored
// ...494, the sell sent ...494, and the chain still held ...495. One wei of a
// float64 round-trip.
//
// Everything downstream then read that wei as a position. See docs/positions.md
// for what it actually changed, which was not nothing.
const DustFloor = OnChainQtyStep // 1e-8 shares

// HasPosition is the one question, asked one way.
//
// Every "do we hold this" in the engine goes through here. The alternative —
// each caller writing `> 0` — is what let a wei of dust look like a position to
// four different readers at once, each of which was individually reasonable.
func HasPosition(h map[string]any, sym string) bool {
	return qtyFromHoldings(h, sym) >= DustFloor
}

// HeldQty is what the agent holds, with dust reported as nothing.
//
// Used wherever a quantity is about to be ACTED on — clamped, sold, sized
// against. Reporting dust as zero here means a sell can never be built out of
// an amount too small to write down.
func HeldQty(h map[string]any, sym string) float64 {
	q := qtyFromHoldings(h, sym)
	if q < DustFloor {
		return 0
	}
	return q
}

// PositionCount is how many real positions a holdings map contains.
func PositionCount(h map[string]any) int {
	n := 0
	for sym := range h {
		if HasPosition(h, sym) {
			n++
		}
	}
	return n
}

// pruneDust is what gets WRITTEN to a snapshot.
//
// Cleaning at the write keeps every new row free of entries no reader should
// have to defend itself against. The readers defend themselves anyway, because
// rows written before this existed are still in the table and have to stay
// comparable with the ones written after it.
func pruneDust(h map[string]any) map[string]any {
	out := make(map[string]any, len(h))
	for sym, v := range h {
		if toFloat(v) >= DustFloor {
			out[sym] = v
		}
	}
	return out
}

// dustUnits is DustFloor expressed in a token's base units.
//
// 1e-8 shares of an 18-decimal token is 1e10 base units. Used to ask whether
// the remainder a sell would leave behind is a position or a residue.
func dustUnits(decimals int) *big.Int {
	if decimals <= 8 {
		return big.NewInt(1)
	}
	return pow10(decimals - 8)
}
