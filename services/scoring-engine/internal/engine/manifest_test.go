package engine

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func inputsFixture() ScoreInputs {
	t0 := time.Date(2026, 9, 10, 1, 0, 0, 123456000, time.UTC)
	navs := []string{"100000.00", "100450.10", "99875.55", "101200.00", "100990.42", "102310.07", "101800.00"}
	cash := []string{"100000.00", "61000.00", "58000.00", "40000.00", "40000.00", "35500.25", "35500.25"}
	var in ScoreInputs
	in.StrategyType = "momentum"
	for i := range navs {
		seal := ""
		if i >= 3 {
			seal = strings.Repeat(string(rune('a'+i)), 64)
		}
		in.NAVSeries = append(in.NAVSeries, NAVPoint{TS: t0.Add(time.Duration(i) * 4 * time.Hour), NAV: navs[i], Cash: cash[i], Seal: seal})
	}
	actions := []string{"buy", "hold", "buy", "sell", "hold", "buy", "sell"}
	for i, a := range actions {
		c := ""
		if i >= 2 {
			c = strings.Repeat(string(rune('0'+i)), 64)
		}
		in.Decisions = append(in.Decisions, DecisionRef{ID: int64(3000 + i), TS: t0.Add(time.Duration(i) * 4 * time.Hour), Action: a, Commitment: c})
	}
	in.CreatorPeers = []PeerScore{
		{AgentID: "44444444-4444-4444-8444-444444444444", SeasonID: "55555555-5555-4555-8555-555555555555", TS: t0, Performance: 61.37},
		{AgentID: "66666666-6666-4666-8666-666666666666", SeasonID: "55555555-5555-4555-8555-555555555555", TS: t0, Performance: 48.02, Seal: strings.Repeat("f", 64)},
	}
	return in
}

var fixtureTS = time.Date(2026, 9, 14, 23, 30, 0, 0, time.UTC)

// parsedManifest is the manifest read back the way a checker reads it.
type parsedManifest struct {
	Formula      string             `json:"formula"`
	AgentID      string             `json:"agent_id"`
	SeasonID     string             `json:"season_id"`
	TS           string             `json:"ts"`
	Constants    map[string]any     `json:"constants"`
	StrategyType string             `json:"strategy_type"`
	NAVSeries    []manifestNAV      `json:"nav_series"`
	Decisions    []manifestDecision `json:"decisions"`
	CreatorPeers []manifestPeer     `json:"creator_peers"`
	Outputs      ManifestOutputs    `json:"outputs"`
	PreviousSeal *string            `json:"previous_seal"`
}

func parse(t *testing.T, body string) parsedManifest {
	t.Helper()
	lines := strings.Split(strings.TrimSuffix(body, "\n"), "\n")
	if lines[0] != ScoreScheme {
		t.Fatalf("first line is %q, not the scheme", lines[0])
	}
	obj := map[string]json.RawMessage{}
	for _, l := range lines[1:] {
		i := strings.Index(l, ": ")
		if i < 0 {
			t.Fatalf("not a key: value line: %q", l)
		}
		obj[l[:i]] = json.RawMessage(l[i+2:])
	}
	raw, _ := json.Marshal(obj)
	var m parsedManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("manifest does not parse: %v", err)
	}
	return m
}

func back(t *testing.T, m parsedManifest) ScoreInputs {
	t.Helper()
	ts := func(s string) time.Time {
		v, err := time.Parse(TSLayout, s)
		if err != nil {
			t.Fatalf("bad ts %q: %v", s, err)
		}
		return v
	}
	str := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	in := ScoreInputs{StrategyType: m.StrategyType}
	for _, p := range m.NAVSeries {
		in.NAVSeries = append(in.NAVSeries, NAVPoint{TS: ts(p.TS), NAV: p.NAV, Cash: p.Cash, Seal: str(p.Seal)})
	}
	for _, d := range m.Decisions {
		in.Decisions = append(in.Decisions, DecisionRef{ID: d.ID, TS: ts(d.TS), Action: d.Action, Commitment: str(d.Commitment)})
	}
	for _, p := range m.CreatorPeers {
		in.CreatorPeers = append(in.CreatorPeers, PeerScore{AgentID: p.AgentID, SeasonID: p.SeasonID, TS: ts(p.TS), Performance: p.Performance, Seal: str(p.Seal)})
	}
	return in
}

