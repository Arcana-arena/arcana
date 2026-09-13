package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// insertEvidenceBodySQL is the one statement that writes an evidence body. Both
// StoreBody and the sealed write use it, so "a body, and the hash that names
// it" stays one mechanism however it is reached.
const insertEvidenceBodySQL = `INSERT INTO decision_evidence (hash, kind, body, bytes, first_seen_at)
	 VALUES ($1, $2, $3, $4, $5)
	 ON CONFLICT (hash) DO NOTHING`

// AppendDecisionSealed writes a decision, its evidence and its commitment in ONE
// transaction, and returns the decision id and the commitment.
//
// THE COMMITMENT IS COMPUTED WHEN THE DECISION IS RECORDED, NOT AFTERWARDS. The
// evidence used to be attached by a separate UPDATE once execution and every
// subscriber trade had finished — seconds later, and allowed to fail. A hash
// written that way would prove only that somebody computed it at some point.
// Here the bodies, the manifest and the decision row commit together or not at
// all, and migration 0047 refuses any later attempt to add or alter a seal.
//
// THE CHAIN IS SERIALISED PER AGENT. Each manifest names the agent's previous
// commitment, so two writers for the same agent — a decision cycle and the
// position guard — must not both read the same "previous". A transaction-scoped
// advisory lock on the agent makes them take turns; it is released on commit or
// rollback and cannot be leaked.
func (s *Store) AppendDecisionSealed(ctx context.Context, d DecisionInsert, ev DecisionEvidence) (int64, string, error) {
	// Postgres keeps microseconds. The manifest must name the instant the row
	// will hold, so the value is truncated before either is written.
	d.TS = d.TS.UTC().Truncate(time.Microsecond)

	salt, err := NewSalt()
	if err != nil {
		return 0, "", err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, "", fmt.Errorf("seal decision: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		"decision-chain:"+d.AgentID); err != nil {
		return 0, "", fmt.Errorf("seal decision: chain lock: %w", err)
	}

	systemHash, err := storeBodyIn(ctx, tx, "system_prompt", ev.SystemPromptBody)
	if err != nil {
		return 0, "", err
	}
	promptHash, err := storeBodyIn(ctx, tx, "prompt", ev.PromptBody)
	if err != nil {
		return 0, "", err
	}
	responseHash, err := storeBodyIn(ctx, tx, "response", ev.ResponseBody)
	if err != nil {
		return 0, "", err
	}

	var prev string
	err = tx.QueryRow(ctx,
		`SELECT commitment FROM decisions
		  WHERE agent_id = $1 AND commitment IS NOT NULL
		  ORDER BY id DESC LIMIT 1`, d.AgentID).Scan(&prev)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return 0, "", fmt.Errorf("seal decision: previous commitment: %w", err)
	}

	manifest := BuildManifest(ManifestInput{
		AgentID:            d.AgentID,
		SeasonID:           d.SeasonID,
		TS:                 d.TS,
		MarketSnapshotRef:  d.MarketSnapshotRef,
		Action:             d.Action,
		Symbol:             d.Symbol,
		Quantity:           d.Quantity,
		Rationale:          d.Rationale,
		Decider:            ev.Decider,
		ReasonCode:         ev.ReasonCode,
		Provider:           ev.Provider,
		Model:              ev.Model,
		ModelVersion:       ev.ModelVersion,
		Params:             ev.Params,
		Thesis:             ev.Thesis,
		SystemPromptHash:   systemHash,
		PromptHash:         promptHash,
		ResponseHash:       responseHash,
		PreviousCommitment: prev,
		Salt:               salt,
	})
	commitment, err := storeBodyIn(ctx, tx, "manifest", manifest)
	if err != nil {
		return 0, "", err
	}

	var id int64
	err = tx.QueryRow(ctx,
		`INSERT INTO decisions
		   (agent_id, season_id, ts, market_snapshot_ref, action, symbol, quantity, resulting_allocation, rationale,
		    decider, provider, model, model_version, params, prompt_hash, response_hash, reason_code, thesis,
		    prompt_tokens, completion_tokens, cached_tokens, latency_ms,
		    system_prompt_hash, commitment, commitment_scheme)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
		    NULLIF($10,''), NULLIF($11,''), NULLIF($12,''), NULLIF($13,''), $14,
		    NULLIF($15,''), NULLIF($16,''), NULLIF($17,''), $18,
		    $19, $20, $21, $22,
		    NULLIF($23,''), $24, $25)
		 RETURNING id`,
		d.AgentID, d.SeasonID, d.TS, d.MarketSnapshotRef, d.Action, d.Symbol, d.Quantity,
		d.ResultingAllocation, d.Rationale,
		ev.Decider, ev.Provider, ev.Model, ev.ModelVersion, jsonOrNil(ev.Params),
		promptHash, responseHash, ev.ReasonCode, jsonOrNil(ev.Thesis),
		nilIfZeroInt(ev.PromptTokens), nilIfZeroInt(ev.CompletionTokens),
		nilIfZeroInt(ev.CachedTokens), nilIfZeroInt64(ev.LatencyMS),
		systemHash, commitment, CommitmentScheme,
	).Scan(&id)
	if err != nil {
		return 0, "", fmt.Errorf("seal decision: insert: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, "", fmt.Errorf("seal decision: commit: %w", err)
	}
	return id, commitment, nil
}

// storeBodyIn writes one evidence body inside a transaction and returns its
// hash, or "" for an empty body — the same contract as StoreBody.
func storeBodyIn(ctx context.Context, tx pgx.Tx, kind, body string) (string, error) {
	if body == "" {
		return "", nil
	}
	h := Sha256Hex(body)
	if _, err := tx.Exec(ctx, insertEvidenceBodySQL, h, kind, body, len(body), time.Now().UTC()); err != nil {
		return "", fmt.Errorf("store %s evidence: %w", kind, err)
	}
	return h, nil
}
