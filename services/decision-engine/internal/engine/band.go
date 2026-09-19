package engine

import (
	"math"
	"time"
)

// The rebalance band, scaled to the window it is measured over.
//
// # WHY THIS EXISTS
//
// `rebalance_band_pct` is the move that has to happen before an agent acts: the
// LLM decider will not buy inference to be told to hold, and the deterministic
// strategies use it as their entry threshold. It was a single number per agent,
// and that worked while every agent was asked every four hours, because then
// there was only one window it could mean.
//
// Per-agent cadence made it ambiguous overnight. The same 0.3% means "a normal
// afternoon's drift" over four hours and "a violent spike" over one minute.
// Measured on production snapshots, 2026-09-19:
//
//	Friday 13:34 -> 17:35 UTC (4h, US session)   6 of 9 symbols moved > 0.3%
//	Saturday 17:55 -> 18:34 UTC (39m, closed)    0 of 9, the largest 0.056%
//
// So an owner who shortened their agent's cadence to one minute — the platform
// default now — silently turned its band into a threshold it would almost never
// cross, and nothing in the agent's record would have said so: every decision
// read "no symbol moved beyond the rebalance band", which was true.
//
// # THE SCALING IS SQUARE ROOT OF TIME, NOT LINEAR
//
// Prices are not a ramp. The distance a price covers grows with the square root
// of the interval, because the moves compound as a random walk rather than
// adding up — that is the same property option pricing uses to annualise
// volatility, and it is not an assumption this platform gets to choose.
//
// Linear scaling would be badly wrong in the direction that costs money: at one
// minute it would give 0.3% x (60/14400) = 0.00125%, about 1/8 of the cheapest
// pool fee, so every minute's noise would look like a signal.
//
//	4h  reference   0.300%
//	1h              0.150%
//	15m             0.075%
//	1m              0.019%   (then floored by the fee — see below)
//
// # AND A FLOOR THE VENUE IMPOSES
//
// A swap costs the pool fee: 5 bp on the tight pools, 30 bp on the rest. Acting
// on a move smaller than the fee cannot pay for the act — the agent would be
// buying a 2 bp move with a 5 bp ticket. So the scaled band is floored by the
// ONE-WAY fee of that symbol's own pool.
//
// One way, not the round trip, and the distinction is deliberate: entering costs
// one fee now, and the exit is a separate decision with its own reason. The round
// trip is what the protective levels are measured against (`MinGuardPct`), which
// is a different question — what the pool will accept as a stop.
//
// This is the fee argument that the old four-hour floor got wrong, put where it
// belongs. The floor used to bound how often an agent could THINK, on the theory
// that thinking leads to trading; most decisions are holds, so it charged patient
// agents for impatient ones. This bounds what counts as a SIGNAL, per symbol, at
// the venue's own price — and an agent whose cadence is short simply needs a
// bigger move to act on, which is true rather than policy.
//
// # WHAT THE OWNER STILL CHOOSES
//
// The number, at the reference window. `rebalance_band_pct: 0.003` means "0.3%
// over four hours" and keeps meaning that whatever cadence they later pick, which
// is the point: changing how often an agent looks no longer silently changes what
// it considers worth acting on.
const BandReferenceWindow = 4 * time.Hour

// bandForCadence scales a configured band from the reference window to the
// window this agent actually measures over.
//
// A cadence of zero or less returns the configured number unchanged: the caller
// has no cadence to scale by, and inventing one would be a guess about the
// owner's intent. The same for a cadence equal to the reference, where the
// square root is 1 and the multiplication is noise in the last decimal place.
func bandForCadence(configured float64, cadence time.Duration) float64 {
	if configured <= 0 || cadence <= 0 || cadence == BandReferenceWindow {
		return configured
	}
	return configured * math.Sqrt(cadence.Seconds()/BandReferenceWindow.Seconds())
}

// oneWayPct is a pool's fee tier as a fraction: 500 -> 0.0005.
func oneWayPct(feeTier uint32) float64 { return float64(feeTier) / 1e6 }

// effectiveBand is the move one symbol must make before this agent acts: the
// cadence-scaled band, or the pool's own one-way fee, whichever is larger.
//
// feePct of zero means the fee is unknown — the paper path has no pool at all —
// and an unknown fee must not become a floor of zero, so it is simply not
// applied. The scaled band is then the whole answer, which is what every agent
// ran on before there was a chain.
func effectiveBand(scaled, feePct float64) float64 {
	if feePct > scaled {
		return feePct
	}
	return scaled
}
