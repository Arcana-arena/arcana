package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// AGENT CREDIT (architecture.md §18): the rows the reputation is derived from,
// and the rows it is written to. Nothing here decides anything; package credit
// does, and the engine carries the answer.

// CapitalScanCursor is the last block whose Liquidate events have been written
// for a market. ok is false when the market has never been scanned.
func (s *Store) CapitalScanCursor(ctx context.Context, marketID string) (block uint64, ok bool, err error) {
	var b int64
	err = s.pool.QueryRow(ctx, `SELECT block_number FROM capital_scan_cursors WHERE market_id = $1`, marketID).Scan(&b)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("capital scan cursor for %s: %w", marketID, err)
	}
	return uint64(b), true, nil
}

func (s *Store) SetCapitalScanCursor(ctx context.Context, marketID string, block uint64) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO capital_scan_cursors (market_id, block_number) VALUES ($1, $2)
		 ON CONFLICT (market_id) DO UPDATE SET block_number = EXCLUDED.block_number, updated_at = now()`,
		marketID, int64(block))
	if err != nil {
		return fmt.Errorf("set capital scan cursor for %s: %w", marketID, err)
	}
	return nil
}

// CapitalLiquidationRow is a capital_liquidations insert.
type CapitalLiquidationRow struct {
	AgentID, MarketID, Wallet, TxHash, Liquidator string
	TS                                            time.Time
	Block                                         uint64
	LogIndex                                      int
	RepaidUSDG, SeizedQty, BadDebtUSDG            float64
}

// InsertCapitalLiquidation writes one event. The same event read twice is
// written once: inserted is false the second time.
func (s *Store) InsertCapitalLiquidation(ctx context.Context, r CapitalLiquidationRow) (inserted bool, err error) {
	tag, err := s.pool.Exec(ctx,
		`INSERT INTO capital_liquidations
		   (agent_id, market_id, wallet, ts, block_number, tx_hash, log_index, liquidator, repaid_usdg, seized_qty, bad_debt_usdg)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		 ON CONFLICT (tx_hash, log_index) DO NOTHING`,
		r.AgentID, r.MarketID, r.Wallet, r.TS, int64(r.Block), r.TxHash, r.LogIndex, r.Liquidator,
		r.RepaidUSDG, r.SeizedQty, r.BadDebtUSDG)
	if err != nil {
		return false, fmt.Errorf("insert capital liquidation: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// CreditAgents is every agent that has ever owed anything: the only ones with
// a capital record to build a reputation from.
func (s *Store) CreditAgents(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT DISTINCT agent_id::text FROM capital_positions WHERE debt_usdg > 0 ORDER BY 1`)
	if err != nil {
		return nil, fmt.Errorf("credit agents: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// CapitalReadingRow is one capital_positions row, as far as a cycle needs it.
type CapitalReadingRow struct {
	MarketID string
	TS       time.Time
	Debt     float64
	HFWorst  *float64
}

// CapitalReadings is every reading of an agent's positions, oldest first.
func (s *Store) CapitalReadings(ctx context.Context, agentID string) ([]CapitalReadingRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT market_id, ts, debt_usdg::float8, health_factor_worst::float8
		   FROM capital_positions WHERE agent_id = $1 ORDER BY ts ASC, id ASC`, agentID)
	if err != nil {
		return nil, fmt.Errorf("capital readings for %s: %w", agentID, err)
	}
	defer rows.Close()
	var out []CapitalReadingRow
	for rows.Next() {
		var r CapitalReadingRow
		if err := rows.Scan(&r.MarketID, &r.TS, &r.Debt, &r.HFWorst); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// CapitalEventRow is a capital_actions row that bears on a cycle. Kind is
// "borrow", "repay", "deleverage" or "stuck".
type CapitalEventRow struct {
	MarketID string
	TS       time.Time
	Kind     string
	Amount   float64
	// For a deleverage step: whether it repaid debt (its amount is USDG) rather
	// than sold or withdrew collateral.
	Repaid bool
}

// CapitalEvents is every mined borrow, repay and deleverage step of an agent,
// and every time the guard recorded that it could not deleverage.
func (s *Store) CapitalEvents(ctx context.Context, agentID string) ([]CapitalEventRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT market_id, ts,
		        CASE WHEN reason_code = 'deleverage_stuck' THEN 'stuck' ELSE kind END,
		        amount::float8, reason_code = 'deleverage_repay'
		   FROM capital_actions
		  WHERE agent_id = $1
		    AND ((status = 'mined' AND kind IN ('borrow', 'repay', 'deleverage')) OR reason_code = 'deleverage_stuck')
		  ORDER BY ts ASC, id ASC`, agentID)
	if err != nil {
		return nil, fmt.Errorf("capital events for %s: %w", agentID, err)
	}
	defer rows.Close()
	var out []CapitalEventRow
	for rows.Next() {
		var r CapitalEventRow
		if err := rows.Scan(&r.MarketID, &r.TS, &r.Kind, &r.Amount, &r.Repaid); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// CapitalLiquidationTimes is when each of an agent's liquidations happened, by
// market.
func (s *Store) CapitalLiquidationTimes(ctx context.Context, agentID string) (map[string][]time.Time, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT market_id, ts FROM capital_liquidations WHERE agent_id = $1 ORDER BY ts ASC`, agentID)
	if err != nil {
		return nil, fmt.Errorf("capital liquidations for %s: %w", agentID, err)
	}
	defer rows.Close()
	out := map[string][]time.Time{}
	for rows.Next() {
		var m string
		var t time.Time
		if err := rows.Scan(&m, &t); err != nil {
			return nil, err
		}
		out[m] = append(out[m], t)
	}
	return out, rows.Err()
}

// CapitalCycleRow is a capital_cycles insert.
type CapitalCycleRow struct {
	OpenedAt                       time.Time
	ClosedAt                       *time.Time
	PeakDebt, USDGDays             float64
	DebtSeconds, SecondsUnderFloor int64
	LowestHFWorst                  *float64
	Borrowed, Repaid               float64
	Interest                       *float64
	DeleverageSteps, Liquidations  int
	ClosedHow                      *string
}

// ReplaceCapitalCycles rewrites an agent's cycles in one market, in one
// transaction. They are derived from the readings every time, so a cycle row
// can never disagree with the readings it came from.
func (s *Store) ReplaceCapitalCycles(ctx context.Context, agentID, marketID string, cycles []CapitalCycleRow) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("replace capital cycles: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM capital_cycles WHERE agent_id = $1 AND market_id = $2`, agentID, marketID); err != nil {
		return fmt.Errorf("replace capital cycles: %w", err)
	}
	for _, c := range cycles {
		if _, err := tx.Exec(ctx,
			`INSERT INTO capital_cycles
			   (agent_id, market_id, opened_at, closed_at, peak_debt_usdg, usdg_days, debt_seconds, seconds_under_floor,
			    lowest_health_factor_worst, borrowed_usdg, repaid_usdg, interest_usdg, deleverage_steps, liquidations, closed_how)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
			agentID, marketID, c.OpenedAt, c.ClosedAt, c.PeakDebt, c.USDGDays, c.DebtSeconds, c.SecondsUnderFloor,
			c.LowestHFWorst, c.Borrowed, c.Repaid, c.Interest, c.DeleverageSteps, c.Liquidations, c.ClosedHow); err != nil {
			return fmt.Errorf("insert capital cycle: %w", err)
		}
	}
	return tx.Commit(ctx)
}

// ScoredDays is how long the agent has had a published ARCANA Score, in days.
// Zero when it has never been scored.
func (s *Store) ScoredDays(ctx context.Context, agentID string) (float64, error) {
	var days *float64
	err := s.pool.QueryRow(ctx,
		`SELECT extract(epoch FROM now() - min(ts))::float8 / 86400
		   FROM score_snapshots WHERE agent_id = $1 AND arcana_score IS NOT NULL`, agentID).Scan(&days)
	if err != nil {
		return 0, fmt.Errorf("scored days for %s: %w", agentID, err)
	}
	if days == nil {
		return 0, nil
	}
	return *days, nil
}

// CapitalReputationRow is a capital_reputation row.
type CapitalReputationRow struct {
	AgentID            string
	ComputedAt         time.Time
	ConfirmedAt        time.Time
	Rated              bool
	UnratedWhy         string
	Score              *int
	Components, Inputs any
	EarnedTier, Tier   int
	HeldBecause        string
	LimitUSDG          float64
}

// LatestCapitalReputation is the agent's newest reputation, or nil when it has
// none — which is tier 0, not an error.
func (s *Store) LatestCapitalReputation(ctx context.Context, agentID string) (*CapitalReputationRow, error) {
	var r CapitalReputationRow
	var why, held *string
	err := s.pool.QueryRow(ctx,
		`SELECT agent_id::text, computed_at, confirmed_at, rated, unrated_why, score, earned_tier, tier, held_because, limit_usdg::float8
		   FROM capital_reputation WHERE agent_id = $1 ORDER BY computed_at DESC, id DESC LIMIT 1`, agentID).
		Scan(&r.AgentID, &r.ComputedAt, &r.ConfirmedAt, &r.Rated, &why, &r.Score, &r.EarnedTier, &r.Tier, &held, &r.LimitUSDG)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("capital reputation for %s: %w", agentID, err)
	}
	if why != nil {
		r.UnratedWhy = *why
	}
	if held != nil {
		r.HeldBecause = *held
	}
	return &r, nil
}

func (s *Store) InsertCapitalReputation(ctx context.Context, r CapitalReputationRow) error {
	comp, err := json.Marshal(r.Components)
	if err != nil {
		return fmt.Errorf("capital reputation components: %w", err)
	}
	in, err := json.Marshal(r.Inputs)
	if err != nil {
		return fmt.Errorf("capital reputation inputs: %w", err)
	}
	_, err = s.pool.Exec(ctx,
		`INSERT INTO capital_reputation
		   (agent_id, rated, unrated_why, score, components, inputs, earned_tier, tier, held_because, limit_usdg)
		 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10)`,
		r.AgentID, r.Rated, nullIfEmpty(r.UnratedWhy), r.Score, string(comp), string(in),
		r.EarnedTier, r.Tier, nullIfEmpty(r.HeldBecause), r.LimitUSDG)
	if err != nil {
		return fmt.Errorf("insert capital reputation: %w", err)
	}
	return nil
}

// ConfirmCapitalReputation records that a recomputation arrived at the same
// standing as the newest row: it refreshes the working and moves confirmed_at.
// No new row is written, and the row it confirmed does not go stale for having
// been right.
func (s *Store) ConfirmCapitalReputation(ctx context.Context, agentID string, components, inputs any) error {
	comp, err := json.Marshal(components)
	if err != nil {
		return fmt.Errorf("capital reputation components: %w", err)
	}
	in, err := json.Marshal(inputs)
	if err != nil {
		return fmt.Errorf("capital reputation inputs: %w", err)
	}
	_, err = s.pool.Exec(ctx,
		`UPDATE capital_reputation SET confirmed_at = now(), components = $2::jsonb, inputs = $3::jsonb
		  WHERE id = (SELECT id FROM capital_reputation WHERE agent_id = $1 ORDER BY computed_at DESC, id DESC LIMIT 1)`,
		agentID, string(comp), string(in))
	if err != nil {
		return fmt.Errorf("confirm capital reputation for %s: %w", agentID, err)
	}
	return nil
}
