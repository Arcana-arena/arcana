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
	// Provenance (migration 0021).
	Source      string
	IngestMode  string
	TradingDate *time.Time
	FetchedAt   *time.Time
}

// InsertSnapshot registers a stored snapshot reference.
//
// ON CONFLICT DO NOTHING is what makes the daily retries at 01:00 and 03:00 UTC
// safe: they ask for the same session, derive the same ref, and must confirm
// the existing snapshot rather than duplicate it. A snapshot is immutable, so
// re-inserting one is never an update — it is a no-op by definition.
func (s *Store) InsertSnapshot(ctx context.Context, row *SnapshotRow) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO market_snapshots (
			ref, tick_time, object_key, content_hash, symbol_count, status,
			source, ingest_mode, trading_date, fetched_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (ref) DO NOTHING`,
		row.Ref, row.TickTime, row.ObjectKey, row.ContentHash, row.SymbolCount,
		row.Status, row.Source, row.IngestMode, row.TradingDate, row.FetchedAt)
	if err != nil {
		return fmt.Errorf("insert market snapshot: %w", err)
	}
	return nil
}

const snapshotColumns = `id, ref, tick_time, object_key, content_hash,
	symbol_count, status, source, ingest_mode, trading_date, fetched_at`

func scanSnapshot(row pgx.Row) (*SnapshotRow, error) {
	var r SnapshotRow
	err := row.Scan(&r.ID, &r.Ref, &r.TickTime, &r.ObjectKey, &r.ContentHash,
		&r.SymbolCount, &r.Status, &r.Source, &r.IngestMode, &r.TradingDate, &r.FetchedAt)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// LookupByRef finds a snapshot reference row.
func (s *Store) LookupByRef(ctx context.Context, ref string) (*SnapshotRow, error) {
	row, err := scanSnapshot(s.pool.QueryRow(ctx,
		`SELECT `+snapshotColumns+` FROM market_snapshots WHERE ref = $1`, ref))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("snapshot %s not found", ref)
		}
		return nil, fmt.Errorf("lookup snapshot %s: %w", ref, err)
	}
	return row, nil
}

// FindByTradingDate returns the snapshot already recorded for a session from a
// given source, or nil when there is none.
//
// This is the idempotency check the daily job makes before spending a vendor
// request: the 01:00 and 03:00 retries exist to recover from a failed 23:00
// run, not to re-fetch a session that already succeeded.
func (s *Store) FindByTradingDate(ctx context.Context, source string, date time.Time) (*SnapshotRow, error) {
	row, err := scanSnapshot(s.pool.QueryRow(ctx,
		`SELECT `+snapshotColumns+` FROM market_snapshots
		 WHERE source = $1 AND trading_date = $2`, source, date.Format("2006-01-02")))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("lookup snapshot for %s %s: %w", source, date.Format("2006-01-02"), err)
	}
	return row, nil
}

// PreviousRef returns the ref of the snapshot immediately preceding the given
// one FROM THE SAME SOURCE, or "" when this is the first on record.
//
// Strategies that react to price movement (momentum, mean reversion) need a
// prior observation to compare against; a point-in-time snapshot alone carries
// no direction.
//
// Scoping by `source` is not cosmetic. Simulator snapshots are dated around the
// switchover while backfilled vendor snapshots are dated across the preceding
// months, so ordering by tick_time alone INTERLEAVES the two: a real snapshot's
// "previous" could be a generated one, and an agent would be told the market
// moved by the difference between two unrelated worlds. Scoping keeps each
// series continuous within itself.
//
// Ordering is by tick_time, not insertion order, so a backfilled snapshot still
// lands in its correct place in the series.
func (s *Store) PreviousRef(ctx context.Context, ref string) (string, error) {
	var prev string
	err := s.pool.QueryRow(ctx, `
		SELECT COALESCE((
		  SELECT p.ref FROM market_snapshots p
		  WHERE p.tick_time < c.tick_time
		    AND p.source = c.source
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

// LatestRef returns the most recent snapshot ref from a source, or "" when the
// source has produced none.
//
// Note what is deliberately NOT here any more: the old LatestState returned a
// GLOBAL count of every snapshot ever stored and used it as the simulator's
// tick index. That counter was shared by every season on the host, so a second
// season would have advanced the first one's trend position; and it counted
// rows rather than sessions, so a backfill would have jumped it by sixty. Both
// problems belonged to generating prices. Reading them, the market is simply
// the market — one series per source, indexed by the session it describes —
// and no counter is needed at all.
func (s *Store) LatestRef(ctx context.Context, source string) (string, error) {
	var ref string
	err := s.pool.QueryRow(ctx, `
		SELECT COALESCE((
		  SELECT ref FROM market_snapshots
		  WHERE source = $1
		  ORDER BY tick_time DESC LIMIT 1
		), '')`, source).Scan(&ref)
	if err != nil {
		return "", fmt.Errorf("latest snapshot for %s: %w", source, err)
	}
	return ref, nil
}
