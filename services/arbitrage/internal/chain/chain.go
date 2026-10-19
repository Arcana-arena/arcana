// Package chain reads Uniswap pool state over eth_call.
//
// A DELIBERATE SUBSET OF market-data's chain reader, not a fork of the whole
// file: an arbitrage scanner needs the spot price, the in-range liquidity and
// the tick spacing — and nothing else. The spot-price math is the same as
// services/market-data/internal/chain/chain.go so the two cannot disagree
// about what a pool price is; token ordering is read, never assumed.
package chain

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	selSlot0       = "0x3850c7bd" // slot0()
	selToken0      = "0x0dfe1681" // token0()
	selLiquidity   = "0x1a686502" // liquidity()
	selTickSpacing = "0xd0c93a7c" // tickSpacing()
)

// Client calls eth_call against a list of endpoints, in order, and remembers
// endpoints that refuse to serve eth_call so it stops paying the round trip.
type Client struct {
	urls   []string
	http   *http.Client
	mu     sync.Mutex
	broken map[string]bool
}

func NewClient(urls []string) *Client {
	clean := make([]string, 0, len(urls))
	for _, u := range urls {
		if s := strings.TrimSpace(u); s != "" {
			clean = append(clean, s)
		}
	}
	return &Client{
		urls:   clean,
		http:   &http.Client{Timeout: 12 * time.Second},
		broken: map[string]bool{},
	}
}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

type rpcResponse struct {
	Result string `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// Call performs eth_call and returns the raw hex result.
func (c *Client) Call(ctx context.Context, to, data string) (string, error) {
	var lastErr error
	for _, url := range c.urls {
		c.mu.Lock()
		skip := c.broken[url]
		c.mu.Unlock()
		if skip {
			continue
		}
		body, err := json.Marshal(rpcRequest{
			JSONRPC: "2.0", ID: 1, Method: "eth_call",
			Params: []any{map[string]string{"to": to, "data": data}, "latest"},
		})
		if err != nil {
			return "", err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(body)))
		if err != nil {
			return "", err
		}
		req.Header.Set("Content-Type", "application/json")
		res, err := c.http.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		var out rpcResponse
		decErr := json.NewDecoder(res.Body).Decode(&out)
		res.Body.Close()
		if decErr != nil {
			lastErr = decErr
			continue
		}
		if out.Error != nil {
			if strings.Contains(strings.ToLower(out.Error.Message), "method") {
				c.mu.Lock()
				c.broken[url] = true
				c.mu.Unlock()
			}
			lastErr = errors.New(out.Error.Message)
			continue
		}
		if out.Result == "" || out.Result == "0x" {
			lastErr = fmt.Errorf("empty result from %s for %s", url, to)
			continue
		}
		return out.Result, nil
	}
	if lastErr == nil {
		lastErr = errors.New("no rpc endpoint answered")
	}
	return "", lastErr
}

func words(hex string) []string {
	s := strings.TrimPrefix(hex, "0x")
	out := make([]string, 0, len(s)/64)
	for i := 0; i+64 <= len(s); i += 64 {
		out = append(out, s[i:i+64])
	}
	return out
}

func wordToBig(w string) *big.Int {
	n := new(big.Int)
	n.SetString(w, 16)
	return n
}

func wordToAddress(w string) string {
	if len(w) < 40 {
		return ""
	}
	return "0x" + strings.ToLower(w[len(w)-40:])
}

// PoolPrice reads a Uniswap V3 pool's spot price for a token, quoted in the
// quote token. The math and the decimal correction are the same as
// services/market-data/internal/chain/chain.go, whose comment explains why the
// correction is identical on both sides of the inversion.
func (c *Client) PoolPrice(ctx context.Context, pool, tokenAddr string, tokenDec, quoteDec int) (float64, error) {
	slot0, err := c.Call(ctx, pool, selSlot0)
	if err != nil {
		return 0, err
	}
	w := words(slot0)
	if len(w) == 0 {
		return 0, errors.New("slot0 empty")
	}
	sqrtPriceX96 := wordToBig(w[0])
	if sqrtPriceX96.Sign() == 0 {
		return 0, errors.New("pool uninitialised (sqrtPriceX96 = 0)")
	}

	token0Raw, err := c.Call(ctx, pool, selToken0)
	if err != nil {
		return 0, err
	}
	token0 := wordToAddress(words(token0Raw)[0])
	stockIsToken0 := strings.EqualFold(token0, tokenAddr)

	q96 := new(big.Float).SetFloat64(math.Pow(2, 96))
	sp := new(big.Float).SetInt(sqrtPriceX96)
	ratio := new(big.Float).Quo(sp, q96)
	ratio.Mul(ratio, ratio)

	scale := big.NewFloat(math.Pow(10, float64(tokenDec-quoteDec)))
	var human *big.Float
	if stockIsToken0 {
		human = ratio
	} else {
		human = new(big.Float).Quo(big.NewFloat(1), ratio)
	}
	human.Mul(human, scale)

	out, _ := human.Float64()
	if !(out > 0) || math.IsInf(out, 0) || math.IsNaN(out) {
		return 0, fmt.Errorf("pool price is not a usable number: %v", out)
	}
	return out, nil
}

// Liquidity reads the pool's current in-range liquidity (uint128), returned as
// a raw integer. It is an audit value in the first slice: impact is not yet
// derived from it (see the config's impact_buffer_note).
func (c *Client) Liquidity(ctx context.Context, pool string) (*big.Int, error) {
	raw, err := c.Call(ctx, pool, selLiquidity)
	if err != nil {
		return nil, err
	}
	w := words(raw)
	if len(w) == 0 {
		return nil, errors.New("liquidity empty")
	}
	return wordToBig(w[0]), nil
}

// TickSpacing reads the pool's tick spacing (int24).
func (c *Client) TickSpacing(ctx context.Context, pool string) (int64, error) {
	raw, err := c.Call(ctx, pool, selTickSpacing)
	if err != nil {
		return 0, err
	}
	w := words(raw)
	if len(w) == 0 {
		return 0, errors.New("tickSpacing empty")
	}
	return wordToBig(w[0]).Int64(), nil
}

// Slot0 returns the pool's current sqrtPriceX96 and tick. The tick is an int24
// sign-extended to a 32-byte ABI word, so a negative tick arrives with every
// high bit set and must be converted back to a signed value here.
func (c *Client) Slot0(ctx context.Context, pool string) (*big.Int, int32, error) {
	raw, err := c.Call(ctx, pool, selSlot0)
	if err != nil {
		return nil, 0, err
	}
	w := words(raw)
	if len(w) < 2 {
		return nil, 0, fmt.Errorf("slot0 returned %d words, expected at least 2", len(w))
	}
	tick := wordToBig(w[1])
	if tick.Bit(255) == 1 {
		tick.Sub(tick, new(big.Int).Lsh(big.NewInt(1), 256))
	}
	return wordToBig(w[0]), int32(tick.Int64()), nil
}

// Token0 returns the pool's token0 address (the lower-address side).
func (c *Client) Token0(ctx context.Context, pool string) (string, error) {
	raw, err := c.Call(ctx, pool, selToken0)
	if err != nil {
		return "", err
	}
	w := words(raw)
	if len(w) == 0 {
		return "", errors.New("token0 empty")
	}
	return wordToAddress(w[0]), nil
}
