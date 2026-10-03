package engine

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/arcana/decision-engine/internal/credit"
	"github.com/arcana/decision-engine/internal/execution"
	"github.com/arcana/decision-engine/internal/store"
)

// AGENT CREDIT, architecture.md §18. Two passes that ride the guard's capital
// scan, and one lookup used by every capital decision.
//
// IT SIGNS NOTHING AND MOVES NOTHING. The first pass reads Morpho's Liquidate
// events and records the ones that are an agent's; the second derives cycles
// and a reputation from rows that already exist. The limit a reputation gives
// is applied elsewhere — capital.Validate — and only when the allowlist says
// credit is enabled.

const (
	// Blocks behind the head the liquidation scan stops at. Two seconds on this
	// chain: enough that the range it marks read does not change under it.
	liquidationConfirmations = 20
	// Blocks per eth_getLogs call, and calls per scan. The endpoint answered a
	// seven-million-block range in one call on 2026-10-02; this stays well
	// inside that and bounds how long one scan can spend catching up.
	liquidationChunk     = 2_000_000
	liquidationMaxChunks = 8
)

// LiquidationScan reads each allowlisted market's Liquidate events since the
// last block it finished, and records every one whose borrower is an agent
// wallet. It returns how many were new.
//
// THE CURSOR MOVES ONLY AFTER THE RANGE IS WRITTEN. A scan that fails half way
// reads the same range again; the unique key on (tx_hash, log_index) is what
// makes reading it twice harmless.
func (e *Engine) LiquidationScan(ctx context.Context) (found int, firstErr error) {
	if e.broker == nil {
		return 0, nil
	}
	markets := e.broker.CapitalMarkets()
	if len(markets) == 0 {
		return 0, nil
	}
	note := func(err error) {
		if firstErr == nil {
			firstErr = err
		}
	}
	head, err := e.broker.LatestBlock(ctx)
	if err != nil {
		return 0, fmt.Errorf("liquidation scan: %w", err)
	}
	if head <= liquidationConfirmations {
		return 0, nil
	}
	to := head - liquidationConfirmations

	wallets, err := e.store.AllChainWallets(ctx)
	if err != nil {
		return 0, err
	}
	byAddress := make(map[string]store.WalletRow, len(wallets))
	for _, w := range wallets {
		byAddress[strings.ToLower(w.Address)] = w
	}

	for _, m := range markets {
		cursor, ok, cerr := e.store.CapitalScanCursor(ctx, m.ID)
		if cerr != nil {
			note(cerr)
			continue
		}
		from := cursor + 1
		if !ok {
			from = e.broker.LiquidationsFromBlock()
			if from == 0 {
				// Nothing says where history begins, so it begins here. Said in
				// the log: an allowlist with no liquidations_from_block cannot
				// see a liquidation from before this line.
				log.Printf("capital: market %s has no liquidations_from_block; scanning from block %d on", m.Name, to)
				if serr := e.store.SetCapitalScanCursor(ctx, m.ID, to); serr != nil {
					note(serr)
				}
				continue
			}
		}
		for chunk := 0; from <= to && chunk < liquidationMaxChunks; chunk++ {
			end := from + liquidationChunk - 1
			if end > to {
				end = to
			}
			liqs, lerr := e.broker.Liquidations(ctx, m, from, end)
			if lerr != nil {
				note(lerr)
				break
			}
			wrote := true
			for _, l := range liqs {
				w, mine := byAddress[strings.ToLower(l.Borrower)]
				if !mine {
					continue
				}
				n, werr := e.recordLiquidation(ctx, m, w, l)
				if werr != nil {
					note(werr)
					wrote = false
					break
				}
				found += n
			}
			if !wrote {
				break
			}
			if serr := e.store.SetCapitalScanCursor(ctx, m.ID, end); serr != nil {
				note(serr)
				break
			}
			from = end + 1
		}
	}
	return found, firstErr
}

