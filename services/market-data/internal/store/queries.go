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

// PreviousRef returns the ref of the snapshot immediately preceding the given
// one, or "" when this is the first snapshot on record.
//
// Strategies that react to price movement (momentum, mean reversion) need a
// prior observation to compare against; a point-in-time snapshot alone carries
// no direction. Ordering is by tick_time, not insertion order, so a backfilled
// snapshot still lands in its correct place in the series.
func (s *Store) PreviousRef(ctx context.Context, ref string) (string, error) {
	var prev string
	err := s.pool.QueryRow(ctx, `
		SELECT COALESCE((
		  SELECT p.ref FROM market_snapshots p
		  WHERE p.tick_time < c.tick_time
		  ORDER BY p.tick_time DESC
		  LIMIT 1
		), '')
		FROM market_snapshots c WHERE c.ref = $1`, ref).Scan(&prev)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", fmt.Errorf("snapshot %s not found", ref)
		}
		return "", fmt.Errorf("previous snapshot for %s: %w", ref, err)
	}
	return prev, nil
}

// LatestState returns the most recent snapshot ref and how many snapshots exist.
//
// The count is the simulator's tick index: it advances one per generated
// snapshot regardless of how far apart the ticks fall in wall-clock time, so a
// trend spans the same number of ticks whether the scheduler runs every minute
// or a replay drives it every second. Seeding a trend off wall-clock time would
// make the market's character depend on the cadence of the job that samples it.
//
// Returns ("", 0) when no snapshot exists yet — the first tick of a season.
func (s *Store) LatestState(ctx context.Context) (string, int64, error) {
	var ref string
	var count int64
	err := s.pool.QueryRow(ctx, `
		SELECT COALESCE((SELECT ref FROM market_snapshots ORDER BY tick_time DESC LIMIT 1), ''),
		       (SELECT COUNT(*) FROM market_snapshots)`).Scan(&ref, &count)
	if err != nil {
		return "", 0, fmt.Errorf("latest snapshot state: %w", err)
	}
	return ref, count, nil
}