func TestScoreManifestIsDeterministic(t *testing.T) {
	in := inputsFixture()
	f := ComputeFactors(ContextFromInputs(in))
	a := BuildScoreManifest("agent", "season", fixtureTS, in, f, "")
	b := BuildScoreManifest("agent", "season", fixtureTS, inputsFixture(), ComputeFactors(ContextFromInputs(inputsFixture())), "")
	if a != b {
		t.Fatal("the same score rendered two different manifests")
	}
	if !strings.HasPrefix(a, ScoreScheme+"\nformula: \""+ScoreFormulaVersion+"\"\n") {
		t.Fatalf("a manifest opens with its scheme and its formula version:\n%s", a[:120])
	}
}

// THE POINT OF THE MANIFEST: what it says, recomputed, is what it recorded.
func TestAManifestRecomputesToItsOwnOutputs(t *testing.T) {
	in := inputsFixture()
	f := ComputeFactors(ContextFromInputs(in))
	m := parse(t, BuildScoreManifest("agent", "season", fixtureTS, in, f, strings.Repeat("9", 64)))

	again := OutputsOf(ComputeFactors(ContextFromInputs(back(t, m))))
	if !reflect.DeepEqual(again, m.Outputs) {
		a, _ := json.Marshal(again)
		b, _ := json.Marshal(m.Outputs)
		t.Fatalf("recomputing from the manifest gave\n%s\nbut the manifest recorded\n%s", a, b)
	}
	if len(InputSeals(in)) != 4+5+1 {
		t.Fatalf("expected 4 snapshot seals, 5 decision commitments and 1 peer seal; got %d", len(InputSeals(in)))
	}
}

// An unranked agent's manifest records null where the row stores NULL.
func TestUnrankedOutputsAreNull(t *testing.T) {
	in := inputsFixture()
	in.Decisions = in.Decisions[:2]
	o := OutputsOf(ComputeFactors(ContextFromInputs(in)))
	if o.Ranked || o.Arcana != nil || o.Risk != nil || o.Consistency != nil {
		t.Fatalf("an agent with 2 decisions must be unranked with null arcana/risk/consistency: %+v", o)
	}
}

// THE PUBLISHED FORMULA IS THE ONE THAT RUNS.
//
// These are the constants and the results of arcana-score-formula/v1 on the
// fixture above. If this fails, the arithmetic or a constant changed: bump
// ScoreFormulaVersion, publish the new version's text and constants in
// agent-service (src/reputation/score-formula.ts), and set the new values here.
// Old manifests keep naming v1 and keep recomputing under v1.
func TestFormulaIsTheOnePublished(t *testing.T) {
	c, _ := json.Marshal(FormulaConstants())
	sum := sha256.Sum256(c)
	got := hex.EncodeToString(sum[:])
	o, _ := json.Marshal(OutputsOf(ComputeFactors(ContextFromInputs(inputsFixture()))))
	if os.Getenv("PRINT_GOLDEN") != "" {
		t.Logf("constants %s\nconstants sha256 %s\noutputs %s", c, got, o)
		return
	}
	if got != goldenConstantsSHA {
		t.Errorf("constants of %s changed: sha256 %s, published %s\n%s", ScoreFormulaVersion, got, goldenConstantsSHA, c)
	}
	if string(o) != goldenOutputs {
		t.Errorf("results of %s changed on the fixture:\n got %s\nwant %s", ScoreFormulaVersion, o, goldenOutputs)
	}
}
