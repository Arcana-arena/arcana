// Package chain reads prices from the chain instead of from a vendor.
//
// THE SWITCH THIS MAKES. market-data was a vendor reader: it asked Polygon what
// a US session closed at, once a trading day, and that answer was the market.
// Stock Tokens trade continuously against a Uniswap pool on Robinhood Chain,
// so the price that matters is the one an agent would actually get, and the
// only place that exists is the pool.
//
// TWO SOURCES, ONE OF THEM A REFEREE.
//
// The pool is authoritative for what a trade would cost, because it IS what a
// trade would cost. It is also thin, manipulable within a block, and answers
// instantly to anyone with capital. So every pool price is checked against the
// Chainlink feed for the same symbol, and the disagreement is recorded on the
// quote.
//
// Chainlink is not used as the price. It is used as the referee, and the
// distinction is the whole design:
//
//   - trading against a Chainlink price would produce decisions that cannot be
//     executed — the pool is where the fill happens, and a decision priced
//     somewhere else is a decision about a market that does not exist here.
//   - trading against an UNCHECKED pool price means the first person to move
//     the pool decides what every agent believes.
//
// So the pool decides the number and Chainlink decides whether to believe it.
// When they disagree beyond tolerance the quote is marked `disputed` and
// carries both figures. It is NOT dropped: a symbol vanishing from a snapshot
// is indistinguishable from a symbol nobody asked about, and the decision
// engine would silently stop considering it. Marked and present is the
// answer — "when unsure, don't transact" is a decision for the trading path to
// make with the evidence, not a reason to withhold the evidence.
//
// VERIFIED, NOT ASSUMED. Chainlink's presence on this chain was checked before
// any of this was written: 57 feeds are published for Robinhood Chain,
// including one per Stock Token, and GOOGL/USD was read live at 332.00375
// against a pool price of 332.48 — 0.14% apart. That measurement is what makes
// the tolerance below a number rather than a guess.
package chain

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// Function selectors, all four bytes of keccak(signature)[0:4].
const (
	selSlot0           = "0x3850c7bd" // slot0()
	selToken0          = "0x0dfe1681" // token0()
	selToken1          = "0xd21220a7" // token1()
	selLatestRoundData = "0xfeaf968c" // latestRoundData()
	selDecimals        = "0x313ce567" // decimals()
)

// TokenConfig describes one tradeable symbol: where its pool is and which feed
// referees it.
type TokenConfig struct {
	Symbol   string `json:"symbol"`
	Sector   string `json:"sector"`
	Address  string `json:"address"`
	Decimals int    `json:"decimals"`
	Pool     string `json:"pool"`
	PoolFee  int    `json:"pool_fee"`
	Feed     string `json:"feed"`
	FeedName string `json:"feed_name"`
}

// Config is the chain description market-data reads prices against.
//
// A FILE IN GIT, not environment. Which pool a symbol's price comes from is
// part of what a score means — change it and every subsequent measurement is
// of something else — so it is reviewable and dated, exactly like the universe
// file and the signer's allowlist. Only the path comes from the environment.
type Config struct {
	ChainID    int64  `json:"chain_id"`
	Name       string `json:"name"`
	ReviewedAt string `json:"reviewed_at"`
	ReviewedBy string `json:"reviewed_by"`
	QuoteToken struct {
		Symbol   string `json:"symbol"`
		Address  string `json:"address"`
		Decimals int    `json:"decimals"`
	} `json:"quote_token"`
	// DisputeTolerancePct is how far the pool may sit from the feed before a
	// quote is marked disputed.
	DisputeTolerancePct float64 `json:"dispute_tolerance_pct"`
	// FeedMaxAgeSeconds is how stale a feed answer may be and still referee.
	FeedMaxAgeSeconds int64 `json:"feed_max_age_seconds"`
	Tokens            []TokenConfig `json:"tokens"`
}

// LoadConfig reads and validates the chain description.
func LoadConfig(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read chain config %s: %w", path, err)
	}
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse chain config %s: %w", path, err)
	}
	if c.ChainID == 0 {
		return nil, errors.New("chain config: chain_id is required")
	}
	if len(c.Tokens) == 0 {
		return nil, errors.New("chain config: no tokens")
	}
	if c.QuoteToken.Decimals == 0 {
		return nil, errors.New("chain config: quote_token.decimals is required")
	}
	if c.DisputeTolerancePct <= 0 {
		return nil, errors.New("chain config: dispute_tolerance_pct must be > 0")
	}
	if c.FeedMaxAgeSeconds <= 0 {
		return nil, errors.New("chain config: feed_max_age_seconds must be > 0")
	}
	seen := map[string]bool{}
	for i, t := range c.Tokens {
		if t.Symbol == "" || t.Address == "" || t.Pool == "" {
			return nil, fmt.Errorf("chain config: token %d is missing symbol, address or pool", i)
		}
		if t.Decimals == 0 {
			return nil, fmt.Errorf("chain config: %s has no decimals", t.Symbol)
		}
		if seen[t.Symbol] {
			return nil, fmt.Errorf("chain config: %s appears twice", t.Symbol)
		}
		seen[t.Symbol] = true
	}
	return &c, nil
}

