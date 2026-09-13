package engine

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// ScoreScheme names the score manifest format. It is the first line of every
// score manifest, so a checker never has to guess which rules produced one.
const ScoreScheme = "arcana-score/v1"

// ScoreFormulaVersion names the arithmetic in score.go. Every manifest carries
// it beside the constants that were in force, so a score written today can be
// recomputed next year with today's weights, whatever the weights are by then.
//
// BUMP IT WHENEVER THE ARITHMETIC CHANGES, and publish the new version's text
// (agent-service src/reputation/score-formula.ts). TestFormulaIsTheOnePublished
// fails on a changed constant or a changed result until you do.
const ScoreFormulaVersion = "arcana-score-formula/v1"

// TSLayout is the manifest's timestamp format: UTC, six fractional digits — the
// same layout decision and snapshot manifests use.
const TSLayout = "2006-01-02T15:04:05.000000Z"

// NAVPoint is one portfolio snapshot as the score read it.
type NAVPoint struct {
	TS   time.Time
	NAV  string // the exact numeric text of portfolio_snapshots.nav
	Cash string // the exact numeric text of portfolio_snapshots.cash
	Seal string // "" for a snapshot written before snapshots were sealed
}

// DecisionRef is one decision the score counted.
type DecisionRef struct {
	ID         int64
	TS         time.Time
	Action     string
	Commitment string // "" for a decision written before commitments existed
}

// PeerScore is one score row the creator factor averaged, in the order averaged.
type PeerScore struct {
	AgentID     string
	SeasonID    string
	TS          time.Time
	Performance float64
	Seal        string
}

// ScoreInputs is everything a score is computed from. Nothing else is read.
type ScoreInputs struct {
	StrategyType string
	NAVSeries    []NAVPoint
	Decisions    []DecisionRef
	CreatorPeers []PeerScore
}

// FormulaConstants is every constant the arithmetic reads, taken from the Go
// constants themselves rather than retyped, so the published values cannot
// drift from the ones used.
func FormulaConstants() map[string]any {
	profiles := map[string]any{}
	for name, p := range strategyProfiles {
		profiles[name] = map[string]float64{
			"turnover_lo": p.turnoverLo, "turnover_hi": p.turnoverHi,
			"sell_share_lo": p.sellShareLo, "sell_share_hi": p.sellShareHi,
		}
	}
	return map[string]any{
		"w_performance":               wPerformance,
		"w_risk":                      wRisk,
		"w_consistency":               wConsistency,
		"w_regime":                    wRegime,
		"w_creator":                   wCreator,
		"w_longevity":                 wLongevity,
		"strategy_floor":              strategyFloor,
		"neutral":                     neutral,
		"perf_scale":                  perfScale,
		"vol_scale":                   volScale,
		"dd_scale":                    ddScale,
		"consistency_scale":           consistencyScale,
		"longevity_ticks":             longevityTicks,
		"strategy_min_decisions":      strategyMinDecisions,
		"strategy_fit_tolerance":      strategyFitTolerance,
		"min_participation_decisions": minParticipationDecisions,
		"min_exposure":                minExposure,
		"w_strat_turnover":            wStratTurnover,
		"w_strat_sell_share":          wStratSellShare,
		"strategy_profiles":           profiles,
	}
}

// ContextFromInputs derives the AgentContext exactly as the batch always has:
// NAVs parsed in series order, exposure as the mean invested fraction over
// ticks with a positive NAV, decisions and trades counted from the list, and
// the creator factor's peer mean summed in the order the peers are listed.
//
// It is the ONE derivation. The batch calls it, and a recomputation from a
// manifest calls it, so the two cannot disagree about what the inputs mean.
func ContextFromInputs(in ScoreInputs) AgentContext {
	navs := make([]float64, 0, len(in.NAVSeries))
	exposureSum, exposureTicks := 0.0, 0
	for _, p := range in.NAVSeries {
		nav := mustParse(p.NAV)
		navs = append(navs, nav)
		if nav > 0 {
			invested := (nav - mustParse(p.Cash)) / nav
			if invested < 0 {
				invested = 0
			}
			exposureSum += invested
			exposureTicks++
		}
	}
	exposure := 0.0
	if exposureTicks > 0 {
		exposure = exposureSum / float64(exposureTicks)
	}

	buys, sells := 0, 0
	for _, d := range in.Decisions {
		switch d.Action {
		case "buy":
			buys++
		case "sell":
			sells++
		}
	}

	var peerMean *float64
	if len(in.CreatorPeers) > 0 {
		sum := 0.0
		for _, p := range in.CreatorPeers {
			sum += p.Performance
		}
		m := sum / float64(len(in.CreatorPeers))
		peerMean = &m
	}

	return AgentContext{
		NAVs:                   navs,
		DecisionCount:          len(in.Decisions),
		Exposure:               exposure,
		StrategyType:           in.StrategyType,
		Buys:                   buys,
		Sells:                  sells,
		CreatorPeerPerformance: peerMean,
	}
}

