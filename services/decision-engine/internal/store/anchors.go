package store

import (
	"context"
	"fmt"
	"math/big"
	"time"
)

// AnchorLeaf is one sealed decision as it enters an anchor.
type AnchorLeaf struct {
	DecisionID int64
	DecisionTS time.Time
	AgentID    string
	Commitment string
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

// UnanchoredCommitments returns sealed decisions of LIVE agents that are not in
// any anchor that has landed or may still land, oldest first.
//
// Verification fixtures are left out: they are deleted by the sweep that
// created them, and anchoring a row that will not exist tomorrow buys nothing.
func (s *Store) UnanchoredCommitments(ctx context.Context, limit int) ([]AnchorLeaf, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT d.id, d.ts, d.agent_id::text, trim(d.commitment)
		  FROM decisions d -- raw-by-design: every sealed row is anchored, including rows later marked as artefacts
		  JOIN agents a ON a.id = d.agent_id AND a.provenance = 'live'
		 WHERE d.commitment IS NOT NULL
		   AND NOT EXISTS (
		     SELECT 1 FROM decision_anchor_leaves l
		       JOIN decision_anchors x ON x.id = l.anchor_id
		      WHERE l.decision_id = d.id AND l.decision_ts = d.ts
		        AND x.status NOT IN ('reverted', 'dropped'))
		 ORDER BY d.id
		 LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("unanchored commitments: %w", err)
	}
	defer rows.Close()
	var out []AnchorLeaf
	for rows.Next() {
		var l AnchorLeaf
		if err := rows.Scan(&l.DecisionID, &l.DecisionTS, &l.AgentID, &l.Commitment); err != nil {
			return nil, fmt.Errorf("unanchored commitments: %w", err)
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// RecordAnchor writes a signed anchor and its leaves in one transaction,
// BEFORE it is broadcast — so a crash after sending leaves a row naming the
// transaction, never a transaction nothing names.
func (s *Store) RecordAnchor(ctx context.Context, a AnchorInsert, leaves []AnchorLeaf) (int64, error) {
	if len(leaves) == 0 {
		return 0, fmt.Errorf("record anchor: no leaves")
	}
	first, last := leaves[0].DecisionTS, leaves[0].DecisionTS
	for _, l := range leaves {
		if l.DecisionTS.Before(first) {
			first = l.DecisionTS
		}
		if l.DecisionTS.After(last) {
			last = l.DecisionTS
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
		AnchorScheme, a.Root, len(leaves), leaves[0].DecisionID, leaves[len(leaves)-1].DecisionID, first, last,
		a.ChainID, a.Sender, a.Nonce, a.TxHash, a.RawTx).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("record anchor: %w", err)
	}
	for i, l := range leaves {
		if _, err := tx.Exec(ctx, `
			INSERT INTO decision_anchor_leaves (anchor_id, leaf_index, decision_id, decision_ts, agent_id, commitment)
			VALUES ($1, $2, $3, $4, $5, $6)`,
			id, i, l.DecisionID, l.DecisionTS, l.AgentID, l.Commitment); err != nil {
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

// MarkAnchorDropped records a transaction that will never land. Its decisions
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
