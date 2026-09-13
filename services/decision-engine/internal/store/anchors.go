package store

import (
	"context"
	"fmt"
	"math/big"
	"time"
)

// Leaf kinds. Each is the sha256 of a manifest that names its own scheme.
const (
	LeafDecision          = "decision"
	LeafPortfolioSnapshot = "portfolio_snapshot"
	LeafScore             = "score"
)

// AnchorLeaf is one sealed record as it enters an anchor.
type AnchorLeaf struct {
	Kind       string
	AgentID    string
	Commitment string

	// kind=decision
	DecisionID int64
	DecisionTS time.Time

	// kind=portfolio_snapshot: PortfolioID + RecordTS. kind=score: SeasonID + RecordTS.
	PortfolioID string
	SeasonID    string
	RecordTS    time.Time
}

// AnchorInsert is an anchor transaction that has been signed and not yet sent.
type AnchorInsert struct {
	Root    string
	ChainID int64
	Sender  string
	Nonce   uint64
	TxHash  string
	RawTx   string
}

// PendingAnchor is an anchor whose transaction has no final answer yet.
type PendingAnchor struct {
	ID        int64
	Nonce     uint64
	TxHash    string
	RawTx     string
	Status    string
	CreatedAt time.Time
}

// UnanchoredLeaves returns the sealed records of LIVE agents that are not in any
// anchor that has landed or may still land: decisions first, then portfolio
// snapshots, then scores, each oldest first, at most limit in total.
//
// A SCORE WAITS FOR ITS INPUTS. A score's seal joins an anchor only when every
// sealed input its manifest names — snapshots, decisions, the peer scores its
// creator factor averaged — is already in a MINED anchor. The root then seals a
// number whose inputs are themselves on chain, which is the only order in which
// anchoring a score means anything.
//
// Verification fixtures are left out: the sweep that created them deletes them.
func (s *Store) UnanchoredLeaves(ctx context.Context, limit int) ([]AnchorLeaf, error) {
	var out []AnchorLeaf

	rows, err := s.pool.Query(ctx, `
		SELECT d.id, d.ts, d.agent_id::text, trim(d.commitment)
		  FROM decisions d -- raw-by-design: every sealed row is anchored, including rows later marked as artefacts
		  JOIN agents a ON a.id = d.agent_id AND a.provenance = 'live'
		 WHERE d.commitment IS NOT NULL
		   AND NOT EXISTS (
		     SELECT 1 FROM decision_anchor_leaves l
		       JOIN decision_anchors x ON x.id = l.anchor_id
		      WHERE l.kind = 'decision' AND l.decision_id = d.id AND l.decision_ts = d.ts
		        AND x.status NOT IN ('reverted', 'dropped'))
		 ORDER BY d.id
		 LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("unanchored decisions: %w", err)
	}
	for rows.Next() {
		l := AnchorLeaf{Kind: LeafDecision}
		if err := rows.Scan(&l.DecisionID, &l.DecisionTS, &l.AgentID, &l.Commitment); err != nil {
			rows.Close()
			return nil, fmt.Errorf("unanchored decisions: %w", err)
		}
		out = append(out, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if remaining := limit - len(out); remaining > 0 {
		rows, err = s.pool.Query(ctx, `
			SELECT ps.portfolio_id::text, ps.ts, p.agent_id::text, p.season_id::text, trim(ps.seal)
			  FROM portfolio_snapshots ps
			  JOIN portfolios p ON p.id = ps.portfolio_id
			  JOIN agents a ON a.id = p.agent_id AND a.provenance = 'live'
			 WHERE ps.seal IS NOT NULL
			   AND NOT EXISTS (
			     SELECT 1 FROM decision_anchor_leaves l
			       JOIN decision_anchors x ON x.id = l.anchor_id
			      WHERE l.kind = 'portfolio_snapshot' AND l.portfolio_id = ps.portfolio_id AND l.record_ts = ps.ts
			        AND x.status NOT IN ('reverted', 'dropped'))
			 ORDER BY ps.ts, ps.portfolio_id
			 LIMIT $1`, remaining)
		if err != nil {
			return nil, fmt.Errorf("unanchored snapshots: %w", err)
		}
		for rows.Next() {
			l := AnchorLeaf{Kind: LeafPortfolioSnapshot}
			if err := rows.Scan(&l.PortfolioID, &l.RecordTS, &l.AgentID, &l.SeasonID, &l.Commitment); err != nil {
				rows.Close()
				return nil, fmt.Errorf("unanchored snapshots: %w", err)
			}
			out = append(out, l)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}

	if remaining := limit - len(out); remaining > 0 {
		rows, err = s.pool.Query(ctx, `
			SELECT s.agent_id::text, s.season_id::text, s.ts, trim(s.seal)
			  FROM score_snapshots s
			  JOIN agents a ON a.id = s.agent_id AND a.provenance = 'live'
			 WHERE s.seal IS NOT NULL
			   AND NOT EXISTS (
			     SELECT 1 FROM decision_anchor_leaves l
			       JOIN decision_anchors x ON x.id = l.anchor_id
			      WHERE l.kind = 'score' AND l.agent_id = s.agent_id AND l.season_id = s.season_id
			        AND l.record_ts = s.ts AND x.status NOT IN ('reverted', 'dropped'))
			   AND NOT EXISTS (
			     SELECT 1 FROM score_input_seals i
			      WHERE i.agent_id = s.agent_id AND i.season_id = s.season_id AND i.score_ts = s.ts
			        AND NOT EXISTS (
			          SELECT 1 FROM decision_anchor_leaves l
			            JOIN decision_anchors x ON x.id = l.anchor_id
			           WHERE l.commitment = i.seal AND x.status = 'mined'))
			 ORDER BY s.ts, s.agent_id
			 LIMIT $1`, remaining)
		if err != nil {
			return nil, fmt.Errorf("unanchored scores: %w", err)
		}
		for rows.Next() {
			l := AnchorLeaf{Kind: LeafScore}
			if err := rows.Scan(&l.AgentID, &l.SeasonID, &l.RecordTS, &l.Commitment); err != nil {
				rows.Close()
				return nil, fmt.Errorf("unanchored scores: %w", err)
			}
			out = append(out, l)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// RecordAnchor writes a signed anchor and its leaves in one transaction,
// BEFORE it is broadcast — so a crash after sending leaves a row naming the
// transaction, never a transaction nothing names.
func (s *Store) RecordAnchor(ctx context.Context, a AnchorInsert, leaves []AnchorLeaf) (int64, error) {
	if len(leaves) == 0 {
		return 0, fmt.Errorf("record anchor: no leaves")
	}

	// The decision range, when the anchor carries decisions at all.
	var firstID, lastID *int64
	var firstTS, lastTS *time.Time
	for i := range leaves {
		l := leaves[i]
		if l.Kind != LeafDecision {
			continue
		}
		id, ts := l.DecisionID, l.DecisionTS
		if firstID == nil || id < *firstID {
			firstID = &id
		}
		if lastID == nil || id > *lastID {
			lastID = &id
		}
		if firstTS == nil || ts.Before(*firstTS) {
			firstTS = &ts
		}
		if lastTS == nil || ts.After(*lastTS) {
			lastTS = &ts
		}
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("record anchor: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var id int64
	err = tx.QueryRow(ctx, `
		INSERT INTO decision_anchors
		  (scheme, root, leaf_count, first_decision_id, last_decision_id, first_decision_ts, last_decision_ts,
		   chain_id, sender, nonce, tx_hash, raw_tx, status)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'signed')
		RETURNING id`,
		AnchorScheme, a.Root, len(leaves), firstID, lastID, firstTS, lastTS,
		a.ChainID, a.Sender, a.Nonce, a.TxHash, a.RawTx).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("record anchor: %w", err)
	}
	for i, l := range leaves {
		var decisionID *int64
		var decisionTS, recordTS *time.Time
		var portfolioID, seasonID *string
		switch l.Kind {
		case LeafDecision:
			decisionID, decisionTS = &l.DecisionID, &l.DecisionTS
		case LeafPortfolioSnapshot:
			portfolioID, seasonID, recordTS = &l.PortfolioID, &l.SeasonID, &l.RecordTS
		case LeafScore:
			seasonID, recordTS = &l.SeasonID, &l.RecordTS
		default:
			return 0, fmt.Errorf("record anchor leaf %d: unknown kind %q", i, l.Kind)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO decision_anchor_leaves
			  (anchor_id, leaf_index, kind, agent_id, commitment, decision_id, decision_ts, portfolio_id, season_id, record_ts)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
			id, i, l.Kind, l.AgentID, l.Commitment, decisionID, decisionTS, portfolioID, seasonID, recordTS); err != nil {
			return 0, fmt.Errorf("record anchor leaf %d: %w", i, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("record anchor: commit: %w", err)
	}
	return id, nil
}

// PendingAnchors returns anchors that are signed or broadcast and not settled.
func (s *Store) PendingAnchors(ctx context.Context) ([]PendingAnchor, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, nonce, tx_hash, raw_tx, status, created_at
		  FROM decision_anchors
		 WHERE status IN ('signed', 'broadcast')
		 ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("pending anchors: %w", err)
	}
	defer rows.Close()
	var out []PendingAnchor
	for rows.Next() {
		var p PendingAnchor
		var nonce int64
		if err := rows.Scan(&p.ID, &nonce, &p.TxHash, &p.RawTx, &p.Status, &p.CreatedAt); err != nil {
			return nil, fmt.Errorf("pending anchors: %w", err)
		}
		p.Nonce = uint64(nonce)
		out = append(out, p)
	}
	return out, rows.Err()
}

// MarkAnchorBroadcast records that the signed transaction was sent.
func (s *Store) MarkAnchorBroadcast(ctx context.Context, id int64) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE decision_anchors SET status = 'broadcast', broadcast_at = now()
		  WHERE id = $1 AND status = 'signed'`, id)
	return err
}

