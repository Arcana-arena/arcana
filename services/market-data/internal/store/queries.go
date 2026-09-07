package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// SnapshotRow mirrors the market_snapshots table.
type SnapshotRow struct {
	ID          string
	Ref         string
	TickTime    time.Time
	ObjectKey   string
	ContentHash string
	SymbolCount int
	Status      string
}

// InsertSnapshot registers a stored snapshot reference.
func (s *Store) InsertSnapshot(ctx context.Context, row *SnapshotRow) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO market_snapshots (ref, tick_time, object_key, content_hash, symbol_count, status)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (ref) DO NOTHING`,
		row.Ref, row.TickTime, row.ObjectKey, row.ContentHash, row.SymbolCount, row.Status)
	if err != nil {
		return fmt.Errorf("insert market snapshot: %w", err)
	}
	return nil
}

// LookupByRef finds a snapshot reference row.
func (s *Store) LookupByRef(ctx context.Context, ref string) (*SnapshotRow, error) {
	var row SnapshotRow
	err := s.pool.QueryRow(ctx, `
		SELECT id, ref, tick_time, object_key, content_hash, symbol_count, status
		FROM market_snapshots WHERE ref = $1`, ref).Scan(
		&row.ID, &row.Ref, &row.TickTime, &row.ObjectKey,
		&row.ContentHash, &row.SymbolCount, &row.Status)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("snapshot %s not found", ref)
		}
		return nil, fmt.Errorf("lookup snapshot %s: %w", ref, err)
	}
	return &row, nil
}
