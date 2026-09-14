package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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

// AgentPortfolio couples an agent with its portfolio in a season.
type AgentPortfolio struct {
	AgentID     string
	SeasonID    string
	PortfolioID string
}

// ActiveScorableAgents lists agents that have a portfolio (and thus decisions/snapshots).
func (s *Store) ActiveScorableAgents(ctx context.Context) ([]AgentPortfolio, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT a.id, p.season_id, p.id
		FROM agents a
		JOIN portfolios p ON p.agent_id = a.id
		WHERE a.status = 'active'
		ORDER BY a.id`)
	if err != nil {
		return nil, fmt.Errorf("list scorable agents: %w", err)
	}
	defer rows.Close()

	var out []AgentPortfolio
	for rows.Next() {
		var ap AgentPortfolio
		if err := rows.Scan(&ap.AgentID, &ap.SeasonID, &ap.PortfolioID); err != nil {
			return nil, err
		}
		out = append(out, ap)
	}
	return out, rows.Err()
}

// PortfolioForAgent returns the agent's portfolio in a given season, if any.
func (s *Store) PortfolioForAgent(ctx context.Context, agentID, seasonID string) (*AgentPortfolio, error) {
	var ap AgentPortfolio
	err := s.pool.QueryRow(ctx, `
		SELECT p.agent_id, p.season_id, p.id
		FROM portfolios p
		WHERE p.agent_id = $1 AND p.season_id = $2`,
		agentID, seasonID).Scan(&ap.AgentID, &ap.SeasonID, &ap.PortfolioID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("no portfolio for agent %s in season %s", agentID, seasonID)
		}
		return nil, fmt.Errorf("load portfolio for agent %s: %w", agentID, err)
	}
	return &ap, nil
}

// SnapshotPoint is one NAV observation for a portfolio.
//
// Cash comes along with NAV because risk is meaningless without it: NAV
// movement alone cannot tell a well-managed book from an idle one, and the
// difference between them is how much of the book was actually at stake.
type SnapshotPoint struct {
	TS   time.Time
	NAV  string
	Cash string
	// Seal is "" for a snapshot written before snapshots were sealed (0049).
	Seal string
}

// PortfolioNAVSeries returns all NAV snapshots for a portfolio ordered by time.
//
// nav and cash are read AS TEXT: they go into the score manifest as the
// column's exact spelling. Scanned as numeric, a zero NAV came back "0" while
// the column and the snapshot's own manifest say "0.00".
func (s *Store) PortfolioNAVSeries(ctx context.Context, portfolioID string) ([]SnapshotPoint, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT ts, nav::text, cash::text, coalesce(trim(seal), '') FROM portfolio_snapshots
		WHERE portfolio_id = $1
		ORDER BY ts ASC`, portfolioID)
	if err != nil {
		return nil, fmt.Errorf("load nav series %s: %w", portfolioID, err)
	}
	defer rows.Close()

	var out []SnapshotPoint
	for rows.Next() {
		var p SnapshotPoint
		if err := rows.Scan(&p.TS, &p.NAV, &p.Cash, &p.Seal); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// DecisionRow is one counted decision, as a score's manifest lists it.
type DecisionRow struct {
	ID         int64
	TS         time.Time
	Action     string
	Commitment string // "" before commitments existed (0047)
}

// DecisionsFor lists the decisions a score counts: exactly the rows
// DecisionCount and DecisionMixFor count, in id order, so a manifest can name
// each one and a checker can count them again.
func (s *Store) DecisionsFor(ctx context.Context, agentID, seasonID string) ([]DecisionRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, ts, action, coalesce(trim(commitment), '')
		FROM decisions_counted
		WHERE agent_id = $1 AND season_id = $2
		ORDER BY id`, agentID, seasonID)
	if err != nil {
		return nil, fmt.Errorf("decisions for score: %w", err)
	}
	defer rows.Close()
	var out []DecisionRow
	for rows.Next() {
		var d DecisionRow
		if err := rows.Scan(&d.ID, &d.TS, &d.Action, &d.Commitment); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// InputSeal is one sealed input a score names.
type InputSeal struct {
	Kind string // decision | portfolio_snapshot | score
	Seal string
}

// WriteScoreSnapshotSealed writes a score row, its manifest and its input seals
// in ONE transaction, and returns the seal.
//
// The manifest is built INSIDE the transaction by build, because it names the
// previous seal for this agent and season, which is only known under the chain
// lock. A row that already exists at this (agent, season, ts) is not
// overwritten — the same rule WriteScoreSnapshot follows — and nothing of this
// attempt is kept.
func (s *Store) WriteScoreSnapshotSealed(ctx context.Context, agentID, seasonID string, ts time.Time,
	factors map[string]*float64, build func(previousSeal string) string, inputs []InputSeal) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("seal score: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		"score-chain:"+agentID+":"+seasonID); err != nil {
		return "", fmt.Errorf("seal score: chain lock: %w", err)
	}
	var prev string
	err = tx.QueryRow(ctx, `
		SELECT trim(seal) FROM score_snapshots
		 WHERE agent_id = $1 AND season_id = $2 AND seal IS NOT NULL
		 ORDER BY ts DESC LIMIT 1`, agentID, seasonID).Scan(&prev)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("seal score: previous seal: %w", err)
	}

	manifest := build(prev)
	sum := sha256.Sum256([]byte(manifest))
	seal := hex.EncodeToString(sum[:])
	// The same content-addressed store every decision body and manifest uses.
	if _, err := tx.Exec(ctx,
		`INSERT INTO decision_evidence (hash, kind, body, bytes, first_seen_at)
		 VALUES ($1, 'score_manifest', $2, $3, now())
		 ON CONFLICT (hash) DO NOTHING`, seal, manifest, len(manifest)); err != nil {
		return "", fmt.Errorf("seal score: store manifest: %w", err)
	}

	tag, err := tx.Exec(ctx, `
		INSERT INTO score_snapshots (
			agent_id, season_id, ts, arcana_score,
			performance_score, risk_score, strategy_score, regime_score,
			consistency_score, creator_score, longevity_score, seal, seal_scheme
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'arcana-score/v1')
		ON CONFLICT (agent_id, season_id, ts) DO NOTHING`,
		agentID, seasonID, ts,
		factors["arcana"], factors["performance"], factors["risk"],
		factors["strategy"], factors["regime"], factors["consistency"],
		factors["creator"], factors["longevity"], seal)
	if err != nil {
		return "", fmt.Errorf("seal score: insert: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return "", fmt.Errorf("seal score: a score for agent %s at %s already exists", agentID, ts.Format(time.RFC3339))
	}
	for _, in := range inputs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO score_input_seals (agent_id, season_id, score_ts, input_kind, seal)
			VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
			agentID, seasonID, ts, in.Kind, in.Seal); err != nil {
			return "", fmt.Errorf("seal score: input %s %s: %w", in.Kind, in.Seal, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("seal score: commit: %w", err)
	}
	return seal, nil
}

// AgentMeta describes an agent for scoring.
type AgentMeta struct {
	AgeDays         float64
	CreatorRepScore string
	CreatorID       string
	StrategyType    string
}

// LoadAgentMeta reads agent age, linked creator, and strategy type.
func (s *Store) LoadAgentMeta(ctx context.Context, agentID string) (*AgentMeta, error) {
	var m AgentMeta
	err := s.pool.QueryRow(ctx, `
		SELECT EXTRACT(EPOCH FROM (now() - a.created_at)) / 86400.0,
		       COALESCE(c.reputation_score, 0),
		       COALESCE(c.id::text, ''),
		       COALESCE(a.strategy_type, '')
		FROM agents a
		LEFT JOIN creators c ON c.id = a.creator_id
		WHERE a.id = $1`, agentID).Scan(&m.AgeDays, &m.CreatorRepScore, &m.CreatorID, &m.StrategyType)
	if err != nil {
		return nil, fmt.Errorf("load agent meta %s: %w", agentID, err)
	}
	return &m, nil
}

// DecisionCount returns number of recorded decisions for an agent in a season.
func (s *Store) DecisionCount(ctx context.Context, agentID, seasonID string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM decisions_counted
		WHERE agent_id = $1 AND season_id = $2`, agentID, seasonID).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count decisions: %w", err)
	}
	return n, nil
}

