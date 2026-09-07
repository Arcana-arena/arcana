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
//	performance 0.30  — return is the primary signal
//	risk        0.20  — drawdown & volatility hurt
//	consistency 0.15  — steady growers beat erratic ones
//	strategy    0.10  — proxy is weak in V1, kept low
//	regime      0.10  — classifier absent (Mar 2027 roadmap), low weight
//	creator     0.05  — peer-derived, low until creator scoring matures
//	longevity   0.10  — time-in-competition reward
const (
	wPerformance = 0.30
	wRisk        = 0.20
	wConsistency = 0.15
	wStrategy    = 0.10
	wRegime      = 0.10
	wCreator     = 0.05
	wLongevity   = 0.10
)

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
	consistencyScale = 0.02
	// longevityTicks: tick count at which longevity saturates at 100.
	longevityTicks = 20.0
)

// AgentContext bundles everything the factor formulas need about one agent.
type AgentContext struct {
	NAVs        []float64 // chronological NAV series (>=1 point)
	DecisionCount int     // total decisions recorded in the season
	StrategyType string   // agent.strategy_type (e.g. momentum, mean_reversion, human)
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
}

// Arcana returns the weighted composite score (0-100).
func (f *Factors) Arcana() float64 {
	return round1(
		wPerformance*f.Performance +
			wRisk*f.Risk +
			wStrategy*f.Strategy +
			wRegime*f.Regime +
			wConsistency*f.Consistency +
			wCreator*f.Creator +
			wLongevity*f.Longevity,
	)
}

// ComputeFactors derives the seven sub-scores from an agent's context.
func ComputeFactors(ctx AgentContext) Factors {
	f := Factors{
		// strategy_score: PLACEHOLDER — a decision-mix proxy was judged too
		// weak for V1 (every AI agent currently follows the same buy/hold
		// stub). Revisit when real strategies differentiate (see
		// docs/scoring-formula.md §strategy).
		Strategy: neutral,
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
		f.Creator = clamp01(*ctx.CreatorPeerPerformance / 100) * 100
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

	// ---- risk: volatility + max drawdown (higher score = lower risk) ----
	if len(returns) >= 1 {
		sd := stddev(returns, mean(returns))
		volScore := clamp01(1-sd/volScale) * 100

		maxDD := maxDrawdown(navs)
		ddScore := clamp01(1-maxDD/ddScale) * 100

		f.Risk = round1(0.5*volScore + 0.5*ddScore)
	} else {
		// Single NAV point — no risk history yet.
		f.Risk = neutral
	}

	// ---- consistency: inverse of return dispersion ----
	// Stable agents (low per-tick return stdev) score higher than wild
	// up/down swings. A perfectly flat NAV scores 100.
	if len(returns) >= 1 {
		sd := stddev(returns, mean(returns))
		f.Consistency = clamp01(1-sd/consistencyScale) * 100
	} else {
		f.Consistency = neutral
	}

	// An agent that never acted (no decisions) has no meaningful pattern.
	if ctx.DecisionCount == 0 {
		f.Consistency = neutral
	}

	return f
}

func (f *Factors) toMap() map[string]*float64 {
	arc := f.Arcana()
	p, r, st := f.Performance, f.Risk, f.Strategy
	re, c, cr, l := f.Regime, f.Consistency, f.Creator, f.Longevity
	return map[string]*float64{
		"arcana":      &arc,
		"performance": &p,
		"risk":        &r,
		"strategy":    &st,
		"regime":      &re,
		"consistency": &c,
		"creator":     &cr,
		"longevity":   &l,
	}
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