func (e *Engine) recordLiquidation(ctx context.Context, m execution.LendingMarketCfg, w store.WalletRow, l execution.Liquidation) (int, error) {
	ts, err := e.broker.BlockTime(ctx, l.Block)
	if err != nil {
		return 0, fmt.Errorf("liquidation in %s: %w", l.TxHash, err)
	}
	repaid, seized, badDebt, err := e.broker.LiquidationAmounts(m, l)
	if err != nil {
		return 0, fmt.Errorf("liquidation in %s: %w", l.TxHash, err)
	}
	inserted, err := e.store.InsertCapitalLiquidation(ctx, store.CapitalLiquidationRow{
		AgentID: w.AgentID, MarketID: m.ID, Wallet: w.Address, TxHash: l.TxHash, Liquidator: l.Liquidator,
		TS: ts, Block: l.Block, LogIndex: l.LogIndex,
		RepaidUSDG: repaid, SeizedQty: seized, BadDebtUSDG: badDebt,
	})
	if err != nil || !inserted {
		return 0, err
	}
	log.Printf("capital: LIQUIDATION of agent %s in %s: %.6f seized, %.2f USDG repaid, %.2f USDG bad debt, tx %s",
		w.AgentID, m.Name, seized, repaid, badDebt, l.TxHash)
	return 1, nil
}

// CreditScan rebuilds the cycles and the reputation of every agent that has
// ever owed anything. It returns how many reputations it wrote or confirmed.
func (e *Engine) CreditScan(ctx context.Context) (done int, firstErr error) {
	if e.broker == nil || len(e.broker.CapitalMarkets()) == 0 {
		return 0, nil
	}
	agents, err := e.store.CreditAgents(ctx)
	if err != nil {
		return 0, err
	}
	for _, id := range agents {
		if err := e.rebuildCredit(ctx, id, time.Now()); err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("credit for %s: %w", id, err)
			}
			continue
		}
		done++
	}
	return done, firstErr
}

