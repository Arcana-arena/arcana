package engine

import (
	"math"
)

// ---------------------------------------------------------------------------
// ARCANA Score — V1 factor formulas.
//
// Full rationale & revision log: docs/scoring-formula.md.
//
// Score convention: every factor is 0..100 (higher is better). The composite
// arcana_score is the weighted sum below.
// ---------------------------------------------------------------------------

// Weights are top-level constants so they can be tuned in one place.
// Weights sum to 1.0:
//
//	performance 0.35  — return is the primary signal
//	risk        0.25  — drawdown & volatility hurt
//	consistency 0.15  — steady growers beat erratic ones
//	regime      0.10  — classifier absent (Mar 2027 roadmap), low weight
//	creator     0.05  — peer-derived, low until creator scoring matures
//	longevity   0.10  — time-in-competition reward
//
// strategy is NOT here: since 2026-09-09 it is a multiplier on the total, not
// a term in the sum. Its old 0.10 went to performance and risk, the two
// factors that actually measure decision quality from the NAV series.
const (
	wPerformance = 0.35
	wRisk        = 0.25
	wConsistency = 0.15
	wRegime      = 0.10
	wCreator     = 0.05
	wLongevity   = 0.10
)

// strategyFloor is the worst multiplier a mislabelled agent can suffer: it
// keeps 70% of what it earned.
//
// Not 0. An agent that trades well but describes itself wrongly has still
// traded well, and zeroing it would make the label matter more than the
// record. 0.70 is chosen to be worse than any plausible gain from
// mislabelling — a mislabelled agent cannot climb past an honest peer by
// being slightly better — while leaving the outcome recognisable.
const strategyFloor = 0.70

// Neutral score used when a factor cannot be computed yet (placeholder).
const neutral = 50.0

// Calibration constants (documented in docs/scoring-formula.md).
const (
	// perfScale: return of +scale => performance 100, -scale => 0.
	perfScale = 0.20
	// volScale: per-tick return stdev of volScale => risk/consistency floor 0.
	volScale = 0.05
	// ddScale: max drawdown of ddScale => risk 0.
	ddScale = 0.20
	// consistencyScale: return stdev at which consistency hits 0.
	//
	// Widened from 0.02 on 2026-09-09 because its input changed meaning: the
	// dispersion is now divided by exposure, so the numbers reaching this scale
	// are several times larger than the raw NAV dispersion it was set against.
	// At 0.02 every agent clustered between 0 and 33 and the factor had stopped
	// telling them apart — a near-flat penalty is not a measurement.
	consistencyScale = 0.04
	// longevityTicks: tick count at which longevity saturates at 100.
	longevityTicks = 20.0
	// strategyMinDecisions: decisions required before an agent's behaviour is
	// judged against its declared strategy. Below this, one or two ticks of
	// noise would decide the score.
	strategyMinDecisions = 5
	// strategyFitTolerance: how far outside its expected band a metric may
	// drift before the fit reaches 0.
	strategyFitTolerance = 0.25
	// minParticipationDecisions: an agent below this has not competed, and
	// risk/consistency/arcana are recorded as NULL rather than guessed. Same
	// threshold as strategy_score uses, for the same reason — below it there is
	// conduct to describe but not enough to judge.
	minParticipationDecisions = 5
	// minExposure: floor on the exposure divisor, for numerical safety ONLY.
	// Without it an agent holding ~100% cash divides by ~0 and its normalised
	// volatility explodes to a meaningless number.
	//
	// Deliberately low. At 0.10 the floor sheltered exactly the agent it was
	// meant to expose — a book at 4.1% exposure was judged as though it were at
	// 10%, a 2.4x discount handed to the least committed competitor. The floor
	// should bind only where exposure is essentially zero, and the "did it
	// compete at all" verdict belongs to the participation rule above.
	minExposure = 0.02
)

