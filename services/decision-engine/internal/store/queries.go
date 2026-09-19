package store

import (
	"context"
	"encoding/json"
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

// AgentRow is the minimal agent projection the engine needs.
type AgentRow struct {
	ID            string
	Status        string
	StrategyType  string
	RiskProfile   map[string]any
	AssetUniverse string
	// Mandate is the user-supplied half of a parameterised agent: what its
	// owner asked it to do. Empty for the built-in deterministic agents.
	Mandate string
	// CadenceSeconds is how often the owner asked for this agent to decide
	// (migration 0054). The engine needs it because the rebalance band is a move
	// over a WINDOW, and the window is this number: the same 0.3% means a normal
	// afternoon's drift over four hours and a violent spike over one minute. See
	// band.go.
	CadenceSeconds int
}

// GetActiveAgent loads an agent and verifies it is active.
func (s *Store) GetActiveAgent(ctx context.Context, agentID string) (*AgentRow, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT id, status, COALESCE(strategy_type,''), risk_profile, asset_universe,
		        COALESCE(mandate,''), cadence_seconds
		 FROM agents WHERE id = $1`, agentID)
	var a AgentRow
	var risk []byte
	if err := row.Scan(&a.ID, &a.Status, &a.StrategyType, &risk, &a.AssetUniverse, &a.Mandate,
		&a.CadenceSeconds); err != nil {
		return nil, fmt.Errorf("load agent %s: %w", agentID, err)
	}
	if err := json.Unmarshal(risk, &a.RiskProfile); err != nil {
		return nil, fmt.Errorf("parse risk_profile: %w", err)
	}
	if a.Status != "active" {
		return nil, fmt.Errorf("agent %s is not active (status=%s)", agentID, a.Status)
	}
	return &a, nil
}

// GetAgent loads an agent WITHOUT requiring it to be active.
//
// GetActiveAgent is the right call on the decision path: a paused agent must
// not be asked for a decision, and refusing by name is how that stays true.
// It is the wrong call on the PROTECTIVE path, where the question is not "may
// this agent decide" but "whose position is this and under whose limits". A
// paused agent's stop loss still belongs to its owner, and reading its risk
// profile through a call that refuses non-active agents meant the owner's own
// cost brake quietly became "unmetered" the moment they paused.
//
// The status comes back with the row so the caller can act on it explicitly
// rather than inferring it from an error.
func (s *Store) GetAgent(ctx context.Context, agentID string) (*AgentRow, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT id, status, COALESCE(strategy_type,''), risk_profile, asset_universe,
		        COALESCE(mandate,'')
		 FROM agents WHERE id = $1`, agentID)
	var a AgentRow
	var risk []byte
	if err := row.Scan(&a.ID, &a.Status, &a.StrategyType, &risk, &a.AssetUniverse, &a.Mandate); err != nil {
		return nil, fmt.Errorf("load agent %s: %w", agentID, err)
	}
	if err := json.Unmarshal(risk, &a.RiskProfile); err != nil {
		return nil, fmt.Errorf("parse risk_profile: %w", err)
	}
	return &a, nil
}

// SeasonRuleset returns the season ruleset JSON (for initial capital etc).
func (s *Store) GetSeasonRuleset(ctx context.Context, seasonID string) (map[string]any, error) {
	var raw []byte
	err := s.pool.QueryRow(ctx,
		`SELECT ruleset FROM seasons WHERE id = $1`, seasonID).Scan(&raw)
	if err != nil {
		return nil, fmt.Errorf("load season %s: %w", seasonID, err)
	}
	var ruleset map[string]any
	if err := json.Unmarshal(raw, &ruleset); err != nil {
		return nil, fmt.Errorf("parse season ruleset: %w", err)
	}
	return ruleset, nil
}

// PortfolioRow is a portfolio with its latest snapshot values.
type PortfolioRow struct {
	ID       string
	Cash     string
	NAV      string
	Holdings map[string]any // symbol -> quantity
}

