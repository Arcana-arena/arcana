package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"
)

// DecisionEvidence is what a decision records about how it was reached.
//
// For a deterministic decider almost all of it is empty, correctly: the
// function and the snapshot are the whole story and it can be replayed. For an
// LLM it IS the story, because it cannot.
type DecisionEvidence struct {
	Decider      string
	Provider     string
	Model        string
	ModelVersion string
	Params       map[string]any
	PromptBody   string
	ResponseBody string
	ReasonCode   string
	Thesis       map[string]any
}

// StoreBody writes an evidence body and returns its hash.
//
// Content-addressed, so the system prompt — byte-identical across every
// decision every agent ever makes — is one row rather than one per tick. The
// market context varies and does not dedupe; that is the real cost, and it is
// the part worth paying for.
//
// ON CONFLICT DO NOTHING is the whole concurrency story: two ticks writing the
// same body race to insert it and the loser does not care, because the row the
// winner wrote is byte-identical by definition of the key.
func (s *Store) StoreBody(ctx context.Context, kind, body string) (string, error) {
	if body == "" {
		return "", nil
	}
	sum := sha256.Sum256([]byte(body))
	h := hex.EncodeToString(sum[:])
	_, err := s.pool.Exec(ctx,
		`INSERT INTO decision_evidence (hash, kind, body, bytes, first_seen_at)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (hash) DO NOTHING`,
		h, kind, body, len(body), time.Now().UTC())
	if err != nil {
		return "", fmt.Errorf("store %s evidence: %w", kind, err)
	}
	return h, nil
}

// AttachEvidence records how a decision was reached, against the decision row.
//
// Called after the decision is appended rather than as part of the same INSERT,
// so that a failure to store evidence can never prevent a decision from being
// recorded. The decision is the thing the platform must not lose; the evidence
// is what explains it. Losing the explanation is bad and is logged loudly.
// Losing the decision would put a hole in an append-only record whose entire
// value is that it has none.
func (s *Store) AttachEvidence(ctx context.Context, decisionID int64, agentID string, ts time.Time, ev DecisionEvidence) error {
	promptHash, err := s.StoreBody(ctx, "prompt", ev.PromptBody)
	if err != nil {
		return err
	}
	responseHash, err := s.StoreBody(ctx, "response", ev.ResponseBody)
	if err != nil {
		return err
	}

	_, err = s.pool.Exec(ctx,
		`UPDATE decisions SET
		   decider = NULLIF($1,''), provider = NULLIF($2,''), model = NULLIF($3,''),
		   model_version = NULLIF($4,''), params = $5,
		   prompt_hash = NULLIF($6,''), response_hash = NULLIF($7,''),
		   reason_code = NULLIF($8,''), thesis = $9
		 WHERE id = $10 AND agent_id = $11 AND ts = $12`,
		ev.Decider, ev.Provider, ev.Model, ev.ModelVersion, jsonOrNil(ev.Params),
		promptHash, responseHash, ev.ReasonCode, jsonOrNil(ev.Thesis),
		decisionID, agentID, ts)
	if err != nil {
		return fmt.Errorf("attach evidence to decision %d: %w", decisionID, err)
	}
	return nil
}

// jsonOrNil keeps an empty map out of the column, so "no thesis" reads as NULL
// rather than as `{}` — an empty object looks like a thesis that said nothing,
// which is a different claim from having made none.
func jsonOrNil(m map[string]any) any {
	if len(m) == 0 {
		return nil
	}
	return m
}