// Weights inside strategy_score. Turnover carries more because it is the
// clearest tell: an agent declaring buy_and_hold while trading every tick is
// misdescribing itself no matter which direction it trades.
const (
	wStratTurnover  = 0.60
	wStratSellShare = 0.40
)

// strategyProfile is the behaviour a declared strategy_type implies, as bands
// rather than points — there is no single correct turnover for a strategy,
// only a range that is consistent with the claim.
type strategyProfile struct {
	turnoverLo, turnoverHi   float64
	sellShareLo, sellShareHi float64
}

// Expected behaviour per strategy_type. See docs/scoring-formula.md §strategy
// for how these bands were chosen.
var strategyProfiles = map[string]strategyProfile{
	// Buys once, then holds: trading is the exception, selling near-absent.
	"buy_and_hold": {turnoverLo: 0.00, turnoverHi: 0.20, sellShareLo: 0.00, sellShareHi: 0.15},
	// Chases moves and cuts losers: trades often, both directions.
	"momentum": {turnoverLo: 0.35, turnoverHi: 1.00, sellShareLo: 0.15, sellShareHi: 0.65},
	// Buys dips and sells strength: similar cadence, same two-sided mix.
	"mean_reversion": {turnoverLo: 0.25, turnoverHi: 1.00, sellShareLo: 0.15, sellShareHi: 0.65},
}

// AgentContext bundles everything the factor formulas need about one agent.
type AgentContext struct {
	NAVs          []float64 // chronological NAV series (>=1 point)
	DecisionCount int       // total decisions recorded in the season
	// Exposure is the mean fraction of NAV actually held in positions across
	// the season, i.e. 1 - mean(cash/nav). It is what makes risk a measure of
	// judgement rather than of abstention: an idle book is perfectly stable,
	// and stability bought by not participating is not risk management.
	Exposure     float64
	StrategyType string // agent.strategy_type (e.g. momentum, mean_reversion, human)
	// Buys and Sells are counted from the append-only decisions log and drive
	// strategy_score: what the agent actually did, versus what it declared.
	Buys  int
	Sells int
	// CreatorPeerPerformance is the mean performance of the creator's OTHER
	// scored agents from the previous scoring run; nil when not available yet
	// (first run) — creator_score then falls back to neutral.
	CreatorPeerPerformance *float64
}

// Factors holds every computed sub-score (0-100).
type Factors struct {
	Performance float64
	Risk        float64
	Strategy    float64
	Regime      float64
	Consistency float64
	Creator     float64
	Longevity   float64
	// StrategyMultiplier scales the weighted sum (see Arcana). 1.0 means no
	// penalty — either the agent behaved as declared, or it made no checkable
	// claim at all.
	StrategyMultiplier float64
	// Ranked is false for an agent that has not competed enough to be measured.
	// Its risk, consistency and arcana scores are then recorded as NULL — not
	// as neutral 50, which would let a no-show place among real competitors —
	// and the leaderboard leaves it out.
	Ranked bool
}

// Arcana returns the weighted composite score (0-100), scaled by how honestly
// the agent described itself.
//
// strategy is a multiplier rather than a term because describing yourself
// accurately is a baseline expectation, not an achievement: as a weighted term
// it handed every honest agent the same +10 and so ranked nobody, while doing
// its real job — marking the dishonest — only as a rounding error. As a
// multiplier it stays silent when there is nothing wrong and bites when there
// is.
func (f *Factors) Arcana() float64 {
	weighted := wPerformance*f.Performance +
		wRisk*f.Risk +
		wRegime*f.Regime +
		wConsistency*f.Consistency +
		wCreator*f.Creator +
		wLongevity*f.Longevity
	return round1(weighted * f.StrategyMultiplier)
}

