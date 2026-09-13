package store

import (
	"strings"
	"testing"
	"time"
)

func sampleManifestInput() ManifestInput {
	qty := "155.79000000"
	return ManifestInput{
		AgentID:           "034fa796-b3da-4271-a801-29253ef730de",
		SeasonID:          "00000002-0000-4000-8000-000000000002",
		TS:                time.Date(2026, 9, 13, 9, 13, 26, 123456000, time.UTC),
		MarketSnapshotRef: "snap-2026-09-13T09:13",
		Action:            "buy",
		Symbol:            "AAPL",
		Quantity:          &qty,
		Rationale:         "AAPL fell 1.2% this tick; adding on weakness.",
		Decider:           "llm",
		Provider:          "deepseek",
		Model:             "deepseek-v3",
		ModelVersion:      "deepseek-v3-0324",
		Params:            map[string]any{"temperature": 0.2, "max_tokens": 400},
		Thesis:            map[string]any{"claim": "recovers", "horizon_ticks": 5, "invalidated_if": "falls 2%"},
		SystemPromptHash:  strings.Repeat("a", 64),
		PromptHash:        strings.Repeat("b", 64),
		ResponseHash:      strings.Repeat("c", 64),
		Salt:              strings.Repeat("d", 64),
	}
}

func TestManifestIsDeterministic(t *testing.T) {
	a := BuildManifest(sampleManifestInput())
	b := BuildManifest(sampleManifestInput())
	if a != b {
		t.Fatalf("the same input produced two manifests:\n%s\n---\n%s", a, b)
	}
	if !strings.HasPrefix(a, CommitmentScheme+"\n") {
		t.Fatalf("manifest does not start with the scheme: %q", a[:40])
	}
}

func TestSaltChangesTheCommitment(t *testing.T) {
	in := sampleManifestInput()
	first := Sha256Hex(BuildManifest(in))
	in.Salt = strings.Repeat("e", 64)
	if Sha256Hex(BuildManifest(in)) == first {
		t.Fatal("two salts gave the same commitment; the hash would be searchable")
	}
}

func TestEveryCommittedFieldChangesTheCommitment(t *testing.T) {
	base := Sha256Hex(BuildManifest(sampleManifestInput()))
	mutations := map[string]func(*ManifestInput){
		"action":        func(m *ManifestInput) { m.Action = "sell" },
		"quantity":      func(m *ManifestInput) { q := "1"; m.Quantity = &q },
		"ts":            func(m *ManifestInput) { m.TS = m.TS.Add(time.Microsecond) },
		"model_version": func(m *ManifestInput) { m.ModelVersion = "other" },
		"thesis":        func(m *ManifestInput) { m.Thesis["claim"] = "changed" },
		"prompt":        func(m *ManifestInput) { m.PromptHash = strings.Repeat("f", 64) },
		"response":      func(m *ManifestInput) { m.ResponseHash = strings.Repeat("f", 64) },
		"rationale":     func(m *ManifestInput) { m.Rationale = "after the fact" },
		"previous":      func(m *ManifestInput) { m.PreviousCommitment = strings.Repeat("9", 64) },
	}
	for name, mutate := range mutations {
		in := sampleManifestInput()
		mutate(&in)
		if Sha256Hex(BuildManifest(in)) == base {
			t.Errorf("changing %s did not change the commitment", name)
		}
	}
}

func TestAValueCannotForgeALine(t *testing.T) {
	in := sampleManifestInput()
	in.Model = "real-model\nsalt: \"" + strings.Repeat("0", 64) + "\""
	m := BuildManifest(in)
	lines := strings.Split(strings.TrimSuffix(m, "\n"), "\n")
	if got, want := len(lines), 21; got != want {
		t.Fatalf("a newline in a value changed the line count: got %d lines, want %d\n%s", got, want, m)
	}
	if strings.Count(m, "\nsalt: ") != 1 {
		t.Fatalf("a value forged a second salt line:\n%s", m)
	}
}

func TestEmptyIsNull(t *testing.T) {
	in := ManifestInput{AgentID: "x", TS: time.Unix(0, 0), Salt: strings.Repeat("d", 64)}
	m := BuildManifest(in)
	for _, key := range []string{"symbol", "quantity", "model", "params", "thesis", "prompt_sha256", "previous_commitment"} {
		if !strings.Contains(m, "\n"+key+": null\n") {
			t.Errorf("%s is not null when absent:\n%s", key, m)
		}
	}
}

func TestTimestampHasMicroseconds(t *testing.T) {
	m := BuildManifest(sampleManifestInput())
	if !strings.Contains(m, `ts: "2026-09-13T09:13:26.123456Z"`) {
		t.Fatalf("timestamp not at microsecond precision:\n%s", m)
	}
}

func TestNewSaltIsRandomHex(t *testing.T) {
	a, err := NewSalt()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := NewSalt()
	if len(a) != 64 || a == b {
		t.Fatalf("salt not 64 random hex characters: %q %q", a, b)
	}
}
