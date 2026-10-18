// Package store persists arbitrage scan results.
package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Store wraps a pgx pool.
type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// NewPool builds a pgx connection pool from a DATABASE_URL.
func NewPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return pool, nil
}

// OpportunityRow is one token's cross-venue reading in a scan.
//
// BuyPrice and SellPrice are already fee-adjusted (the buy venue's fee is baked
// into BuyPrice, the sell venue's into SellPrice), so GrossSpreadBps is the
// spread net of both fees. EstNetProfitBps then removes gas and the impact
// buffer. The two liquidity columns are raw uint128 decimal strings, kept for
// audit rather than arithmetic.
type OpportunityRow struct {
	Symbol           string    `json:"symbol"`
	VenueBuy         string    `json:"venue_buy"`
	VenueSell        string    `json:"venue_sell"`
	BuyPrice         float64   `json:"buy_price"`
	SellPrice        float64   `json:"sell_price"`
	GrossSpreadBps   float64   `json:"gross_spread_bps"`
	EstNetProfitBps  float64   `json:"est_net_profit_bps"`
	FeeBuyBps        int       `json:"fee_buy_bps"`
	FeeSellBps       int       `json:"fee_sell_bps"`
	GasBps           float64   `json:"gas_bps"`
	ImpactBufferBps  float64   `json:"impact_buffer_bps"`
	ReferenceSizeUSD float64   `json:"reference_size_usd"`
	LiquidityBuy     string    `json:"liquidity_buy"`
	LiquiditySell    string    `json:"liquidity_sell"`
	Status           string    `json:"status"`
	TS               time.Time `json:"ts"`
}

// InsertOpportunity appends one row at ts. Append-only, like every other
// observation table in this project: a scan never edits an earlier scan's
// reading. ts is shared across a scan's rows so the "latest scan" query can
// group them with one max(ts) rather than matching only the last-inserted row.
func (s *Store) InsertOpportunity(ctx context.Context, ts time.Time, o OpportunityRow) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO arbitrage_opportunities
		  (ts, symbol, venue_buy, venue_sell, buy_price, sell_price, gross_spread_bps,
		   est_net_profit_bps, fee_buy_bps, fee_sell_bps, gas_bps, impact_buffer_bps,
		   reference_size_usd, liquidity_buy, liquidity_sell, status)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
		ts,
		o.Symbol, o.VenueBuy, o.VenueSell, o.BuyPrice, o.SellPrice, o.GrossSpreadBps,
		o.EstNetProfitBps, o.FeeBuyBps, o.FeeSellBps, o.GasBps, o.ImpactBufferBps,
		o.ReferenceSizeUSD, o.LiquidityBuy, o.LiquiditySell, o.Status)
	if err != nil {
		return fmt.Errorf("insert opportunity %s: %w", o.Symbol, err)
	}
	return nil
}

// Heartbeat writes the scanner's single-row heartbeat. A scanner that ran and
// found nothing, and one that died, are told apart by the absence of this row
// being fresh — the same rule the position guard follows.
func (s *Store) Heartbeat(ctx context.Context, count int, errMsg string) error {
	var errArg any
	if errMsg != "" {
		errArg = errMsg
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO arbitrage_scan_heartbeat (id, last_scan_at, opportunities, error)
		VALUES (1, now(), $1, $2)
		ON CONFLICT (id) DO UPDATE
		  SET last_scan_at = now(), opportunities = $1, error = $2`,
		count, errArg)
	if err != nil {
		return fmt.Errorf("heartbeat: %w", err)
	}
	return nil
}

// LatestOpportunities returns the most recent scan's rows, sorted by symbol.
// An empty result means no scan has run yet — a distinct fact from a scan that
// ran and found nothing, which the heartbeat records.
func (s *Store) LatestOpportunities(ctx context.Context) ([]OpportunityRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT symbol, venue_buy, venue_sell, buy_price, sell_price, gross_spread_bps,
		       est_net_profit_bps, fee_buy_bps, fee_sell_bps, gas_bps, impact_buffer_bps,
		       reference_size_usd, liquidity_buy, liquidity_sell, status, ts
		FROM arbitrage_opportunities
		WHERE ts = (SELECT max(ts) FROM arbitrage_opportunities)
		ORDER BY symbol`)
	if err != nil {
		return nil, fmt.Errorf("latest opportunities: %w", err)
	}
	defer rows.Close()
	return scanRows(rows)
}

// RecentOpportunities returns the last N rows across scans.
func (s *Store) RecentOpportunities(ctx context.Context, limit int) ([]OpportunityRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT symbol, venue_buy, venue_sell, buy_price, sell_price, gross_spread_bps,
		       est_net_profit_bps, fee_buy_bps, fee_sell_bps, gas_bps, impact_buffer_bps,
		       reference_size_usd, liquidity_buy, liquidity_sell, status, ts
		FROM arbitrage_opportunities
		ORDER BY ts DESC, id DESC
		LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("recent opportunities: %w", err)
	}
	defer rows.Close()
	return scanRows(rows)
}

type rowScanner interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
}

func scanRows(rows rowScanner) ([]OpportunityRow, error) {
	out := []OpportunityRow{}
	for rows.Next() {
		var o OpportunityRow
		if err := rows.Scan(
			&o.Symbol, &o.VenueBuy, &o.VenueSell, &o.BuyPrice, &o.SellPrice,
			&o.GrossSpreadBps, &o.EstNetProfitBps, &o.FeeBuyBps, &o.FeeSellBps,
			&o.GasBps, &o.ImpactBufferBps, &o.ReferenceSizeUSD,
			&o.LiquidityBuy, &o.LiquiditySell, &o.Status, &o.TS,
		); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
