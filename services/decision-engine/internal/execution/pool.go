package execution

import (
	"context"
	"fmt"
	"math/big"
	"strings"
	"sync"
)

// Reading a price out of the pool, without asking permission to spend anything.
//
// WHY NOT SIMULATE THE SELL, WHICH WOULD BE MORE ACCURATE
//
// The first version of the position guard priced a position by eth_call-ing the
// exact `exactInputSingle` calldata a sell would send. That is the best possible
// number — net of the fee AND of the depth that size eats — and it does not
// work, for a reason that only appears when you run it against a real wallet:
//
//	scan: 1 armed, 0 fired, first error: quote GOOGL: execution reverted: STF
//
// STF is SafeTransferFrom. The simulation executes `transferFrom(wallet, pool,
// amount)`, which checks `allowance[wallet][router]` — and this system grants
// allowances for the exact amount of a swap, immediately before sending it, on
// purpose. There is no standing allowance to simulate against.
//
// The two ways to make the simulation work were both worse than the problem:
// grant the router a standing allowance, which throws away a deliberate part of
// the signer's posture in exchange for a monitoring convenience; or use
// eth_call state overrides to fake the allowance, which means knowing each
// token's storage layout — through beacon proxies — and would break silently
// whenever an implementation changed.
//
// So the price comes from the pool itself, which needs no permission at all:
//
//	router.factory() -> factory.getPool(token, quote, fee) -> pool.slot0()
//
// WHAT THAT NUMBER IS, EXACTLY. `slot0` gives the pool's current price, which
// is a mid price. Multiplying by (1 - fee) gives what a seller receives per
// share before depth. It does NOT include price impact.
//
// That omission is bounded by something other than optimism: the exit is sent
// through the router with a `min_out` floor, so if the realizable price were
// materially worse than this, the transaction would fail its slippage floor
// rather than fill at a bad price. The level decides WHEN to try; the floor
// decides whether the fill is acceptable. Each is enforced where it can be.

// poolAddrs caches the factory and the pool per symbol. Both are immutable for
// a given (token, quote, fee), so resolving them once per process is not a
// staleness risk — a new pool at a different fee tier would be a new entry in
// the allowlist, which is a deploy.
type poolCache struct {
	mu      sync.RWMutex
	factory string
	pools   map[string]string
	token0  map[string]bool // true when the pool's token0 is the stock token
}

func (b *Broker) cache() *poolCache {
	b.poolOnce.Do(func() {
		b.pool = &poolCache{pools: map[string]string{}, token0: map[string]bool{}}
	})
	return b.pool
}

// PoolPrice is the pool's current mid price for one share, in quote units.
func (b *Broker) PoolPrice(ctx context.Context, symbol string) (float64, error) {
	tok, err := b.cfg.Token(symbol)
	if err != nil {
		return 0, err
	}
	pool, tokenIsToken0, err := b.poolFor(ctx, tok)
	if err != nil {
		return 0, err
	}

	// slot0() -> (uint160 sqrtPriceX96, int24 tick, ...). Only the first word
	// is read; the rest is observation bookkeeping this does not need.
	raw, err := b.rpc.hexString(ctx, "eth_call",
		[]any{map[string]string{"to": pool, "data": "0x3850c7bd"}, "latest"})
	if err != nil {
		return 0, fmt.Errorf("slot0 for %s: %w", symbol, err)
	}
	body := strings.TrimPrefix(raw, "0x")
	if len(body) < 64 {
		return 0, fmt.Errorf("slot0 for %s: short answer", symbol)
	}
	sqrtX96, ok := new(big.Int).SetString(body[:64], 16)
	if !ok || sqrtX96.Sign() <= 0 {
		return 0, fmt.Errorf("slot0 for %s: unreadable price", symbol)
	}

	// price(token0 in token1) = (sqrtPriceX96 / 2^96)^2, then adjusted for the
	// two decimals. In big.Float throughout: sqrtPriceX96 is up to 160 bits and
	// squaring it in float64 loses the low end of the price.
	q96 := new(big.Float).SetInt(new(big.Int).Lsh(big.NewInt(1), 96))
	r := new(big.Float).SetInt(sqrtX96)
	r.Quo(r, q96)
	r.Mul(r, r)

	d0, d1 := tok.Decimals, b.cfg.QuoteToken.Decimals
	if !tokenIsToken0 {
		d0, d1 = b.cfg.QuoteToken.Decimals, tok.Decimals
	}
	if d0 > d1 {
		r.Mul(r, new(big.Float).SetInt(pow10i(d0-d1)))
	} else if d1 > d0 {
		r.Quo(r, new(big.Float).SetInt(pow10i(d1-d0)))
	}
	price, _ := r.Float64()
	if !tokenIsToken0 {
		if price <= 0 {
			return 0, fmt.Errorf("pool price for %s is not positive", symbol)
		}
		price = 1 / price
	}
	if price <= 0 {
		return 0, fmt.Errorf("pool price for %s is not positive", symbol)
	}
	return price, nil
}

