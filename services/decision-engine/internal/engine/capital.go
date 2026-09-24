package engine

import (
	"context"
	"fmt"
	"time"

	"github.com/arcana/decision-engine/internal/execution"
	"github.com/arcana/decision-engine/internal/store"
)

// CapitalScan reads every agent wallet's position in every allowlisted lending
// market and writes what it finds. IT SIGNS NOTHING and decides nothing;
// architecture.md §17.7 day 5 puts the number in front of a person before any
// code is allowed to move it.
//
// Every wallet, whatever its agent's status (§17.4). A row is written for a
// position that exists, and once more — with zeros — for one that has just
// closed, so the page never shows a stale debt as current.
//
// The per-market reads are made only when some wallet holds a position, so a
// platform where nobody has borrowed pays one position() read per wallet per
// scan and nothing else.
func (e *Engine) CapitalScan(ctx context.Context) (written int, firstErr error) {
	if e.broker == nil {
		return 0, nil
	}
	markets := e.broker.CapitalMarkets()
	if len(markets) == 0 {
		return 0, nil
	}
	wallets, err := e.store.AllChainWallets(ctx)
	if err != nil {
		return 0, err
	}
	note := func(err error) {
		if firstErr == nil {
			firstErr = err
		}
	}
	now := time.Now()
	for _, m := range markets {
		type held struct {
			w   store.WalletRow
			pos execution.LendingPosition
		}
		var todo []held
		for _, w := range wallets {
			pos, perr := e.broker.ReadPosition(ctx, m, w.Address)
			if perr != nil {
				note(perr)
				continue
			}
			if pos.Empty() {
				was, lerr := e.store.LastCapitalHeld(ctx, w.AgentID, m.ID)
				if lerr != nil {
					note(lerr)
					continue
				}
				if !was {
					continue
				}
			}
			todo = append(todo, held{w, pos})
		}
		if len(todo) == 0 {
			continue
		}
		state, serr := e.broker.ReadMarketState(ctx, m, now)
		if serr != nil {
			// Without the market's totals and oracle there is no debt and no
			// health factor to write. Writing a row anyway would put a number
			// on the page that nobody measured.
			note(fmt.Errorf("market %s: %w", m.Name, serr))
			continue
		}
		for _, h := range todo {
			r := execution.Value(h.pos, state)
			if ierr := e.store.InsertCapitalPosition(ctx, store.CapitalRow{
				AgentID: h.w.AgentID, MarketID: m.ID, Wallet: h.w.Address,
				CollateralSymbol: state.CollateralSymbol,
				CollateralQty:    r.CollateralQty, CollateralValue: r.CollateralValue, Debt: r.Debt,
				LLTV: r.LLTV, OraclePrice: r.OraclePrice, PoolPrice: r.PoolPrice,
				HealthFactor: r.HealthFactor, HealthFactorWorst: r.HealthFactorWorst,
				LiquidationPrice: r.LiquidationPrice,
				BaseFeedAge:      state.BaseFeedAge, QuoteFeedAge: state.QuoteFeedAge,
				OraclePaused: state.OraclePaused,
			}); ierr != nil {
				note(ierr)
				continue
			}
			written++
			// Under the floor, the guard acts between ticks (capital_deleverage.go).
			if r.Debt > 0 {
				if derr := e.deleverage(ctx, h.w, m); derr != nil {
					note(fmt.Errorf("deleverage %s: %w", h.w.AgentID, derr))
				}
			}
		}
	}
	return written, firstErr
}