// MarkAnchorSettled records the chain's answer: mined, or mined and reverted.
func (s *Store) MarkAnchorSettled(ctx context.Context, id int64, reverted bool, block uint64, gasUsed uint64,
	effPrice, costWei *big.Int, ethUSD, costUSD *float64) error {
	status := "mined"
	if reverted {
		status = "reverted"
	}
	var eth, usd any
	if ethUSD != nil {
		eth = *ethUSD
	}
	if costUSD != nil {
		usd = *costUSD
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE decision_anchors
		   SET status = $2, block_number = $3, gas_used = $4,
		       effective_gas_price_wei = $5::numeric, gas_cost_wei = $6::numeric,
		       eth_usd = $7, gas_cost_usd = $8, mined_at = now()
		 WHERE id = $1 AND status IN ('signed', 'broadcast')`,
		id, status, int64(block), int64(gasUsed), bigString(effPrice), bigString(costWei), eth, usd)
	return err
}

// MarkAnchorDropped records a transaction that will never land. Its records
// return to the queue for the next anchor.
func (s *Store) MarkAnchorDropped(ctx context.Context, id int64, note string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE decision_anchors SET status = 'dropped', note = $2
		  WHERE id = $1 AND status IN ('signed', 'broadcast')`, id, note)
	return err
}

// AnyAnchorMined reports whether anchoring has ever worked on this deployment.
func (s *Store) AnyAnchorMined(ctx context.Context) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM decision_anchors WHERE status = 'mined')`).Scan(&ok)
	return ok, err
}

func bigString(v *big.Int) any {
	if v == nil {
		return nil
	}
	return v.String()
}
