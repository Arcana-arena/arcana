package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// PortfolioSnapshotScheme names the snapshot manifest format. It is the first
// line of every snapshot manifest.
const PortfolioSnapshotScheme = "arcana-portfolio-snapshot/v1"

// A SNAPSHOT SEAL IS WHAT MAKES A SCORE RECOMPUTABLE FROM DATA NOBODY EDITED.
//
// Performance, risk, consistency and longevity are all computed from the NAV
// series in portfolio_snapshots. A score's arithmetic can be published in full,
// but a recomputation proves nothing if the series underneath it could have
// been rewritten. So each snapshot is sealed when it is written — exactly as a
// decision is — and the seal is anchored on chain with the decisions.
//
// NO SALT, unlike a decision commitment. Everything a snapshot holds is public
// for every agent; there is nothing to hide from a guesser, and a reader must be
// able to rebuild the manifest from the public row.
//
// THE FORMAT follows the decision manifest: the scheme, then `key: value` lines
// in a fixed order. nav and cash are the exact strings written to the numeric
// columns. holdings is a JSON object with sorted keys; JSONB keeps numbers as
// numbers but not their spelling, so a checker compares holdings by value.
type SnapshotManifestInput struct {
	PortfolioID  string
	AgentID      string
	SeasonID     string
	TS           time.Time
	NAV          string
	Cash         string
	Holdings     map[string]any
	PreviousSeal string
}

// BuildSnapshotManifest renders a snapshot manifest. Pure: the same input always
// gives the same bytes.
func BuildSnapshotManifest(in SnapshotManifestInput) string {
	var b strings.Builder
	b.WriteString(PortfolioSnapshotScheme)
	b.WriteByte('\n')
	line := func(key, value string) {
		b.WriteString(key)
		b.WriteString(": ")
		b.WriteString(value)
		b.WriteByte('\n')
	}
	line("portfolio_id", jsonText(in.PortfolioID))
	line("agent_id", jsonText(in.AgentID))
	line("season_id", jsonText(in.SeasonID))
	line("ts", jsonText(in.TS.UTC().Format(TSLayout)))
	line("nav", jsonText(in.NAV))
	line("cash", jsonText(in.Cash))
	line("holdings", holdingsJSON(in.Holdings))
	line("previous_seal", jsonText(in.PreviousSeal))
	return b.String()
}

// holdingsJSON is the holdings as written to the row: {} when empty, never null,
// because the column is NOT NULL and stores '{}'.
func holdingsJSON(m map[string]any) string {
	if len(m) == 0 {
		return "{}"
	}
	out, err := json.Marshal(m)
	if err != nil {
		return jsonText(fmt.Sprintf("unencodable: %v", err))
	}
	return string(out)
}

// WriteSnapshotSealed writes a portfolio snapshot, its manifest and its seal in
// ONE transaction, and returns the seal.
//
// The chain is serialised per portfolio, as the decision chain is per agent: a
// decision cycle and a protective exit for the same book must not both read the
// same "previous seal".
func (s *Store) WriteSnapshotSealed(ctx context.Context, portfolioID, agentID, seasonID string, ts time.Time,
	holdings map[string]any, nav, cash string) (string, error) {
	// The manifest must name the instant the row will hold.
	ts = ts.UTC().Truncate(time.Microsecond)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("seal snapshot: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		"portfolio-chain:"+portfolioID); err != nil {
		return "", fmt.Errorf("seal snapshot: chain lock: %w", err)
	}

	var prev string
	err = tx.QueryRow(ctx,
		`SELECT trim(seal) FROM portfolio_snapshots
		  WHERE portfolio_id = $1 AND seal IS NOT NULL
		  ORDER BY ts DESC LIMIT 1`, portfolioID).Scan(&prev)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("seal snapshot: previous seal: %w", err)
	}

	manifest := BuildSnapshotManifest(SnapshotManifestInput{
		PortfolioID: portfolioID, AgentID: agentID, SeasonID: seasonID, TS: ts,
		NAV: nav, Cash: cash, Holdings: holdings, PreviousSeal: prev,
	})
	seal, err := storeBodyIn(ctx, tx, "portfolio_manifest", manifest)
	if err != nil {
		return "", err
	}

	if holdings == nil {
		holdings = map[string]any{}
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO portfolio_snapshots (portfolio_id, ts, holdings, nav, cash, seal, seal_scheme)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		portfolioID, ts, holdings, nav, cash, seal, PortfolioSnapshotScheme); err != nil {
		return "", fmt.Errorf("seal snapshot: insert: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("seal snapshot: commit: %w", err)
	}
	return seal, nil
}