type manifestNAV struct {
	TS   string  `json:"ts"`
	NAV  string  `json:"nav"`
	Cash string  `json:"cash"`
	Seal *string `json:"seal"`
}

type manifestDecision struct {
	ID         int64   `json:"id"`
	TS         string  `json:"ts"`
	Action     string  `json:"action"`
	Commitment *string `json:"commitment"`
}

type manifestPeer struct {
	AgentID     string  `json:"agent_id"`
	SeasonID    string  `json:"season_id"`
	TS          string  `json:"ts"`
	Performance float64 `json:"performance_score"`
	Seal        *string `json:"seal"`
}

// ManifestOutputs is every value the arithmetic produced, at full precision.
// risk, consistency and arcana are null for an unranked agent, exactly as the
// score row stores them.
type ManifestOutputs struct {
	Performance        float64  `json:"performance"`
	Risk               *float64 `json:"risk"`
	Strategy           float64  `json:"strategy"`
	Regime             float64  `json:"regime"`
	Consistency        *float64 `json:"consistency"`
	Creator            float64  `json:"creator"`
	Longevity          float64  `json:"longevity"`
	StrategyMultiplier float64  `json:"strategy_multiplier"`
	Ranked             bool     `json:"ranked"`
	Arcana             *float64 `json:"arcana"`
}

// OutputsOf renders Factors the way the manifest records them.
func OutputsOf(f Factors) ManifestOutputs {
	m := f.toMap()
	return ManifestOutputs{
		Performance: f.Performance, Risk: m["risk"], Strategy: f.Strategy, Regime: f.Regime,
		Consistency: m["consistency"], Creator: f.Creator, Longevity: f.Longevity,
		StrategyMultiplier: f.StrategyMultiplier, Ranked: f.Ranked, Arcana: m["arcana"],
	}
}

// BuildScoreManifest renders a score manifest. Pure: the same inputs and
// outputs always give the same bytes.
//
// The format follows the decision manifest: the scheme, then `key: value` lines
// in a fixed order, every value a JSON literal on one line.
func BuildScoreManifest(agentID, seasonID string, ts time.Time, in ScoreInputs, f Factors, previousSeal string) string {
	nav := make([]manifestNAV, 0, len(in.NAVSeries))
	for _, p := range in.NAVSeries {
		nav = append(nav, manifestNAV{TS: p.TS.UTC().Format(TSLayout), NAV: p.NAV, Cash: p.Cash, Seal: optional(p.Seal)})
	}
	decisions := make([]manifestDecision, 0, len(in.Decisions))
	for _, d := range in.Decisions {
		decisions = append(decisions, manifestDecision{ID: d.ID, TS: d.TS.UTC().Format(TSLayout), Action: d.Action, Commitment: optional(d.Commitment)})
	}
	peers := make([]manifestPeer, 0, len(in.CreatorPeers))
	for _, p := range in.CreatorPeers {
		peers = append(peers, manifestPeer{AgentID: p.AgentID, SeasonID: p.SeasonID, TS: p.TS.UTC().Format(TSLayout), Performance: p.Performance, Seal: optional(p.Seal)})
	}

	var b strings.Builder
	b.WriteString(ScoreScheme)
	b.WriteByte('\n')
	line := func(key string, v any) {
		out, err := json.Marshal(v)
		if err != nil {
			out, _ = json.Marshal(fmt.Sprintf("unencodable: %v", err))
		}
		b.WriteString(key)
		b.WriteString(": ")
		b.Write(out)
		b.WriteByte('\n')
	}
	line("formula", ScoreFormulaVersion)
	line("agent_id", agentID)
	line("season_id", seasonID)
	line("ts", ts.UTC().Format(TSLayout))
	line("constants", FormulaConstants())
	line("strategy_type", in.StrategyType)
	line("nav_series", nav)
	line("decisions", decisions)
	line("creator_peers", peers)
	line("outputs", OutputsOf(f))
	line("previous_seal", optional(previousSeal))
	return b.String()
}

// InputSeals lists every sealed input a score names, once each, by kind.
func InputSeals(in ScoreInputs) [][2]string {
	seen := map[string]bool{}
	var out [][2]string
	add := func(kind, seal string) {
		if seal == "" || seen[kind+seal] {
			return
		}
		seen[kind+seal] = true
		out = append(out, [2]string{kind, seal})
	}
	for _, p := range in.NAVSeries {
		add("portfolio_snapshot", p.Seal)
	}
	for _, d := range in.Decisions {
		add("decision", d.Commitment)
	}
	for _, p := range in.CreatorPeers {
		add("score", p.Seal)
	}
	return out
}

func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