func (e *Engine) rebuildCredit(ctx context.Context, agentID string, now time.Time) error {
	readings, err := e.store.CapitalReadings(ctx, agentID)
	if err != nil {
		return err
	}
	events, err := e.store.CapitalEvents(ctx, agentID)
	if err != nil {
		return err
	}
	liqs, err := e.store.CapitalLiquidationTimes(ctx, agentID)
	if err != nil {
		return err
	}

	// One set of cycles per market: a debt in one market is not the same loan
	// as a debt in another.
	byMarket := map[string][]credit.Reading{}
	var order []string
	for _, r := range readings {
		if _, seen := byMarket[r.MarketID]; !seen {
			order = append(order, r.MarketID)
		}
		byMarket[r.MarketID] = append(byMarket[r.MarketID], credit.Reading{TS: r.TS, Debt: r.Debt, HFWorst: r.HFWorst})
	}
	var all []credit.Cycle
	var allLiqs, stuck []time.Time
	for _, ts := range liqs {
		allLiqs = append(allLiqs, ts...)
	}
	for _, ev := range events {
		if ev.Kind == "stuck" {
			stuck = append(stuck, ev.TS)
		}
	}
	for _, marketID := range order {
		var flows []credit.Flow
		var steps []time.Time
		for _, ev := range events {
			if !strings.EqualFold(ev.MarketID, marketID) {
				continue
			}
			switch ev.Kind {
			case "borrow":
				flows = append(flows, credit.Flow{TS: ev.TS, Borrow: true, Amount: ev.Amount})
			case "repay":
				flows = append(flows, credit.Flow{TS: ev.TS, Amount: ev.Amount})
			case "deleverage":
				steps = append(steps, ev.TS)
				if ev.Repaid {
					flows = append(flows, credit.Flow{TS: ev.TS, Amount: ev.Amount})
				}
			}
		}
		cycles := credit.BuildCycles(byMarket[marketID], flows, steps, liqs[marketID])
		rows := make([]store.CapitalCycleRow, 0, len(cycles))
		for _, c := range cycles {
			row := store.CapitalCycleRow{
				OpenedAt: c.OpenedAt, ClosedAt: c.ClosedAt, PeakDebt: c.PeakDebt, USDGDays: c.USDGDays,
				DebtSeconds: int64(c.DebtSeconds), SecondsUnderFloor: int64(c.SecondsUnderFloor),
				LowestHFWorst: c.LowestHFWorst, Borrowed: c.Borrowed, Repaid: c.Repaid, Interest: c.Interest,
				DeleverageSteps: c.DeleverageSteps, Liquidations: c.Liquidations,
			}
			if c.ClosedHow != "" {
				how := c.ClosedHow
				row.ClosedHow = &how
			}
			rows = append(rows, row)
		}
		if err := e.store.ReplaceCapitalCycles(ctx, agentID, marketID, rows); err != nil {
			return err
		}
		all = append(all, cycles...)
	}

	res := credit.Score(all, now)
	scoredDays, err := e.store.ScoredDays(ctx, agentID)
	if err != nil {
		return err
	}
	enabled, tiers := e.broker.CreditTiers()
	standing := credit.TierFor(res, tiers, scoredDays, allLiqs, stuck, now)
	_, ceiling := e.broker.PlatformCaps()
	limit := credit.Limit(enabled, tiers, ceiling, standing.Tier, &now, now)

	inputs := map[string]any{
		"figures": res.Inputs, "scored_days": scoredDays, "credit_enabled": enabled,
		"readings": len(readings), "first_reading": firstTS(readings), "last_reading": lastTS(readings),
	}
	var score *int
	if res.Rated {
		v := res.Score
		score = &v
	}
	prev, err := e.store.LatestCapitalReputation(ctx, agentID)
	if err != nil {
		return err
	}
	if prev != nil && prev.Rated == res.Rated && sameScore(prev.Score, score) && prev.UnratedWhy == res.UnratedWhy &&
		prev.Tier == standing.Tier && prev.EarnedTier == standing.EarnedTier &&
		prev.HeldBecause == standing.HeldBecause && prev.LimitUSDG == limit {
		return e.store.ConfirmCapitalReputation(ctx, agentID, res.Components, inputs)
	}
	return e.store.InsertCapitalReputation(ctx, store.CapitalReputationRow{
		AgentID: agentID, Rated: res.Rated, UnratedWhy: res.UnratedWhy, Score: score,
		Components: res.Components, Inputs: inputs,
		EarnedTier: standing.EarnedTier, Tier: standing.Tier, HeldBecause: standing.HeldBecause, LimitUSDG: limit,
	})
}

func sameScore(a, b *int) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func firstTS(rs []store.CapitalReadingRow) *time.Time {
	if len(rs) == 0 {
		return nil
	}
	return &rs[0].TS
}

func lastTS(rs []store.CapitalReadingRow) *time.Time {
	if len(rs) == 0 {
		return nil
	}
	return &rs[len(rs)-1].TS
}

// creditLimit is the most this agent may owe, in whole USDG, and the tier that
// gives it.
//
// WITH CREDIT DISABLED IT IS THE PLATFORM'S CAP, as it was before §18. With it
// enabled, a reputation that cannot be read is tier 0, not the cap: could not
// check is not the same as fine.
func (e *Engine) creditLimit(ctx context.Context, agentID string, ceiling float64) (limit float64, tier int, enabled bool) {
	enabled, tiers := e.broker.CreditTiers()
	if !enabled {
		return ceiling, 0, false
	}
	now := time.Now()
	row, err := e.store.LatestCapitalReputation(ctx, agentID)
	if err != nil {
		log.Printf("agent %s: capital reputation unreadable, holding it at tier 0: %v", agentID, err)
		return credit.Limit(true, tiers, ceiling, 0, nil, now), 0, true
	}
	if row == nil {
		return credit.Limit(true, tiers, ceiling, 0, nil, now), 0, true
	}
	limit = credit.Limit(true, tiers, ceiling, row.Tier, &row.ConfirmedAt, now)
	if now.Sub(row.ConfirmedAt) > credit.StaleAfter {
		return limit, 0, true
	}
	return limit, row.Tier, true
}