// DecisionMix is the shape of an agent's recorded behaviour: how often it
// traded at all, and how much of that trading was selling. It is everything the
// strategy_score needs, and it comes from the append-only decisions log — the
// agent's actual conduct, never its own claims about itself.
type DecisionMix struct {
	Total int
	Buys  int
	Sells int
}

// Trades is the number of decisions that moved the portfolio.
func (m DecisionMix) Trades() int { return m.Buys + m.Sells }

// DecisionMixFor counts an agent's decisions by action within a season.
func (s *Store) DecisionMixFor(ctx context.Context, agentID, seasonID string) (DecisionMix, error) {
	var m DecisionMix
	err := s.pool.QueryRow(ctx, `
		SELECT COUNT(*),
		       COUNT(*) FILTER (WHERE action = 'buy'),
		       COUNT(*) FILTER (WHERE action = 'sell')
		FROM decisions_counted
		WHERE agent_id = $1 AND season_id = $2`, agentID, seasonID).Scan(&m.Total, &m.Buys, &m.Sells)
	if err != nil {
		return m, fmt.Errorf("decision mix: %w", err)
	}
	return m, nil
}

// WriteScoreSnapshot inserts a score row (idempotent per agent/season/timestamp).
//
// season_id is part of the conflict target, not decoration. The batch scores one
// row per (agent, portfolio), and a portfolio belongs to a season — so an agent
// competing in two seasons produces two rows in the same run with the same ts.
// Under the old `ON CONFLICT (agent_id, ts)` the second was SILENTLY DROPPED:
// the newer season would simply never score, and nothing anywhere would say so.
// Season 2 would have hit this on its first batch run.
func (s *Store) WriteScoreSnapshot(ctx context.Context, agentID, seasonID string, ts time.Time, factors map[string]*float64) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO score_snapshots (
			agent_id, season_id, ts, arcana_score,
			performance_score, risk_score, strategy_score, regime_score,
			consistency_score, creator_score, longevity_score
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (agent_id, season_id, ts) DO NOTHING`,
		agentID, seasonID, ts,
		factors["arcana"], factors["performance"], factors["risk"],
		factors["strategy"], factors["regime"], factors["consistency"],
		factors["creator"], factors["longevity"])
	if err != nil {
		return fmt.Errorf("write score snapshot for %s: %w", agentID, err)
	}
	return nil
}

// ScoreRow is one persisted score snapshot.
type ScoreRow struct {
	AgentID          string    `json:"agent_id"`
	SeasonID         string    `json:"season_id"`
	TS               time.Time `json:"ts"`
	ArcanaScore      *float64  `json:"arcana_score"`
	PerformanceScore *float64  `json:"performance_score"`
	RiskScore        *float64  `json:"risk_score"`
	StrategyScore    *float64  `json:"strategy_score"`
	RegimeScore      *float64  `json:"regime_score"`
	ConsistencyScore *float64  `json:"consistency_score"`
	CreatorScore     *float64  `json:"creator_score"`
	LongevityScore   *float64  `json:"longevity_score"`
}

// LatestScore returns the newest score snapshot for an agent, optionally scoped
// to one season (migration 0022 added the column this needs; the note that used
// to sit here saying per-season filtering was unsupported is now obsolete).
func (s *Store) LatestScore(ctx context.Context, agentID, seasonID string) (*ScoreRow, error) {
	q := `
		SELECT agent_id, season_id, ts, arcana_score, performance_score, risk_score,
		       strategy_score, regime_score, consistency_score, creator_score, longevity_score
		FROM score_snapshots
		WHERE agent_id = $1
		ORDER BY ts DESC LIMIT 1`
	args := []any{agentID}
	if seasonID != "" {
		q = `
		SELECT agent_id, season_id, ts, arcana_score, performance_score, risk_score,
		       strategy_score, regime_score, consistency_score, creator_score, longevity_score
		FROM score_snapshots
		WHERE agent_id = $1 AND season_id = $2
		ORDER BY ts DESC LIMIT 1`
		args = append(args, seasonID)
	}

	var srow ScoreRow
	err := s.pool.QueryRow(ctx, q, args...).Scan(
		&srow.AgentID, &srow.SeasonID, &srow.TS, &srow.ArcanaScore, &srow.PerformanceScore,
		&srow.RiskScore, &srow.StrategyScore, &srow.RegimeScore,
		&srow.ConsistencyScore, &srow.CreatorScore, &srow.LongevityScore,
	)
	if err != nil {
		return nil, fmt.Errorf("latest score for agent %s: %w", agentID, err)
	}
	return &srow, nil
}

// LeaderboardEntry is one agent row on the leaderboard (its latest score).
type LeaderboardEntry struct {
	Rank             int       `json:"rank"`
	AgentID          string    `json:"agent_id"`
	AgentName        string    `json:"agent_name"`
	ArcanaScore      *float64  `json:"arcana_score"`
	PerformanceScore *float64  `json:"performance_score"`
	RiskScore        *float64  `json:"risk_score"`
	ConsistencyScore *float64  `json:"consistency_score"`
	StrategyScore    *float64  `json:"strategy_score"`
	LongevityScore   *float64  `json:"longevity_score"`
	UpdatedAt        time.Time `json:"updated_at"`
	// The season this score was earned in. Present so a cross-season board
	// cannot present two different markets as one ranking.
	SeasonID   string `json:"season_id"`
	SeasonName string `json:"season_name"`
}

// LeaderboardSortColumn maps a leaderboard category to a score column.
// Only columns present in score_snapshots are supported.
var LeaderboardSortColumn = map[string]string{
	"arcana":        "arcana_score",
	"performance":   "performance_score",
	"consistency":   "consistency_score",
	"risk":          "risk_score",
	"risk_adjusted": "risk_score",
	"longevity":     "longevity_score",
	// Rankable since strategy_score became a real measure (2026-09-09); it was
	// omitted while every agent scored an identical placeholder 50.
	"strategy": "strategy_score",
	// Added 2026-09-11. `creator_score` has been a real column and a real factor
	// in the composite since the score existed; it was simply never rankable, so
	// the one dimension measuring the PERSON behind an agent had no board of its
	// own. With users creating their own agents, that is the dimension most
	// worth being able to sort by.
	"creator": "creator_score",
}

// Leaderboard returns the latest score per agent, sorted by the given column.
// When seasonID is non-empty only scores EARNED in that season rank.
//
// Unfiltered, this ranks each agent by its most recent score whichever season
// that came from. Every row therefore carries season_id and season_name: a
// cross-season board compares agents measured in different markets -- Season 1
// ran on simulator prices, Season 2 on real ones -- and that has to be visible
// rather than implied by a rank.
func (s *Store) Leaderboard(ctx context.Context, sortColumn, seasonID string, limit, offset int) ([]LeaderboardEntry, error) {
	// Validate sort column against allow-list to avoid SQL injection.
	if _, ok := LeaderboardSortColumn[sortColumn]; !ok {
		return nil, fmt.Errorf("unsupported leaderboard category: %s", sortColumn)
	}
	col := LeaderboardSortColumn[sortColumn]

	// Scoping by score_snapshots.season_id rather than by joining portfolios
	// (migration 0022). The join answered "did this agent hold a portfolio in
	// that season", which is not the same question as "was this score earned
	// there" — with two seasons it would have shown an agent's Season 2 score on
	// the Season 1 board simply because it competed in both.
	seasonFilter := ""
	args := []any{limit, offset}
	if seasonID != "" {
		seasonFilter = ` WHERE season_id = $3`
		args = append(args, seasonID)
	}

	q := fmt.Sprintf(`
		WITH latest AS (
			-- creator_score is selected here, not just mapped in
			-- LeaderboardSortColumn. Adding the category without adding the
			-- column produced "column l.creator_score does not exist" — the
			-- sort map and this projection are two places that have to agree,
			-- and only one of them was edited.
			SELECT DISTINCT ON (agent_id) agent_id, season_id, ts,
			       arcana_score, performance_score, risk_score,
			       consistency_score, strategy_score, longevity_score,
			       creator_score
			FROM score_snapshots%s
			ORDER BY agent_id, ts DESC
		)
		SELECT l.agent_id, COALESCE(a.name, ''), l.arcana_score,
		       l.performance_score, l.risk_score, l.consistency_score,
		       l.strategy_score, l.longevity_score, l.ts,
		       l.season_id, COALESCE(s.name, '')
		FROM latest l
		LEFT JOIN agents a ON a.id = l.agent_id
		LEFT JOIN seasons s ON s.id = l.season_id
		WHERE l.%s IS NOT NULL
		  -- A NULL arcana_score marks an agent that has not competed enough to
		  -- be measured (see engine.minParticipationDecisions). It is excluded
		  -- from EVERY category, not just the ones it lacks: a no-show placing
		  -- second on longevity would still be a no-show holding a rank that
		  -- belongs to someone who turned up.
		  AND l.arcana_score IS NOT NULL
		ORDER BY l.%s DESC
		LIMIT $1 OFFSET $2`, seasonFilter, col, col)

	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("leaderboard query: %w", err)
	}
	defer rows.Close()

	var out []LeaderboardEntry
	for rows.Next() {
		var e LeaderboardEntry
		if err := rows.Scan(&e.AgentID, &e.AgentName, &e.ArcanaScore,
			&e.PerformanceScore, &e.RiskScore, &e.ConsistencyScore,
			&e.StrategyScore, &e.LongevityScore, &e.UpdatedAt,
			&e.SeasonID, &e.SeasonName); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Rank = offset + i + 1
	}
	return out, nil
}

// ScoreHistory is one point of an agent's score series (for GET score?from=&to=).
type ScoreHistoryPoint struct {
	TS               time.Time `json:"ts"`
	ArcanaScore      *float64  `json:"arcana_score"`
	PerformanceScore *float64  `json:"performance_score"`
	RiskScore        *float64  `json:"risk_score"`
	ConsistencyScore *float64  `json:"consistency_score"`
}

// ScoreHistory returns an agent's score snapshots within [from,to], optionally
// bucketed by day (granularity=daily takes the last snapshot of each day).
// seasonID scopes the series to one season; "" returns every season, which is
// only meaningful when the caller knows the agent competed in one. A chart that
// silently splices a Season 1 score (simulator prices) onto a Season 2 score
// (real prices) draws one line through two different markets.
func (s *Store) ScoreHistory(ctx context.Context, agentID, seasonID string, from, to *time.Time, daily bool) ([]ScoreHistoryPoint, error) {
	args := []any{agentID}
	where := `WHERE agent_id = $1`
	if seasonID != "" {
		args = append(args, seasonID)
		where += fmt.Sprintf(" AND season_id = $%d", len(args))
	}
	if from != nil {
		args = append(args, *from)
		where += fmt.Sprintf(" AND ts >= $%d", len(args))
	}
	if to != nil {
		args = append(args, *to)
		where += fmt.Sprintf(" AND ts <= $%d", len(args))
	}

	q := `SELECT ts, arcana_score, performance_score, risk_score, consistency_score
	      FROM score_snapshots ` + where + ` ORDER BY ts ASC`
	if daily {
		// Bucket by day: DISTINCT ON (ts::date) keeps the first row per day
		// after ordering by date asc, ts desc → the day's latest snapshot.
		q = `SELECT ts, arcana_score, performance_score, risk_score, consistency_score FROM (
		       SELECT DISTINCT ON (ts::date) ts, arcana_score, performance_score,
		              risk_score, consistency_score
		       FROM score_snapshots ` + where + `
		       ORDER BY ts::date ASC, ts DESC
		     ) sub ORDER BY ts ASC`
	}

	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("score history for %s: %w", agentID, err)
	}
	defer rows.Close()

	var out []ScoreHistoryPoint
	for rows.Next() {
		var p ScoreHistoryPoint
		if err := rows.Scan(&p.TS, &p.ArcanaScore, &p.PerformanceScore,
			&p.RiskScore, &p.ConsistencyScore); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// PeerRow is one score row the creator factor averages.
type PeerRow struct {
	AgentID     string
	SeasonID    string
	TS          time.Time
	Performance float64
	Seal        string
}

// CreatorPeerScores returns the performance_score rows of every OTHER active
// agent that belongs to the same creator (used for creator_score), in the order
// the factor averages them.
//
// WHAT THIS ACTUALLY READS, stated because the formula document said "latest":
// every score snapshot those agents have, across every season and every run —
// not the latest one per agent. That is the arithmetic the score has always
// used, and it is left as it is; the manifest now lists each row, so what the
// factor averaged is visible rather than described.
func (s *Store) CreatorPeerScores(ctx context.Context, creatorID, excludeAgentID string) ([]PeerRow, error) {
	if creatorID == "" {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT s.agent_id::text, s.season_id::text, s.ts, s.performance_score, coalesce(trim(s.seal), '')
		FROM score_snapshots s
		JOIN agents a ON a.id = s.agent_id
		WHERE a.creator_id = $1 AND a.id <> $2 AND a.status = 'active'
		ORDER BY s.ts DESC, s.agent_id, s.season_id`, creatorID, excludeAgentID)
	if err != nil {
		return nil, fmt.Errorf("creator peer scores for %s: %w", creatorID, err)
	}
	defer rows.Close()

	var out []PeerRow
	for rows.Next() {
		var r PeerRow
		var v *float64
		if err := rows.Scan(&r.AgentID, &r.SeasonID, &r.TS, &v, &r.Seal); err != nil {
			return nil, err
		}
		if v != nil {
			r.Performance = *v
			out = append(out, r)
		}
	}
	return out, rows.Err()
}

