package execution

import (
	"context"
	"fmt"
	"math"
	"strings"
)

// THE SECONDARY MARKET'S REFEREE.
//
// A primary token is refereed by its Chainlink feed in market-data. A secondary
// token has no feed — Chainlink publishes none for it on this chain — so the
// only independent price on the chain is a second Uniswap pool for the same
// pair at a different fee tier. Two pools with separate liquidity have to be
// moved separately, so a price that one of them alone shows is a price someone
// pushed, not the market.
//
// Checked HERE, at execution, rather than only in the snapshot, because the
// snapshot is minutes old by the time an intent is sent and the pool the swap
// fills against is read now. Checked for sells as well as buys: selling into a
// pool pushed down is the same loss as buying from one pushed up.

// RefereeTolerancePct is how far the two pools may disagree before a trade is
// refused. The same 2% market-data disputes a Chainlink-refereed pool at, and
// the capital brake refuses a borrow at. RBLX's 0.3% and 1% pools were 0.32%
// apart when it was listed on 2026-09-27, and most of that is their fees.
const RefereeTolerancePct = 2.0

// Refusal codes written to executions.refusal_code for a secondary trade the
// referee stopped. Nothing was signed in either case.
const (
	CodePriceDivergence   = "price_divergence"
	CodeRefereeUnreadable = "referee_unreadable"
)

// RefereeCheck is what the two pools said.
type RefereeCheck struct {
	PoolPrice    float64
	RefereePrice float64
	DeviationPct float64
}

// checkReferee reads the traded pool and the referee pool and returns a refusal
// code and a sentence when the trade must not go ahead. An empty code means it
// may. A token that is not secondary is never checked here.
func (b *Broker) checkReferee(ctx context.Context, tok TokenCfg) (code, note string) {
	if !tok.Secondary() {
		return "", ""
	}
	rc, err := b.readReferee(ctx, tok)
	if err != nil {
		// A referee nobody can read is not a referee that agreed.
		return CodeRefereeUnreadable, fmt.Sprintf(
			"%s is a secondary-market token and its referee pool could not be read, so its price is "+
				"unchecked and nothing was sent: %v", tok.Symbol, err)
	}
	if code, note := judgeReferee(tok.Symbol, rc); code != "" {
		return code, note
	}
	return "", ""
}

// readReferee reads both pools, and refuses a referee pool that is not the
// one the allowlist names.
func (b *Broker) readReferee(ctx context.Context, tok TokenCfg) (RefereeCheck, error) {
	var rc RefereeCheck
	pool, _, err := b.poolFor(ctx, tok, tok.RefereePoolFee)
	if err != nil {
		return rc, err
	}
	if tok.RefereePool != "" && !strings.EqualFold(pool, tok.RefereePool) {
		return rc, fmt.Errorf("the factory resolves the %d fee tier to %s, not the reviewed %s",
			tok.RefereePoolFee, pool, tok.RefereePool)
	}
	if rc.PoolPrice, err = b.poolPriceAt(ctx, tok, tok.PoolFee); err != nil {
		return rc, err
	}
	if rc.RefereePrice, err = b.poolPriceAt(ctx, tok, tok.RefereePoolFee); err != nil {
		return rc, err
	}
	rc.DeviationPct = math.Abs(rc.PoolPrice-rc.RefereePrice) / rc.RefereePrice * 100
	return rc, nil
}

// judgeReferee is the decision on its own, so it can be tested without a chain.
func judgeReferee(symbol string, rc RefereeCheck) (code, note string) {
	if !(rc.PoolPrice > 0) || !(rc.RefereePrice > 0) {
		return CodeRefereeUnreadable, fmt.Sprintf(
			"%s: a pool answered a price that is not positive (%v against %v)", symbol, rc.PoolPrice, rc.RefereePrice)
	}
	if rc.DeviationPct > RefereeTolerancePct {
		return CodePriceDivergence, fmt.Sprintf(
			"%s: the traded pool is at %.4f and the referee pool at %.4f, %.2f%% apart (limit %.0f%%). "+
				"One of them has been moved, and nothing was sent", symbol, rc.PoolPrice, rc.RefereePrice,
			rc.DeviationPct, RefereeTolerancePct)
	}
	return "", ""
}