// RealizablePrice is what a seller receives per share right now, net of the
// pool fee. See the note at the top of this file for what it does not include
// and why that is safe.
//
// units is not used to price — it is required so a caller cannot ask for the
// price of a position it does not hold, which would be a level watched over
// nothing.
func (b *Broker) RealizablePrice(ctx context.Context, wallet, symbol string, units *big.Int) (float64, error) {
	if units == nil || units.Sign() <= 0 {
		return 0, fmt.Errorf("no position in %s to price", symbol)
	}
	mid, err := b.PoolPrice(ctx, symbol)
	if err != nil {
		return 0, err
	}
	return mid * (1 - float64(b.PoolFeeOf(symbol))/1e6), nil
}

func (b *Broker) poolFor(ctx context.Context, tok TokenCfg) (string, bool, error) {
	c := b.cache()

	c.mu.RLock()
	pool, ok := c.pools[tok.Symbol]
	isT0 := c.token0[tok.Symbol]
	factory := c.factory
	c.mu.RUnlock()
	if ok {
		return pool, isT0, nil
	}

	if factory == "" {
		// factory() on the router. Read from the router rather than configured,
		// so the pool being priced is always the one the swap would use.
		raw, err := b.rpc.hexString(ctx, "eth_call",
			[]any{map[string]string{"to": b.cfg.Router(), "data": "0xc45a0155"}, "latest"})
		if err != nil {
			return "", false, fmt.Errorf("router factory(): %w", err)
		}
		factory = addrFromWord(raw)
		if factory == "" {
			return "", false, fmt.Errorf("router factory() returned no address")
		}
	}

	// getPool(tokenA, tokenB, fee)
	data := "0x1698ee82" + padAddr(tok.Address) + padAddr(b.cfg.QuoteToken.Address) +
		padUint(new(big.Int).SetUint64(uint64(tok.PoolFee)))
	raw, err := b.rpc.hexString(ctx, "eth_call",
		[]any{map[string]string{"to": factory, "data": data}, "latest"})
	if err != nil {
		return "", false, fmt.Errorf("getPool(%s): %w", tok.Symbol, err)
	}
	pool = addrFromWord(raw)
	if pool == "" || isZeroAddr(pool) {
		return "", false, fmt.Errorf("no pool for %s at fee %d", tok.Symbol, tok.PoolFee)
	}

	// token0() decides which way round the price is.
	raw, err = b.rpc.hexString(ctx, "eth_call",
		[]any{map[string]string{"to": pool, "data": "0x0dfe1681"}, "latest"})
	if err != nil {
		return "", false, fmt.Errorf("token0(%s): %w", tok.Symbol, err)
	}
	isT0 = strings.EqualFold(addrFromWord(raw), tok.Address)

	c.mu.Lock()
	c.factory = factory
	c.pools[tok.Symbol] = pool
	c.token0[tok.Symbol] = isT0
	c.mu.Unlock()
	return pool, isT0, nil
}

func addrFromWord(raw string) string {
	body := strings.TrimPrefix(raw, "0x")
	if len(body) < 64 {
		return ""
	}
	return "0x" + body[24:64]
}

func isZeroAddr(a string) bool {
	return strings.Trim(strings.TrimPrefix(strings.ToLower(a), "0x"), "0") == ""
}

func pow10i(n int) *big.Int {
	return new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(n)), nil)
}
