package store

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
)

// Fills: what every position cost, and what every closed position made.
//
// WHY THIS EXISTS. An entry price used to be recorded only where a protective
// guard was armed, so a position opened without a stop had no cost basis at all
// and every reader printed "not computable". And a position that closed left no
// result anywhere: the platform whose premise is measuring the outcome of
// decisions could not say what a finished trade made. Both were facts nobody
// wrote down, so no page could show them.
//
// So every fill that changes a book — virtual or on chain, the agent's own or a
// subscriber's, the agent's decision or a protective exit — is written here at
// the moment it happens, with the position accounting done at write time:
//
//	average cost    the cost basis is the volume-weighted average of the buys
//	                since the position was last flat; a sell realizes
//	                (price - average cost) x quantity and leaves the average
//	                unchanged. One method, stated, used everywhere.
//	episode         a position's life from flat to flat. A trade's result is the
//	                sum of its episode's realized P&L, minus the gas its fills
//	                paid.
//	unknown basis   shares that arrived without a fill ARCANA recorded — bought
//	                before this table existed and not reconstructable, or moved
//	                into the wallet from outside — make the average cost
//	                UNKNOWN (NULL) until the position is next flat. Pricing them
//	                at today's fill would claim a cost nobody measured.
//
// PRICES ARE NET OF THE POOL FEE ALREADY. On chain the fee is taken inside the
// swap, so quote units spent over share units received IS what was paid. The
// pool fee is kept as information; adding it to the cost would count it twice.
// Gas is not in the price and is kept separately.

// FillBook says whose book a fill belongs to. Exactly one id is set.
type FillBook struct {
	PortfolioID    string // the agent's own book in a season
	SubscriptionID string // one subscriber's book
}

func (b FillBook) key(symbol string) string {
	if b.SubscriptionID != "" {
		return "fills:sub:" + b.SubscriptionID + ":" + symbol
	}
	return "fills:pf:" + b.PortfolioID + ":" + symbol
}

// FillInsert is one fill as the engine observed it.
type FillInsert struct {
	TS          time.Time
	AgentID     string
	Book        FillBook
	DecisionID  *int64
	ExecutionID *int64
	Symbol      string
	Side        string  // buy | sell
	Quantity    float64 // shares
	Price       float64 // quote per share, as filled
	GasUSD      *float64
	PoolFeeUSD  *float64
	Source      string // simulated | on_chain | reconstructed
	// HeldBefore is what the book actually held of this symbol just before the
	// fill (the chain reading, or the virtual holdings). It is how shares that
	// arrived outside ARCANA are noticed.
	HeldBefore float64
}

// PositionState is the accounting carried from one fill to the next.
type PositionState struct {
	Qty     float64
	AvgCost *float64 // nil = not known
	Episode int
}

// FillOutcome is what applying a fill does to a position.
type FillOutcome struct {
	Before      PositionState
	After       PositionState
	RealizedPnL *float64 // sells only; nil when the cost basis is unknown
	Note        string
}

// fillDust is the smallest recordable quantity (numeric(20,8)); below it a
// position is flat. It is the same floor the engine calls DustFloor.
const fillDust = 1e-8

// ApplyFill is the accounting, and nothing else, so it can be tested with the
// numbers that actually happened.
//
// last is the state the ledger last recorded (zero value when there is none);
// held is what the book really held before this fill.
func ApplyFill(last PositionState, held float64, side string, qty, price float64) FillOutcome {
	before := last
	note := ""

	// RECONCILE AGAINST WHAT IS ACTUALLY HELD before accounting for this fill.
	switch {
	case math.Abs(held-last.Qty) <= fillDust:
		before.Qty = held
	case held < last.Qty:
		// Shares left without a fill ARCANA recorded (moved out of the wallet).
		// What remains keeps its cost basis; nothing is realized, because
		// nothing was sold here.
		before.Qty = held
		note = fmt.Sprintf("%.8f shares left the book outside ARCANA before this fill; the rest keep their cost basis", last.Qty-held)
	default:
		// Shares arrived without a recorded fill. Their cost is unknown, so the
		// whole position's average is unknown until it is next flat.
		before.Qty = held
		before.AvgCost = nil
		if last.Qty <= fillDust {
			note = fmt.Sprintf("%.8f shares were already held with no recorded fill; their cost is unknown", held)
		} else {
			note = fmt.Sprintf("%.8f shares arrived outside ARCANA; the position's cost basis is unknown until it is next flat", held-last.Qty)
		}
	}
	if before.Qty <= fillDust {
		// Flat after reconciliation. The episode counter still names the last
		// position, so the next buy opens the one after it.
		before.Qty = 0
	}

	after := before
	var realized *float64

	switch side {
	case "buy":
		if before.Qty <= fillDust {
			// A NEW POSITION from flat: a new episode with a fully known basis.
			after.Episode = last.Episode + 1
			after.Qty = qty
			p := price
			after.AvgCost = &p
		} else {
			after.Qty = before.Qty + qty
			if before.AvgCost != nil {
				avg := (before.Qty*(*before.AvgCost) + qty*price) / after.Qty
				after.AvgCost = &avg
			}
			if after.Episode == 0 {
				after.Episode = last.Episode + 1
			}
		}
	case "sell":
		if before.Episode == 0 {
			// Selling shares no fill ever opened: an episode with no known start.
			after.Episode = last.Episode + 1
		}
		sold := math.Min(qty, before.Qty)
		if qty > before.Qty+fillDust {
			if note != "" {
				note += "; "
			}
			note += fmt.Sprintf("sold %.8f while %.8f was held", qty, before.Qty)
			sold = qty
		}
		if before.AvgCost != nil {
			r := (price - *before.AvgCost) * sold
			realized = &r
		}
		after.Qty = before.Qty - sold
		if after.Qty <= fillDust {
			after.Qty = 0
		}
	}
	return FillOutcome{Before: before, After: after, RealizedPnL: realized, Note: note}
}