// GetOrCreatePortfolio finds the portfolio for (agent, season) or creates it
// with the season's initial capital. On an existing portfolio the latest
// snapshot's holdings/cash/nav are loaded as the starting state.
func (s *Store) GetOrCreatePortfolio(ctx context.Context, agentID, seasonID string, initialCapital string) (*PortfolioRow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var id string
	err = tx.QueryRow(ctx,
		`SELECT id FROM portfolios WHERE agent_id = $1 AND season_id = $2`, agentID, seasonID).Scan(&id)
	if err == nil {
		// Load latest snapshot if present.
		p := &PortfolioRow{ID: id, Holdings: map[string]any{}}
		var holdings []byte
		err = tx.QueryRow(ctx,
			`SELECT cash, nav, holdings FROM portfolio_snapshots
			 WHERE portfolio_id = $1 ORDER BY ts DESC LIMIT 1`,
			id).Scan(&p.Cash, &p.NAV, &holdings)
		if err == pgx.ErrNoRows {
			p.Cash = initialCapital
			p.NAV = initialCapital
		} else if err != nil {
			return nil, fmt.Errorf("load latest snapshot: %w", err)
		} else {
			if err := json.Unmarshal(holdings, &p.Holdings); err != nil {
				return nil, fmt.Errorf("parse holdings: %w", err)
			}
		}
		return p, tx.Commit(ctx)
	}
	if err != pgx.ErrNoRows {
		return nil, fmt.Errorf("query portfolio: %w", err)
	}

	// Create new portfolio.
	err = tx.QueryRow(ctx,
		`INSERT INTO portfolios (agent_id, season_id, initial_capital)
		 VALUES ($1, $2, $3) RETURNING id`,
		agentID, seasonID, initialCapital).Scan(&id)
	if err != nil {
		return nil, fmt.Errorf("create portfolio: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &PortfolioRow{ID: id, Cash: initialCapital, NAV: initialCapital, Holdings: map[string]any{}}, nil
}

// AppendDecision inserts an immutable decision row. Returns the new id.
func (s *Store) AppendDecision(ctx context.Context, d DecisionInsert) (int64, error) {
	var id int64
	err := s.pool.QueryRow(ctx,
		`INSERT INTO decisions
		   (agent_id, season_id, ts, market_snapshot_ref, action, symbol, quantity, resulting_allocation, rationale)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 RETURNING id`,
		d.AgentID, d.SeasonID, d.TS, d.MarketSnapshotRef, d.Action, d.Symbol, d.Quantity,
		d.ResultingAllocation, d.Rationale,
	).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("append decision: %w", err)
	}
	return id, nil
}

// LastDecisionSnapshotRef returns the market snapshot THIS AGENT last decided
// against, or "" if it has never decided in this season.
//
// WHY IT EXISTS, and it is a bug bought on 2026-09-20. Every strategy reacts to
// a price MOVE: the rebalance band asks whether anything moved more than the
// owner's threshold, and momentum and mean-reversion read the same return. The
// "previous" prices came from GetPreviousSnapshot — the snapshot immediately
// before this one, globally.
//
// That was correct while one four-hourly tick made every agent decide at once:
// the snapshot before yours was always the one from your own last decision. The
// moment cadence became per-agent it stopped being true. Snapshots are now taken
// whenever ANY agent is due, so "the previous snapshot" can be one minute old,
// and an agent on a four-hour cadence was asked whether the market had moved
// 0.3% in the last sixty seconds. It never had, so it held — forever, for a
// reason nothing in its record would have explained.
//
// So the comparison is per agent: the move since THIS agent last looked. A
// four-hour agent measures four hours, a fifteen-minute agent measures fifteen
// minutes, and the band means what its owner thinks it means.
//
// Scoped to the season because a portfolio is, and ordered by ts with the id as
// the tie-break: decisions is a hypertable keyed on (id, agent_id, ts), and two
// rows can share a timestamp when a protective close is recorded alongside a
// decision.
func (s *Store) LastDecisionSnapshotRef(ctx context.Context, agentID, seasonID string) (string, error) {
	var ref string
	err := s.pool.QueryRow(ctx, `
		SELECT market_snapshot_ref
		  FROM decisions
		 WHERE agent_id = $1 AND season_id = $2
		 ORDER BY ts DESC, id DESC
		 LIMIT 1`, agentID, seasonID).Scan(&ref)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil
		}
		return "", fmt.Errorf("last decision snapshot: %w", err)
	}
	return ref, nil
}

// WriteSnapshot upserts a portfolio snapshot for a point in time.
func (s *Store) WriteSnapshot(ctx context.Context, portfolioID string, ts time.Time, holdings map[string]any, nav, cash string) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO portfolio_snapshots (portfolio_id, ts, holdings, nav, cash)
		 VALUES ($1, $2, $3, $4, $5)`,
		portfolioID, ts, holdings, nav, cash)
	if err != nil {
		return fmt.Errorf("write portfolio snapshot: %w", err)
	}
	return nil
}

// OpenTickForAgent returns the currently open tick (if any) whose competition
// includes the agent as a participant.
func (s *Store) OpenTickForAgent(ctx context.Context, agentID string) (*OpenTick, error) {
	var t OpenTick
	err := s.pool.QueryRow(ctx, `
		SELECT t.id, t.competition_id, t.tick_index, t.market_snapshot_ref
		FROM competition_ticks t
		JOIN competitions c ON c.id = t.competition_id
		WHERE t.phase = 'open'
		  AND $1 = ANY(c.participant_ids)
		ORDER BY t.tick_index DESC
		LIMIT 1`, agentID).Scan(&t.ID, &t.CompetitionID, &t.TickIndex, &t.MarketSnapshotRef)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("load open tick for agent %s: %w", agentID, err)
	}
	return &t, nil
}

// OpenTick mirrors one row of competition_ticks for an open round.
type OpenTick struct {
	ID                string
	CompetitionID     string
	TickIndex         int
	MarketSnapshotRef string
}

// DecisionInsert is the storage shape of an append-only decision.
type DecisionInsert struct {
	AgentID             string
	SeasonID            string
	TS                  time.Time
	MarketSnapshotRef   string
	Action              string
	Symbol              string
	Quantity            *string
	ResultingAllocation map[string]any
	Rationale           string
}
