// Execution state for the LP money path.
//
// THE QUEUE HAS TWO WRITERS NOW, AND THEY OWN DIFFERENT THINGS. The arbitrage
// loop writes the observations — proposals, their numbers, supersession — and
// this service writes only the execution lifecycle: one atomic claim, the
// per-intent steps, and the final verdict. Nothing here touches what a
// proposal MEANS; it records what was done about it.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// LPOpen is one recorded position open — the audit row for an `lpexec --open`.
type LPOpen struct {
	AgentID string
	Symbol  string
	Pool    string
	TokenID string
	TxHash  string
	SizeUSD float64
	Status  string
	Error   string
	Plan    json.RawMessage
	TS      time.Time
}

// RecordLPOpen appends one open. Append-only: an open happened once; a later
// failure is its own row, never an edit of this one.
func (s *Store) RecordLPOpen(ctx context.Context, o LPOpen) error {
	var tokenArg, hashArg, errArg any
	if o.TokenID != "" {
		tokenArg = o.TokenID
	}
	if o.TxHash != "" {
		hashArg = o.TxHash
	}
	if o.Error != "" {
		errArg = o.Error
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO lp_opens (agent_id, symbol, pool, token_id, tx_hash, size_usd, status, error, plan)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
		o.AgentID, o.Symbol, o.Pool, tokenArg, hashArg, o.SizeUSD, o.Status, errArg, string(o.Plan))
	if err != nil {
		return fmt.Errorf("record lp open %s: %w", o.Symbol, err)
	}
	return nil
}

// ClaimLPAction moves one proposed action to executing, atomically.
//
// The conditional UPDATE is the whole overlap protection: two executors (a
// timer run and an operator) cannot both act on one proposal, because only one
// UPDATE ... WHERE status='proposed' can match. Claiming before doing anything
// else is also what makes the record honest: an action that is being executed
// is visible as executing, and one that was never claimed is visibly still
// proposed.
func (s *Store) ClaimLPAction(ctx context.Context, id int64) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE lp_position_actions
		SET status = 'executing', started_at = now()
		WHERE id = $1 AND status = 'proposed'`, id)
	if err != nil {
		return false, fmt.Errorf("claim lp action %d: %w", id, err)
	}
	return tag.RowsAffected() == 1, nil
}

// FinishLPAction writes the verdict. Only an executing action can be finished,
// so a lost claim cannot be overwritten by a stale runner.
func (s *Store) FinishLPAction(ctx context.Context, id int64, status, errMsg string) error {
	var errArg any
	if errMsg != "" {
		errArg = errMsg
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE lp_position_actions
		SET status = $2, finished_at = now(), error = $3
		WHERE id = $1 AND status = 'executing'`, id, status, errArg)
	if err != nil {
		return fmt.Errorf("finish lp action %d: %w", id, err)
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("finish lp action %d: it is not in 'executing' — the claim was lost", id)
	}
	return nil
}

// RecordLPStep upserts one intent's outcome. The same (action, step) is written
// twice — once at broadcast with the hash, once with the receipt's verdict —
// which is why this is an upsert rather than an append: a crash between them
// must leave the hash, not half a row and no hash.
func (s *Store) RecordLPStep(ctx context.Context, actionID int64, step int, intent, status, txHash, gasUsed, errMsg string) error {
	var hashArg, gasArg, errArg any
	if txHash != "" {
		hashArg = txHash
	}
	if gasUsed != "" {
		gasArg = gasUsed
	}
	if errMsg != "" {
		errArg = errMsg
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO lp_execution_steps (action_id, step, intent, status, tx_hash, gas_used, error)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (action_id, step) DO UPDATE
		  SET ts = now(), intent = EXCLUDED.intent, status = EXCLUDED.status,
		      tx_hash = COALESCE(EXCLUDED.tx_hash, lp_execution_steps.tx_hash),
		      gas_used = COALESCE(EXCLUDED.gas_used, lp_execution_steps.gas_used),
		      error = EXCLUDED.error`,
		actionID, step, intent, status, hashArg, gasArg, errArg)
	if err != nil {
		return fmt.Errorf("record lp step %d of action %d: %w", step, actionID, err)
	}
	return nil
}