// RecordFill writes one fill with its accounting, in one transaction, under a
// lock on the book and symbol so two writers cannot both read the same "last".
func (s *Store) RecordFill(ctx context.Context, f FillInsert) error {
	if f.Side != "buy" && f.Side != "sell" {
		return fmt.Errorf("record fill: side %q is not a fill", f.Side)
	}
	if !(f.Quantity > 0) || !(f.Price > 0) || math.IsInf(f.Price, 0) || math.IsNaN(f.Price) {
		return fmt.Errorf("record fill: %s %s qty %v at %v is not a measurable fill", f.Side, f.Symbol, f.Quantity, f.Price)
	}
	if (f.Book.PortfolioID == "") == (f.Book.SubscriptionID == "") {
		return errors.New("record fill: exactly one of portfolio or subscription must name the book")
	}
	if f.TS.IsZero() {
		f.TS = time.Now().UTC()
	}
	f.TS = f.TS.UTC().Truncate(time.Microsecond)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("record fill: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, f.Book.key(f.Symbol)); err != nil {
		return fmt.Errorf("record fill: lock: %w", err)
	}

	var last PositionState
	var avg *float64
	var bookCol, bookID string
	if f.Book.SubscriptionID != "" {
		bookCol, bookID = "subscription_id", f.Book.SubscriptionID
	} else {
		bookCol, bookID = "portfolio_id", f.Book.PortfolioID
	}
	err = tx.QueryRow(ctx,
		`SELECT qty_after::float8, avg_cost_after::float8, episode
		   FROM position_fills WHERE `+bookCol+` = $1 AND symbol = $2
		  ORDER BY ts DESC, id DESC LIMIT 1`, bookID, f.Symbol).Scan(&last.Qty, &avg, &last.Episode)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("record fill: last state: %w", err)
	}
	last.AvgCost = avg

	out := ApplyFill(last, f.HeldBefore, f.Side, f.Quantity, f.Price)

	var pf, sub any
	book := "agent"
	if f.Book.SubscriptionID != "" {
		sub, book = f.Book.SubscriptionID, "subscription"
	} else {
		pf = f.Book.PortfolioID
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO position_fills
		   (ts, agent_id, book, portfolio_id, subscription_id, decision_id, execution_id,
		    symbol, side, quantity, price, notional, gas_usd, pool_fee_usd, source,
		    qty_before, avg_cost_before, qty_after, avg_cost_after, realized_pnl, episode, note)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
		f.TS, f.AgentID, book, pf, sub, f.DecisionID, f.ExecutionID,
		f.Symbol, f.Side, f.Quantity, f.Price, f.Quantity*f.Price, f.GasUSD, f.PoolFeeUSD, f.Source,
		out.Before.Qty, out.Before.AvgCost, out.After.Qty, out.After.AvgCost, out.RealizedPnL, out.After.Episode,
		nilIfEmpty(out.Note)); err != nil {
		return fmt.Errorf("record fill: insert: %w", err)
	}
	return tx.Commit(ctx)
}

// LatestFillTS is when this book last recorded a fill for a symbol, for the
// reconstruction, which must never insert a fill older than one already there.
func (s *Store) LatestFillTS(ctx context.Context, book FillBook, symbol string) (*time.Time, error) {
	col, id := "portfolio_id", book.PortfolioID
	if book.SubscriptionID != "" {
		col, id = "subscription_id", book.SubscriptionID
	}
	var ts *time.Time
	err := s.pool.QueryRow(ctx,
		`SELECT max(ts) FROM position_fills WHERE `+col+` = $1 AND symbol = $2`, id, symbol).Scan(&ts)
	if err != nil {
		return nil, fmt.Errorf("latest fill: %w", err)
	}
	return ts, nil
}
