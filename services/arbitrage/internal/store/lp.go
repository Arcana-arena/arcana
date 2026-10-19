// LP position registry persistence. The registry is a cache of chain state:
// these rows can be rebuilt by re-reading the NonfungiblePositionManager, and
// nothing here moves money — the writing service signs nothing.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// AgentWallet is one agent's chain wallet address, from the platform's own
// record (agent_wallets), which the signer derives and agent-service writes.
type AgentWallet struct {
	AgentID string `json:"agent_id"`
	Address string `json:"address"`
}

// AllAgentWallets returns every agent wallet that has an address. The LP
// registry discovers positions by these addresses, so an empty list means
// discovery looked for nothing — a fact the heartbeat keeps visible rather
// than an error.
func (s *Store) AllAgentWallets(ctx context.Context) ([]AgentWallet, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT agent_id::text, lower(address)
		FROM agent_wallets
		WHERE address <> ''
		ORDER BY agent_id`)
	if err != nil {
		return nil, fmt.Errorf("agent wallets: %w", err)
	}
	defer rows.Close()
	out := []AgentWallet{}
	for rows.Next() {
		var w AgentWallet
		if err := rows.Scan(&w.AgentID, &w.Address); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// LPPosition is one row of the lp_positions registry: the identity of a
// position NFT, the agent wallet that owns it, and the state last read from
// the chain. The string fields are raw chain integers in decimal; the pointer
// fields are nullable because a row can exist before its first full read has
// anything to say (they are all set on every upsert in practice).
type LPPosition struct {
	PositionManager string     `json:"position_manager"`
	TokenID         string     `json:"token_id"`
	AgentID         string     `json:"agent_id"`
	Wallet          string     `json:"wallet"`
	Pool            string     `json:"pool"`
	Token0          string     `json:"token0"`
	Token1          string     `json:"token1"`
	FeeTier         int        `json:"fee_tier"`
	TickLower       int32      `json:"tick_lower"`
	TickUpper       int32      `json:"tick_upper"`
	Liquidity       string     `json:"liquidity"`
	TokensOwed0     string     `json:"tokens_owed0"`
	TokensOwed1     string     `json:"tokens_owed1"`
	CurrentTick     *int32     `json:"current_tick,omitempty"`
	InRange         *bool      `json:"in_range,omitempty"`
	Amount0         *string    `json:"amount0,omitempty"`
	Amount1         *string    `json:"amount1,omitempty"`
	Recommendation  *string    `json:"recommendation,omitempty"`
	Status          string     `json:"status"`
	DiscoveredAt    time.Time  `json:"discovered_at"`
	LastSyncedAt    *time.Time `json:"last_synced_at,omitempty"`
	ClosedAt        *time.Time `json:"closed_at,omitempty"`
}

// UpsertLPPosition writes one position's current state, overwriting the state
// columns of an existing row. The registry records what exists now; the
// discovered_at is preserved across updates, and a row is (re)opened whenever
// it is written, so a closed position that somehow returns to an agent wallet
// is not left closed.
func (s *Store) UpsertLPPosition(ctx context.Context, p LPPosition) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO lp_positions
		  (position_manager, token_id, agent_id, wallet, pool, token0, token1, fee_tier,
		   tick_lower, tick_upper, liquidity, tokens_owed0, tokens_owed1,
		   current_tick, in_range, amount0, amount1, recommendation, status,
		   closed_at, last_synced_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
		        $14, $15, $16, $17, $18, 'open', NULL, now())
		ON CONFLICT (position_manager, token_id) DO UPDATE SET
		  agent_id = EXCLUDED.agent_id,
		  wallet = EXCLUDED.wallet,
		  pool = EXCLUDED.pool,
		  token0 = EXCLUDED.token0,
		  token1 = EXCLUDED.token1,
		  fee_tier = EXCLUDED.fee_tier,
		  tick_lower = EXCLUDED.tick_lower,
		  tick_upper = EXCLUDED.tick_upper,
		  liquidity = EXCLUDED.liquidity,
		  tokens_owed0 = EXCLUDED.tokens_owed0,
		  tokens_owed1 = EXCLUDED.tokens_owed1,
		  current_tick = EXCLUDED.current_tick,
		  in_range = EXCLUDED.in_range,
		  amount0 = EXCLUDED.amount0,
		  amount1 = EXCLUDED.amount1,
		  recommendation = EXCLUDED.recommendation,
		  status = 'open',
		  closed_at = NULL,
		  last_synced_at = now()`,
		p.PositionManager, p.TokenID, p.AgentID, p.Wallet, p.Pool, p.Token0, p.Token1, p.FeeTier,
		p.TickLower, p.TickUpper, p.Liquidity, p.TokensOwed0, p.TokensOwed1,
		p.CurrentTick, p.InRange, p.Amount0, p.Amount1, p.Recommendation)
	if err != nil {
		return fmt.Errorf("upsert lp position %s: %w", p.TokenID, err)
	}
	return nil
}