// AgentPortfoliosInSeason lists every (agent, portfolio) participating in a
// season, used to filter the leaderboard by season.
func (s *Store) AgentPortfoliosInSeason(ctx context.Context, seasonID string) ([]AgentPortfolio, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT agent_id, season_id, id FROM portfolios WHERE season_id = $1`, seasonID)
	if err != nil {
		return nil, fmt.Errorf("portfolios in season %s: %w", seasonID, err)
	}
	defer rows.Close()

	var out []AgentPortfolio
	for rows.Next() {
		var ap AgentPortfolio
		if err := rows.Scan(&ap.AgentID, &ap.SeasonID, &ap.PortfolioID); err != nil {
			return nil, err
		}
		out = append(out, ap)
	}
	return out, rows.Err()
}

// SeasonRow is the arena a leaderboard page is filtered to. Display metadata
// only: the Scoring Engine reads a season's tier so a leaderboard can label the
// arena, and reads nothing about anyone's $ARCA balance. The §2.7 boundary --
// "token gives access, performance earns reputation" -- is untouched: no score,
// rank or filter here depends on a token holding.
type SeasonRow struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	AccessTier string `json:"access_tier"`
}

// Season returns the season's identity and access tier, or nil when no such
// season exists. A missing season is not an error for the leaderboard: the
// season filter already returns an empty page, and failing the whole request
// over an unknown id would turn a display label into a hard dependency.
func (s *Store) Season(ctx context.Context, seasonID string) (*SeasonRow, error) {
	var row SeasonRow
	err := s.pool.QueryRow(ctx,
		`SELECT id, name, access_tier FROM seasons WHERE id = $1`, seasonID,
	).Scan(&row.ID, &row.Name, &row.AccessTier)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("season %s: %w", seasonID, err)
	}
	return &row, nil
}
