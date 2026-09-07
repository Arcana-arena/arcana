package engine

import (
	"math"
	"strconv"
)

// Weights for the composite ARCANA Score (V1).
// Strategy/regime/creator remain neutral until their data sources exist.
var weights = map[string]float64{
	"performance": 0.30,
	"risk":        0.15,
	"strategy":    0.15,
	"regime":      0.10,
	"consistency": 0.20,
	"creator":     0.00,
	"longevity":   0.10,
}

const neutral = 50.0

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

// Arcana returns the weighted composite score.
func (f *Factors) Arcana() float64 {
	return round1(
		weights["performance"]*f.Performance +
			weights["risk"]*f.Risk +
			weights["strategy"]*f.Strategy +
			weights["regime"]*f.Regime +
			weights["consistency"]*f.Consistency +
			weights["creator"]*f.Creator +
			weights["longevity"]*f.Longevity,
	)
}

// ComputeFactors derives sub-scores from NAV observations.
// navs: chronological NAV series (>=1 point). meta: agent age + creator rep.
func ComputeFactors(navs []float64, ageDays float64, creatorRep float64, decisionCount int) Factors {
	f := Factors{
		Risk:     neutral, // risk metrics not wired yet
		Strategy: neutral, // strategy quality scoring not wired yet
		Regime:   neutral, // regime classifier not wired yet
	}

	// Creator reputation scaled to 0-100 (raw numeric, typically 0-5k+).
	// Soft cap at 100 for readability; real creator scoring comes later.
	f.Creator = math.Min(creatorRep, 100)

	// Longevity: agents earn score with age, saturating around 365 days.
	if ageDays >= 365 {
		f.Longevity = 100
	} else if ageDays <= 0 {
		f.Longevity = 0
	} else {
		f.Longevity = round1(ageDays / 365 * 100)
	}

	if len(navs) == 0 {
		f.Performance = neutral
		f.Consistency = neutral
		return f
	}

	// Performance: total return from first to last NAV, mapped 0-100.
	first := navs[0]
	last := navs[len(navs)-1]
	if first > 0 {
		ret := (last - first) / first
		f.Performance = clamp01(ret/0.5)*100 // +50% => 100, -50% => 0
	}

	// Consistency: inverse of NAV volatility (coefficient of variation).
	if len(navs) >= 2 {
		mean := mean(navs)
		if mean > 0 {
			cv := stddev(navs, mean) / mean
			f.Consistency = clamp01(1-cv/0.1) * 100
		}
	} else {
		f.Consistency = neutral
	}

	// Decision activity nudges consistency toward neutral if nearly none.
	if decisionCount == 0 {
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

// mustParse converts a NUMERIC string to float64, ignoring parse errors (0).
func mustParse(s string) float64 {
	if v, err := strconv.ParseFloat(s, 64); err == nil {
		return v
	}
	return 0
}

func mean(xs []float64) float64 {
	s := 0.0
	for _, x := range xs {
		s += x
	}
	return s / float64(len(xs))
}

func stddev(xs []float64, m float64) float64 {
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