// CloseLPPosition marks a position closed: burned, or no longer owned by an
// agent wallet. The state columns are deliberately left as last read — what
// the position held while it was ours is the audit trail; zeroing them would
// erase it.
func (s *Store) CloseLPPosition(ctx context.Context, positionManager, tokenID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE lp_positions
		SET status = 'closed', closed_at = now(), last_synced_at = now()
		WHERE position_manager = $1 AND token_id = $2 AND status = 'open'`,
		positionManager, tokenID)
	if err != nil {
		return fmt.Errorf("close lp position %s: %w", tokenID, err)
	}
	return nil
}

// OpenLPPositions returns every position the registry believes is still open.
// Verification rows (provenance='verification', written by the verify suite to
// exercise the read path) are excluded on purpose: they describe nothing on
// chain, so refreshing them would close them — and racing the suite that owns
// them.
func (s *Store) OpenLPPositions(ctx context.Context) ([]LPPosition, error) {
	rows, err := s.pool.Query(ctx, lpPositionSelect+` WHERE status = 'open' AND provenance = 'live' ORDER BY token_id`)
	if err != nil {
		return nil, fmt.Errorf("open lp positions: %w", err)
	}
	defer rows.Close()
	return scanLPPositions(rows)
}

// LPPositions returns registry rows for the API. status is "open", "closed",
// or anything else for both.
func (s *Store) LPPositions(ctx context.Context, status string, limit int) ([]LPPosition, error) {
	q := lpPositionSelect
	args := []any{}
	if status == "open" || status == "closed" {
		q += ` WHERE status = $1`
		args = append(args, status)
	}
	q += fmt.Sprintf(` ORDER BY last_synced_at DESC NULLS LAST, token_id DESC LIMIT $%d`, len(args)+1)
	args = append(args, limit)
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("lp positions: %w", err)
	}
	defer rows.Close()
	return scanLPPositions(rows)
}

const lpPositionSelect = `
	SELECT position_manager, token_id, agent_id::text, wallet, pool, token0, token1, fee_tier,
	       tick_lower, tick_upper, liquidity, tokens_owed0, tokens_owed1,
	       current_tick, in_range, amount0, amount1, recommendation, status,
	       discovered_at, last_synced_at, closed_at
	FROM lp_positions`

func scanLPPositions(rows pgx.Rows) ([]LPPosition, error) {
	out := []LPPosition{}
	for rows.Next() {
		var p LPPosition
		if err := rows.Scan(
			&p.PositionManager, &p.TokenID, &p.AgentID, &p.Wallet, &p.Pool, &p.Token0, &p.Token1, &p.FeeTier,
			&p.TickLower, &p.TickUpper, &p.Liquidity, &p.TokensOwed0, &p.TokensOwed1,
			&p.CurrentTick, &p.InRange, &p.Amount0, &p.Amount1, &p.Recommendation, &p.Status,
			&p.DiscoveredAt, &p.LastSyncedAt, &p.ClosedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// LPAction is one action the loop proposed: what it would ask the signer for
// when a position is out of range (rebalance) or empty (close). status is
// "proposed" while the recommendation that produced it still holds, then
// "superseded". NOTHING EXECUTES THESE ROWS TODAY — the service that writes
// them cannot sign.
type LPAction struct {
	ID              int64           `json:"id"`
	TS              time.Time       `json:"ts"`
	PositionManager string          `json:"position_manager"`
	TokenID         string          `json:"token_id"`
	AgentID         string          `json:"agent_id"`
	Recommendation  string          `json:"recommendation"`
	Status          string          `json:"status"`
	SupersededAt    *time.Time      `json:"superseded_at,omitempty"`
	Detail          json.RawMessage `json:"detail"`
}

// PendingActions returns the outstanding proposals for one position.
func (s *Store) PendingActions(ctx context.Context, positionManager, tokenID string) ([]LPAction, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, ts, position_manager, token_id, agent_id::text, recommendation, status, superseded_at, detail
		FROM lp_position_actions
		WHERE position_manager = $1 AND token_id = $2 AND status = 'proposed'
		ORDER BY ts DESC, id DESC`, positionManager, tokenID)
	if err != nil {
		return nil, fmt.Errorf("pending lp actions: %w", err)
	}
	defer rows.Close()
	return scanLPActions(rows)
}

