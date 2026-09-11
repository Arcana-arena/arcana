package store

import (
	"context"
	"fmt"
	"math/big"
	"time"
)

// ExecutionInsert is one attempt to move real funds, written from chain reads.
//
// Every pointer field is a pointer BECAUSE NULL IS A DIFFERENT ANSWER FROM
// ZERO. A fill of nil means the transaction has not resolved; a fill of zero
// means it resolved and moved nothing. Collapsing those two is how a reverted
// swap ends up looking like a decision not to trade.
type ExecutionInsert struct {
	AgentID      string
	DecisionID   *int64
	TS           time.Time
	IntentAction string
	Symbol       string
	TokenIn      string
	TokenOut     string
	AmountIn     *big.Int
	QuotedOut    *big.Int
	MinOut       *big.Int
	Filled       *big.Int
	SlippageBps  *float64
	TxHash       string
	BlockNumber  int64
	GasUsed      int64
	GasPriceWei  *big.Int
	GasCostWei   *big.Int
	Status       string
	RefusalCode  string
	Note         string

	// Cost, beyond gas. NULL when no swap executed: a refusal, a revert and an
	// approval all pay no pool fee, and that is different from a swap that paid
	// zero. The dollar columns are NULL when the price feed could not be read,
	// which the meter treats as unreadable rather than as free.
	FeeTier      uint32
	PoolFeeUnits *big.Int
	PoolFeeUSD   float64
	GasCostUSD   float64
	EthUSD       float64
}

func bigStr(v *big.Int) any {
	if v == nil {
		return nil
	}
	return v.String()
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nilIfZero(v int64) any {
	if v == 0 {
		return nil
	}
	return v
}

// AppendExecution records what the chain did. It is written even when nothing
// was sent: a refusal and a blocked precondition are outcomes an operator has
// to be able to find later, and an attempt that leaves no row is an attempt
// nobody can account for.
func (s *Store) AppendExecution(ctx context.Context, e ExecutionInsert) (int64, error) {
	if e.TS.IsZero() {
		e.TS = time.Now().UTC()
	}
	var id int64
	err := s.pool.QueryRow(ctx,
		`INSERT INTO executions
		   (agent_id, decision_id, ts, intent_action, symbol, token_in, token_out,
		    amount_in, quoted_out, min_out, filled_out, slippage_bps,
		    tx_hash, block_number, gas_used, gas_price_wei, gas_cost_wei,
		    status, refusal_code, note,
		    fee_tier, pool_fee_units, pool_fee_usd, gas_cost_usd, eth_usd)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
		 RETURNING id`,
		e.AgentID, e.DecisionID, e.TS, e.IntentAction, e.Symbol, e.TokenIn, e.TokenOut,
		bigStr(e.AmountIn), bigStr(e.QuotedOut), bigStr(e.MinOut), bigStr(e.Filled), e.SlippageBps,
		nilIfEmpty(e.TxHash), nilIfZero(e.BlockNumber), nilIfZero(e.GasUsed),
		bigStr(e.GasPriceWei), bigStr(e.GasCostWei),
		e.Status, nilIfEmpty(e.RefusalCode), nilIfEmpty(e.Note),
		nilIfZeroInt(int(e.FeeTier)), bigStr(e.PoolFeeUnits),
		nilIfZeroFloat(e.PoolFeeUSD), nilIfZeroFloat(e.GasCostUSD), nilIfZeroFloat(e.EthUSD),
	).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("append execution: %w", err)
	}
	return id, nil
}

// LinkExecutionToDecision attaches the decision id once the decision exists.
//
// The execution row is written FIRST and linked afterwards, deliberately. The
// transaction is broadcast before any row can describe its outcome, so writing
// the execution first means a crash between the two leaves an orphan row that
// names a real transaction hash — recoverable. The other order would leave a
// decision claiming a trade with nothing on chain to check it against.
func (s *Store) LinkExecutionToDecision(ctx context.Context, executionID, decisionID int64) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE executions SET decision_id = $1 WHERE id = $2`, decisionID, executionID)
	if err != nil {
		return fmt.Errorf("link execution %d to decision %d: %w", executionID, decisionID, err)
	}
	return nil
}

// ChainWallet is the address an agent trades from, and how its key is held.
type ChainWallet struct {
	Address    string
	KeyCustody string
}

// ChainWalletFor returns the agent's wallet, or nil when it has none.
//
// Nil is the ordinary case for every agent that predates phase 8, and it is
// what keeps this change additive: an agent with no wallet keeps the virtual
// settlement it has always had, and nothing about the running competition
// changes because chain execution was added.
func (s *Store) ChainWalletFor(ctx context.Context, agentID string) (*ChainWallet, error) {
	var w ChainWallet
	err := s.pool.QueryRow(ctx,
		`SELECT address, key_custody FROM agent_wallets WHERE agent_id = $1`, agentID).
		Scan(&w.Address, &w.KeyCustody)
	if err != nil {
		return nil, nil
	}
	if w.Address == "" {
		return nil, nil
	}
	return &w, nil
}

// LastSnapshotHoldings returns what ARCANA last recorded the agent holding, so
// it can be compared against what the chain says now.
//
// Returns ok=false when there is no prior snapshot. That is NOT zero holdings:
// with nothing recorded there is no claim to disagree with, and reporting
// "no drift" from an absent record is the unplugged-lamp reading this whole
// path exists to stop producing.
func (s *Store) LastSnapshotHoldings(ctx context.Context, portfolioID string) (holdings map[string]any, cash float64, ok bool, err error) {
	var cashStr string
	err = s.pool.QueryRow(ctx,
		`SELECT holdings, cash FROM portfolio_snapshots
		  WHERE portfolio_id = $1 ORDER BY ts DESC LIMIT 1`, portfolioID).
		Scan(&holdings, &cashStr)
	if err != nil {
		return nil, 0, false, nil
	}
	fmt.Sscanf(cashStr, "%f", &cash)
	return holdings, cash, true, nil
}

// RecordCustodyDrift writes a disagreement between what ARCANA recorded and
// what the chain holds.
//
// It writes into the SAME table agent-service writes to, rather than a second
// one, so there is one place to look for "money moved and ARCANA did not do
// it" regardless of which service noticed.
func (s *Store) RecordCustodyDrift(ctx context.Context, agentID, tokenAddress, symbol string,
	expected, observed, delta string, resolution, note string) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO custody_drift
		   (agent_id, token_address, symbol, expected, observed, delta, resolution, note)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		agentID, nilIfEmpty(tokenAddress), nilIfEmpty(symbol), expected, observed, delta, resolution, note)
	if err != nil {
		return fmt.Errorf("record custody drift: %w", err)
	}
	return nil
}


// nilIfZeroFloat keeps "not priced" distinct from "cost nothing".
//
// The difference decides what the cost meter does: an unreadable cost makes it
// refuse, and a zero cost makes it carry on. Writing 0 for a price feed that
// could not be read would turn a fault into a free trade.
func nilIfZeroFloat(v float64) any {
	if v == 0 {
		return nil
	}
	return v
}