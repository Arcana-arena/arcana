package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// statementTimeoutMS is the wall on the DATABASE side of a batch run.
//
// The engine's context deadlines bound the Go side; they do not stop a query
// Postgres is already executing — and the work of this service is almost
// entirely SQL over the whole record on a 2 GB host. On 2026-10-22 an
// unbounded batch took the machine into swap for about a hundred minutes. A
// statement ceiling is what makes a runaway query a cancelled statement
// instead of a host-wide outage.
//
// 30s against a measured ~5.5s per agent (33 agents in 181s), so it is 5x the
// normal cost and still below the per-agent budget in the engine.
const statementTimeoutMS = "30000"

// NewPool builds a pgx connection pool from a DATABASE_URL.
func NewPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	if _, set := cfg.ConnConfig.RuntimeParams["statement_timeout"]; !set {
		cfg.ConnConfig.RuntimeParams["statement_timeout"] = statementTimeoutMS
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return pool, nil
}