// ProposedActions returns every outstanding proposal, newest first.
func (s *Store) ProposedActions(ctx context.Context, limit int) ([]LPAction, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, ts, position_manager, token_id, agent_id::text, recommendation, status, superseded_at, detail
		FROM lp_position_actions
		WHERE status = 'proposed'
		ORDER BY ts DESC, id DESC
		LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("proposed lp actions: %w", err)
	}
	defer rows.Close()
	return scanLPActions(rows)
}

func scanLPActions(rows pgx.Rows) ([]LPAction, error) {
	out := []LPAction{}
	for rows.Next() {
		var a LPAction
		if err := rows.Scan(
			&a.ID, &a.TS, &a.PositionManager, &a.TokenID, &a.AgentID,
			&a.Recommendation, &a.Status, &a.SupersededAt, &a.Detail,
		); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// SupersedeActions retires every outstanding proposal for one position. It is
// called before writing a replacement, and when the recommendation that
// produced the outstanding one stops holding — a proposal is only ever as
// good as the verdict it came from.
func (s *Store) SupersedeActions(ctx context.Context, positionManager, tokenID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE lp_position_actions
		SET status = 'superseded', superseded_at = now()
		WHERE position_manager = $1 AND token_id = $2 AND status = 'proposed'`,
		positionManager, tokenID)
	if err != nil {
		return fmt.Errorf("supersede lp actions %s: %w", tokenID, err)
	}
	return nil
}

// ProposeAction appends one proposal.
func (s *Store) ProposeAction(ctx context.Context, a LPAction) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO lp_position_actions
		  (position_manager, token_id, agent_id, recommendation, detail)
		VALUES ($1, $2, $3, $4, $5::jsonb)`,
		a.PositionManager, a.TokenID, a.AgentID, a.Recommendation, string(a.Detail))
	if err != nil {
		return fmt.Errorf("propose lp action %s: %w", a.TokenID, err)
	}
	return nil
}

// DiscoveryBlock returns the next block whose Transfer logs still need to be
// read. ok is false before the loop has ever recorded a cursor.
func (s *Store) DiscoveryBlock(ctx context.Context) (int64, bool, error) {
	var block *int64
	err := s.pool.QueryRow(ctx, `SELECT discovery_block FROM lp_sync_heartbeat WHERE id = 1`).Scan(&block)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("discovery cursor: %w", err)
	}
	if block == nil {
		return 0, false, nil
	}
	return *block, true, nil
}

// LPHeartbeat writes the LP loop's single-row heartbeat. Same rule as the
// scanner's: a loop that ran and found nothing keeps this row fresh; one that
// died does not. discoveryBlock is the cursor to persist — the caller only
// passes a block it has actually scanned up to.
func (s *Store) LPHeartbeat(ctx context.Context, positions, actions int, discoveryBlock *int64, errMsg string) error {
	var errArg any
	if errMsg != "" {
		errArg = errMsg
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO lp_sync_heartbeat (id, last_sync_at, positions, actions_proposed, discovery_block, error)
		VALUES (1, now(), $1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE
		  SET last_sync_at = now(), positions = $1, actions_proposed = $2,
		      discovery_block = $3, error = $4`,
		positions, actions, discoveryBlock, errArg)
	if err != nil {
		return fmt.Errorf("lp heartbeat: %w", err)
	}
	return nil
}