// ComputeFactors derives the seven sub-scores from an agent's context.
func ComputeFactors(ctx AgentContext) Factors {
	// strategy_score is still recorded in its column — it is informative on an
	// agent profile — but it no longer adds to the total. It scales it.
	strategy, checkable := strategyScore(ctx)
	multiplier := 1.0
	if checkable {
		multiplier = strategyFloor + (1-strategyFloor)*(strategy/100)
	}

	// An agent that has barely acted cannot be measured on how it handled risk,
	// and a neutral 50 is not a humble answer here — it is a made-up one that
	// still outranks agents who actually competed. Say "not measured" instead.
	ranked := ctx.DecisionCount >= minParticipationDecisions

	f := Factors{
		Ranked:             ranked,
		Strategy:           strategy,
		StrategyMultiplier: multiplier,
		// regime_score: PLACEHOLDER — the market-regime classifier is not
		// implemented (roadmap Mar 2027). Kept neutral & low-weight until then.
		Regime: neutral,
	}

	navs := ctx.NAVs
	tickCount := len(navs)

	// ---- longevity: time-in-competition, measured in recorded ticks. ----
	// A brand-new agent is not punished on performance; this factor only
	// rewards persistence, saturating at longevityTicks.
	f.Longevity = clamp01(float64(tickCount)/longevityTicks) * 100

	// ---- creator: peer-derived reputation (previous run) ----
	// Fall back to neutral for the first run / solo creators.
	if ctx.CreatorPeerPerformance != nil {
		f.Creator = clamp01(*ctx.CreatorPeerPerformance/100) * 100
	} else {
		f.Creator = neutral
	}

	if len(navs) == 0 {
		f.Performance = neutral
		f.Risk = neutral
		f.Consistency = neutral
		return f
	}

	// Per-tick returns (empty for a single point).
	returns := make([]float64, 0, len(navs)-1)
	for i := 1; i < len(navs); i++ {
		if navs[i-1] > 0 {
			returns = append(returns, (navs[i]-navs[i-1])/navs[i-1])
		}
	}

	// ---- performance: total return since the season start ----
	first, last := navs[0], navs[len(navs)-1]
	if first > 0 {
		ret := (last - first) / first
		// Linear mapping: +perfScale => 100, -perfScale => 0, 0% => 50.
		f.Performance = clamp01(0.5+ret/perfScale) * 100
	} else {
		f.Performance = neutral
	}

	// Everything below measures risk PER UNIT OF EXPOSURE.
	//
	// NAV volatility on its own answers "how much did this book move", and a
	// book that was never invested did not move at all — so the raw measure
	// handed its best scores to whoever participated least. Dividing by the
	// fraction actually at stake asks the question that was meant all along:
	// given what this agent put at risk, how well did it handle it?
	//
	// The division cuts both ways, which is the point. An agent that stayed in
	// cash no longer harvests a high score for an idle book, and an agent that
	// was fully invested and wild still divides by ~1 and is still punished.
	exposure := ctx.Exposure
	if exposure < minExposure {
		exposure = minExposure
	}

	// ---- risk: volatility + max drawdown (higher score = lower risk) ----
	if len(returns) >= 1 {
		sd := stddev(returns, mean(returns)) / exposure
		volScore := clamp01(1-sd/volScale) * 100

		maxDD := maxDrawdown(navs) / exposure
		ddScore := clamp01(1-maxDD/ddScale) * 100

		f.Risk = round1(0.5*volScore + 0.5*ddScore)
	} else {
		// Single NAV point — no risk history yet.
		f.Risk = neutral
	}

	// ---- consistency: inverse of return dispersion, per unit of exposure ----
	// Steady growers beat erratic ones — but "steady" has to mean steady for
	// the risk taken, or an untouched portfolio wins by default.
	if len(returns) >= 1 {
		sd := stddev(returns, mean(returns)) / exposure
		f.Consistency = clamp01(1-sd/consistencyScale) * 100
	} else {
		f.Consistency = neutral
	}

	return f
}