// Client calls eth_call against a list of endpoints, in order.
//
// The same shape as the signer's chain client and for the same reason: two
// otherwise-plausible providers on this chain serve eth_chainId and refuse
// eth_call, so an endpoint list checked the easy way looks redundant and is
// not. Endpoints are tried in order and the first real answer wins.
type Client struct {
	urls []string
	http *http.Client

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
			// A node that refuses eth_call refuses it for everything, so mark
			// it rather than paying the round trip on every symbol.
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

// words splits a hex return value into 32-byte words.
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

// wordToAddress reads the low 20 bytes of a word as an address.
func wordToAddress(w string) string {
	if len(w) < 40 {
		return ""
	}
	return "0x" + strings.ToLower(w[len(w)-40:])
}

// PoolPrice reads a Uniswap V3 pool's spot price for one Stock Token, quoted
// in the quote token.
//
// FROM slot0, WHICH IS THE SPOT PRICE AND NOT A FILL. sqrtPriceX96 is the
// price at the current tick with no size attached; an actual swap moves
// through the curve and pays a fee. That is correct for a SNAPSHOT — a
// snapshot is a mark, not a quote for a specific size — and the difference
// between the two is exactly why the signer simulates the real calldata before
// signing rather than trusting this number.
//
// The token ordering is READ FROM THE POOL, never assumed. Uniswap orders
// token0/token1 by address, so which side the Stock Token sits on varies per
// pool, and getting it backwards inverts the price into something that still
// looks like a number.
func (c *Client) PoolPrice(ctx context.Context, t TokenConfig, quoteDecimals int) (float64, error) {
	slot0, err := c.Call(ctx, t.Pool, selSlot0)
	if err != nil {
		return 0, fmt.Errorf("%s slot0: %w", t.Symbol, err)
	}
	w := words(slot0)
	if len(w) == 0 {
		return 0, fmt.Errorf("%s slot0: empty", t.Symbol)
	}
	sqrtPriceX96 := wordToBig(w[0])
	if sqrtPriceX96.Sign() == 0 {
		return 0, fmt.Errorf("%s pool is uninitialised (sqrtPriceX96 = 0)", t.Symbol)
	}

	token0Raw, err := c.Call(ctx, t.Pool, selToken0)
	if err != nil {
		return 0, fmt.Errorf("%s token0: %w", t.Symbol, err)
	}
	token0 := wordToAddress(words(token0Raw)[0])
	stockIsToken0 := strings.EqualFold(token0, t.Address)

	// price(token1 per token0) = (sqrtPriceX96 / 2^96)^2, in RAW units.
	//
	// Computed in big.Float rather than float64 throughout: sqrtPriceX96 is up
	// to 160 bits, and squaring it in float64 loses the low bits before the
	// division ever happens.
	q96 := new(big.Float).SetFloat64(math.Pow(2, 96))
	sp := new(big.Float).SetInt(sqrtPriceX96)
	ratio := new(big.Float).Quo(sp, q96)
	ratio.Mul(ratio, ratio) // token1 per token0, raw units

	// Convert raw to human.
	//
	// THE DECIMAL CORRECTION IS THE SAME IN BOTH BRANCHES, and getting that
	// wrong is how this was caught: the first version used
	// 10^(quoteDec-stockDec) on the inverted side, and five of the nine pools
	// — the ones where address ordering puts the Stock Token second — returned
	// prices around 3e-22, which `toFixed(4)` renders as a tidy `0.0000`.
	//
	// The derivation, because the sign is not obvious by inspection. With
	// R = token1_raw / token0_raw and price = quote_human / stock_human:
	//
	//   stock is token0:  R = quote_raw/stock_raw, so price = R * 10^(sd-qd)
	//   stock is token1:  R = stock_raw/quote_raw, so price = (1/R) * 10^(sd-qd)
	//
	// Inverting changes which ratio you start from, not which decimals the two
	// human amounts carry.
	scale := big.NewFloat(math.Pow(10, float64(t.Decimals-quoteDecimals)))
	var human *big.Float
	if stockIsToken0 {
		human = ratio
	} else {
		human = new(big.Float).Quo(big.NewFloat(1), ratio)
	}
	human.Mul(human, scale)

	out, _ := human.Float64()
	if !(out > 0) || math.IsInf(out, 0) || math.IsNaN(out) {
		return 0, fmt.Errorf("%s pool price is not a usable number: %v", t.Symbol, out)
	}
	return out, nil
}

// FeedAnswer is one Chainlink reading.
type FeedAnswer struct {
	Price     float64
	UpdatedAt time.Time
	Decimals  int
}

// FeedPrice reads the Chainlink aggregator for a symbol.
//
// `updatedAt` is returned rather than swallowed because a feed that has stopped
// updating still answers, cheerfully, with its last value. A referee quoting a
// price from yesterday would either wave through a real manipulation or
// dispute an honest move, and there is no way to tell which from the number
// alone.
func (c *Client) FeedPrice(ctx context.Context, feed string) (FeedAnswer, error) {
	var out FeedAnswer
	if feed == "" {
		return out, errors.New("no feed configured")
	}
	decRaw, err := c.Call(ctx, feed, selDecimals)
	if err != nil {
		return out, fmt.Errorf("feed decimals: %w", err)
	}
	dec := int(wordToBig(words(decRaw)[0]).Int64())
	if dec < 0 || dec > 36 {
		return out, fmt.Errorf("feed reports implausible decimals %d", dec)
	}

	raw, err := c.Call(ctx, feed, selLatestRoundData)
	if err != nil {
		return out, fmt.Errorf("latestRoundData: %w", err)
	}
	w := words(raw)
	if len(w) < 5 {
		return out, fmt.Errorf("latestRoundData returned %d words, expected 5", len(w))
	}
	// (roundId, answer, startedAt, updatedAt, answeredInRound)
	answer := wordToBig(w[1])
	if answer.Sign() <= 0 {
		// int256; a negative answer is a real possibility for some feeds and
		// never valid for an equity price.
		return out, fmt.Errorf("feed answer is not positive: %s", answer.String())
	}
	updated := wordToBig(w[3]).Int64()

	scaled := new(big.Float).SetInt(answer)
	scaled.Quo(scaled, big.NewFloat(math.Pow(10, float64(dec))))
	price, _ := scaled.Float64()

	out.Price = price
	out.Decimals = dec
	out.UpdatedAt = time.Unix(updated, 0).UTC()
	return out, nil
}

// Verdict is what the referee concluded about one symbol.
type Verdict struct {
	PoolPrice     float64
	FeedPrice     float64
	DeviationPct  float64
	FeedUpdatedAt time.Time
	// Status is "agreed", "disputed", or "unrefereed".
	//
	// "unrefereed" is its own answer and not a synonym for "agreed": it means
	// the feed could not be read or was too stale to referee with. Collapsing
	// it into agreement would silently remove the check on exactly the
	// occasions it stopped working.
	Status string
	Note   string
}

// Referee compares a pool price against its feed.
func Referee(cfg *Config, t TokenConfig, pool float64, feed FeedAnswer, feedErr error, now time.Time) Verdict {
	v := Verdict{PoolPrice: pool}
	if feedErr != nil || feed.Price <= 0 {
		v.Status = "unrefereed"
		v.Note = "no Chainlink answer for this symbol; the pool price is unchecked"
		if feedErr != nil {
			v.Note = "Chainlink unreadable: " + feedErr.Error()
		}
		return v
	}
	v.FeedPrice = feed.Price
	v.FeedUpdatedAt = feed.UpdatedAt

	age := now.Sub(feed.UpdatedAt)
	if age > time.Duration(cfg.FeedMaxAgeSeconds)*time.Second {
		v.Status = "unrefereed"
		v.Note = fmt.Sprintf(
			"Chainlink answer is %s old (limit %ds); too stale to referee with. A feed that "+
				"has stopped updating still answers, and a stale referee either waves through a "+
				"manipulation or disputes an honest move",
			age.Round(time.Minute), cfg.FeedMaxAgeSeconds)
		return v
	}

	dev := math.Abs(pool-feed.Price) / feed.Price * 100
	v.DeviationPct = math.Round(dev*1000) / 1000
	if dev > cfg.DisputeTolerancePct {
		v.Status = "disputed"
		v.Note = fmt.Sprintf(
			"pool %.6f is %.3f%% from Chainlink %.6f (tolerance %.2f%%)",
			pool, dev, feed.Price, cfg.DisputeTolerancePct)
		return v
	}
	v.Status = "agreed"
	return v
}
