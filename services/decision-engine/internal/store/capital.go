package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// WalletRow is one agent's chain wallet.
type WalletRow struct {
	AgentID string
	Address string
}

// AllChainWallets is every agent wallet, WHATEVER THE AGENT'S STATUS.
//
// architecture.md §17.4: pausing must not stop watching the debt. The trading
// guard reads active agents only, which costs a paused owner a stop loss; the
// same filter here would cost them a liquidation they believed they had stood
// down from. So there is no status filter, deliberately.
func (s *Store) AllChainWallets(ctx context.Context) ([]WalletRow, error) {
	rows, err := s.pool.Query(ctx, `SELECT agent_id::text, address FROM agent_wallets WHERE address <> '' ORDER BY agent_id`)
	if err != nil {
		return nil, fmt.Errorf("agent wallets: %w", err)
	}
	defer rows.Close()
	var out []WalletRow
	for rows.Next() {
		var w WalletRow
		if err := rows.Scan(&w.AgentID, &w.Address); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// LastCapitalHeld reports whether the agent's latest row in a market recorded
// a position. It is what lets a position that has just been closed get one
// closing row of zeros instead of simply going quiet — quiet reads as "never
// existed" on a page that shows the latest row.
func (s *Store) LastCapitalHeld(ctx context.Context, agentID, marketID string) (bool, error) {
	var held bool
	err := s.pool.QueryRow(ctx,
		`SELECT (collateral_qty > 0 OR debt_usdg > 0) FROM capital_positions
		  WHERE agent_id = $1 AND market_id = $2 ORDER BY ts DESC LIMIT 1`, agentID, marketID).Scan(&held)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil // no row: nothing was held
	}
	if err != nil {
		return false, fmt.Errorf("last capital row for %s: %w", agentID, err)
	}
	return held, nil
}

// CapitalRow is a capital_positions insert.
type CapitalRow struct {
	AgentID, MarketID, Wallet, CollateralSymbol                  string
	CollateralQty, CollateralValue, Debt, LLTV, OraclePrice      float64
	PoolPrice, HealthFactor, HealthFactorWorst, LiquidationPrice *float64
	BaseFeedAge, QuoteFeedAge                                    *int
	OraclePaused                                                 *bool
}

func (s *Store) InsertCapitalPosition(ctx context.Context, r CapitalRow) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO capital_positions
		   (agent_id, market_id, wallet, collateral_symbol, collateral_qty, collateral_value_usdg, debt_usdg,
		    lltv, oracle_price_usdg, pool_price_usdg, health_factor, health_factor_worst, liquidation_price_usdg,
		    base_feed_age_s, quote_feed_age_s, oracle_paused)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
		r.AgentID, r.MarketID, r.Wallet, r.CollateralSymbol, r.CollateralQty, r.CollateralValue, r.Debt,
		r.LLTV, r.OraclePrice, r.PoolPrice, r.HealthFactor, r.HealthFactorWorst, r.LiquidationPrice,
		r.BaseFeedAge, r.QuoteFeedAge, r.OraclePaused)
	if err != nil {
		return fmt.Errorf("insert capital position: %w", err)
	}
	return nil
}