// strategyScore measures whether an agent behaved like the strategy it
// declared — not whether that strategy made money, which is what the
// performance and risk factors are for.
//
//	turnover   = trades / decisions          how often it acted at all
//	sellShare  = sells / trades              whether it trades both ways
//
// Each is scored against the band its declared strategy_type implies, and the
// two are combined by the weights above. An agent registered as buy_and_hold
// that rebalances every tick scores near zero: the claim and the conduct do
// not match, and the reputation should say so.
//
// The second return value says whether the score is a verdict at all. When it
// is false the score is a neutral 50 placeholder and the caller must NOT apply
// the multiplier: there was nothing to judge — an unrecognised or human
// strategy_type, or too few decisions to separate intent from noise — and an
// unjudged agent must not be penalised as though it were half-dishonest.
// Neutral is never used to paper over a mismatch we could have measured.
func strategyScore(ctx AgentContext) (float64, bool) {
	profile, known := strategyProfiles[ctx.StrategyType]
	if !known {
		// Includes 'human': a person is under no obligation to trade to a
		// declared pattern, so there is no claim to check.
		return neutral, false
	}
	if ctx.DecisionCount < strategyMinDecisions {
		return neutral, false
	}

	trades := ctx.Buys + ctx.Sells
	turnover := float64(trades) / float64(ctx.DecisionCount)

	// With no trades at all there is no direction to judge; the turnover term
	// already carries the verdict, so hold the sell-share term neutral rather
	// than punishing twice for the same fact.
	sellFit := 1.0
	if trades > 0 {
		sellShare := float64(ctx.Sells) / float64(trades)
		sellFit = bandFit(sellShare, profile.sellShareLo, profile.sellShareHi)
	}

	turnoverFit := bandFit(turnover, profile.turnoverLo, profile.turnoverHi)
	return round1((wStratTurnover*turnoverFit + wStratSellShare*sellFit) * 100), true
}

// bandFit is 1.0 inside [lo,hi] and decays linearly to 0 over
// strategyFitTolerance beyond either edge. A soft edge on purpose: a strategy
// that lands just outside its band is a little off-pattern, not disqualified.
func bandFit(v, lo, hi float64) float64 {
	switch {
	case v < lo:
		return clamp01(1 - (lo-v)/strategyFitTolerance)
	case v > hi:
		return clamp01(1 - (v-hi)/strategyFitTolerance)
	default:
		return 1
	}
}

func (f *Factors) toMap() map[string]*float64 {
	arc := f.Arcana()
	p, r, st := f.Performance, f.Risk, f.Strategy
	re, c, cr, l := f.Regime, f.Consistency, f.Creator, f.Longevity
	out := map[string]*float64{
		"arcana":      &arc,
		"performance": &p,
		"risk":        &r,
		"strategy":    &st,
		"regime":      &re,
		"consistency": &c,
		"creator":     &cr,
		"longevity":   &l,
	}
	if !f.Ranked {
		// NULL, not a number. These three are the ones that require having
		// competed; the rest (performance, longevity, creator, strategy) still
		// describe the agent and stay on its profile. The leaderboard filters
		// NULL, so an agent that has not competed simply does not appear —
		// rather than placing above those who did.
		out["arcana"] = nil
		out["risk"] = nil
		out["consistency"] = nil
	}
	return out
}

// --- math helpers ---

// maxDrawdown returns the largest peak-to-trough decline in a NAV series.
func maxDrawdown(navs []float64) float64 {
	peak := navs[0]
	maxDD := 0.0
	for _, v := range navs {
		if v > peak {
			peak = v
		}
		if peak > 0 {
			dd := (peak - v) / peak
			if dd > maxDD {
				maxDD = dd
			}
		}
	}
	return maxDD
}

func mean(xs []float64) float64 {
	s := 0.0
	for _, x := range xs {
		s += x
	}
	return s / float64(len(xs))
}

func stddev(xs []float64, m float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	s := 0.0
	for _, x := range xs {
		d := x - m
		s += d * d
	}
	return math.Sqrt(s / float64(len(xs)))
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func round1(v float64) float64 {
	return math.Round(v*10) / 10
}
