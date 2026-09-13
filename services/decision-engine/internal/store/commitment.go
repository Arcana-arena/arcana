package store

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// CommitmentScheme names the manifest format. It is the first line of every
// manifest, so a verifier never has to guess which rules produced one.
const CommitmentScheme = "arcana-commitment/v1"

// A COMMITMENT IS WHAT LETS A DECISION'S REASONING BE PRIVATE AND STILL PROVEN.
//
// A private agent's prompt, raw response, model and thesis are not published.
// What replaces them is this: at the moment the decision row is written, a
// MANIFEST naming everything that produced it is stored as a content-addressed
// evidence blob, and its sha256 — the commitment — is written on the decision
// row in the same statement. The commitment is public for every agent.
//
// Nobody can read the manifest from its hash. Anybody who is later shown the
// manifest and the bodies it names can check, byte for byte, that they are what
// was written down when the decision was made — before its outcome was known.
//
// WHY A MANIFEST AND NOT THE EXISTING prompt_hash. prompt_hash is sha256 of the
// prompt, and a prompt is mostly public: the market table every agent sees, the
// agent's positions, and a mandate that is often a template with a handful of
// parameters. Publishing that hash would let anybody render every template
// against the public inputs until one matched — recovering a private mandate
// from its fingerprint. The manifest carries 32 random bytes of salt, so its
// hash reveals nothing and cannot be searched for.
//
// WHY A BLOB. Evidence bodies have been content-addressed since Phase 6 (see
// StoreBody). The manifest is one more body of a new kind, so there is still
// exactly one mechanism for "a body, and the hash that names it".
//
// THE FORMAT is line-oriented and fixed: the scheme, then `key: value` lines in
// the order below, each ending in \n. Every free-text value is a JSON literal,
// so a model name or rationale containing a newline cannot forge a line. Bodies
// appear by their sha256; everything else appears inline, because JSONB does
// not preserve the bytes of a JSON document and a hash over those bytes could
// never be re-checked from the database.
type ManifestInput struct {
	AgentID           string
	SeasonID          string
	TS                time.Time
	MarketSnapshotRef string
	Action            string
	Symbol            string
	Quantity          *string
	Rationale         string

	Decider      string
	ReasonCode   string
	Provider     string
	Model        string
	ModelVersion string
	Params       map[string]any
	Thesis       map[string]any

	SystemPromptHash string
	PromptHash       string
	ResponseHash     string

	// The commitment of this agent's previous committed decision, or "" for
	// its first. It chains the record: revealing any one manifest pins every
	// commitment before it.
	PreviousCommitment string

	// 64 hex characters from crypto/rand. See NewSalt.
	Salt string
}

// TSLayout is the manifest's timestamp format: UTC, exactly six fractional
// digits. Postgres stores microseconds, so the decision row and the manifest
// name the same instant only if the value is truncated to microseconds before
// either is written — which AppendDecisionSealed does.
const TSLayout = "2006-01-02T15:04:05.000000Z"

// BuildManifest renders the manifest. It is pure: the same input always gives
// the same bytes, which is what makes the commitment checkable at all.
func BuildManifest(in ManifestInput) string {
	var b strings.Builder
	b.WriteString(CommitmentScheme)
	b.WriteByte('\n')
	line := func(key, value string) {
		b.WriteString(key)
		b.WriteString(": ")
		b.WriteString(value)
		b.WriteByte('\n')
	}

	line("agent_id", jsonText(in.AgentID))
	line("season_id", jsonText(in.SeasonID))
	line("ts", jsonText(in.TS.UTC().Format(TSLayout)))
	line("market_snapshot_ref", jsonText(in.MarketSnapshotRef))
	line("action", jsonText(in.Action))
	line("symbol", jsonText(in.Symbol))
	if in.Quantity == nil {
		line("quantity", "null")
	} else {
		line("quantity", jsonText(*in.Quantity))
	}
	line("rationale", jsonText(in.Rationale))
	line("decider", jsonText(in.Decider))
	line("reason_code", jsonText(in.ReasonCode))
	line("provider", jsonText(in.Provider))
	line("model", jsonText(in.Model))
	line("model_version", jsonText(in.ModelVersion))
	line("params", jsonObject(in.Params))
	line("thesis", jsonObject(in.Thesis))
	line("system_prompt_sha256", jsonText(in.SystemPromptHash))
	line("prompt_sha256", jsonText(in.PromptHash))
	line("response_sha256", jsonText(in.ResponseHash))
	line("previous_commitment", jsonText(in.PreviousCommitment))
	line("salt", jsonText(in.Salt))
	return b.String()
}

// Sha256Hex is the one hash used for bodies, manifests and commitments.
func Sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// NewSalt returns 32 random bytes as hex. A failure is returned, never papered
// over with a weaker source: a predictable salt would make a private mandate
// searchable again, which is the one thing the salt exists to prevent.
func NewSalt() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("salt: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

// jsonText is a JSON string literal, or null for "". Empty and absent are the
// same fact on a decision row (the columns are NULLIF'd), so they are the same
// fact here.
func jsonText(s string) string {
	if s == "" {
		return "null"
	}
	out, err := json.Marshal(s)
	if err != nil {
		// json.Marshal cannot fail for a Go string; kept total anyway.
		return "null"
	}
	return string(out)
}

// jsonObject is a JSON object with sorted keys (encoding/json sorts map keys),
// or null when empty — the same NULL-for-empty rule jsonOrNil applies to the
// column.
func jsonObject(m map[string]any) string {
	if len(m) == 0 {
		return "null"
	}
	out, err := json.Marshal(m)
	if err != nil {
		// A value JSON cannot hold (NaN, a channel). Recorded as a string so the
		// manifest still exists and still says something was there.
		return jsonText(fmt.Sprintf("unencodable: %v", err))
	}
	return string(out)
}
