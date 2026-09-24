package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// CapitalMandateRow is an agent's capital_mandates row.
type CapitalMandateRow struct {
	AgentID              string
	MarketID             string
	MinHealthFactor      float64
	MaxBorrowRateBps     int
	LiquidityTriggerUSDG float64
	MaxBorrowUSDG        float64
	NeverSell            []string
	Status               string
}

// CapitalMandate returns the agent's mandate, or nil when it has none.
func (s *Store) CapitalMandate(ctx context.Context, agentID string) (*CapitalMandateRow, error) {
	var m CapitalMandateRow
	err := s.pool.QueryRow(ctx,
		`SELECT agent_id::text, market_id, min_health_factor::float8, max_borrow_rate_bps,
		        liquidity_trigger_usdg::float8, max_borrow_usdg::float8, never_sell, status
		   FROM capital_mandates WHERE agent_id = $1`, agentID).
		Scan(&m.AgentID, &m.MarketID, &m.MinHealthFactor, &m.MaxBorrowRateBps,
			&m.LiquidityTriggerUSDG, &m.MaxBorrowUSDG, &m.NeverSell, &m.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("capital mandate for %s: %w", agentID, err)
	}
	return &m, nil
}

// CapitalActionRow is a capital_actions insert.
type CapitalActionRow struct {
	AgentID, MarketID, Decider, Kind string
	Amount                           float64
	ReasonCode, Why                  string
	Evidence                         map[string]any
	Status                           string
	RefusalCode, RefusalDetail       string
	TxHash, ApproveTxHash            string
}

func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func (s *Store) InsertCapitalAction(ctx context.Context, r CapitalActionRow) (int64, error) {
	ev, err := json.Marshal(r.Evidence)
	if err != nil {
		return 0, fmt.Errorf("capital action evidence: %w", err)
	}
	var id int64
	err = s.pool.QueryRow(ctx,
		`INSERT INTO capital_actions
		   (agent_id, market_id, decider, kind, amount, reason_code, why, evidence, status,
		    refusal_code, refusal_detail, tx_hash, approve_tx_hash)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13) RETURNING id`,
		r.AgentID, r.MarketID, r.Decider, r.Kind, r.Amount, r.ReasonCode, r.Why, string(ev), r.Status,
		nullIfEmpty(r.RefusalCode), nullIfEmpty(r.RefusalDetail), nullIfEmpty(r.TxHash), nullIfEmpty(r.ApproveTxHash)).
		Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("insert capital action: %w", err)
	}
	return id, nil
}

// LastCapitalReason is the reason and kind of the agent's latest capital row,
// so a hold that repeats the previous row can be left unwritten.
func (s *Store) LastCapitalReason(ctx context.Context, agentID string) (kind, reason string, err error) {
	err = s.pool.QueryRow(ctx,
		`SELECT kind, reason_code FROM capital_actions WHERE agent_id = $1 ORDER BY ts DESC, id DESC LIMIT 1`,
		agentID).Scan(&kind, &reason)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", nil
	}
	return kind, reason, err
}
