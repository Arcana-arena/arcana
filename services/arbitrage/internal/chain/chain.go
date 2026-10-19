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
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	selSlot0       = "0x3850c7bd" // slot0()
	selToken0      = "0x0dfe1681" // token0()
	selLiquidity   = "0x1a686502" // liquidity()
	selTickSpacing = "0xd0c93a7c" // tickSpacing()
	selPositions   = "0x99fbab88" // positions(uint256) on the NonfungiblePositionManager
	selOwnerOf     = "0x6352211e" // ownerOf(uint256) (ERC721)
	selTotalSupply = "0x18160ddd" // totalSupply()
	selGetPool     = "0x1698ee82" // getPool(address,address,uint24) on the v3 factory

	// The ERC-721 Transfer event topic, used to discover position NFTs by
	// recipient without knowing a tokenId in advance.
	topicTransfer = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
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
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// doRPC performs one JSON-RPC request against the endpoint list, in order, and
// returns the first result that passes validate. Every provider call goes
// through here, so the failover order and the quarantine rule ("method" errors
// mark an endpoint broken) are stated once and cannot drift between methods.
//
// A result that validate rejects is not returned to the caller as a failure —
// it continues to the next endpoint, exactly as the empty eth_call result
// always has: two endpoints that answer differently are a reason to keep
// asking, not to give up. label names the request in error messages.
func (c *Client) doRPC(ctx context.Context, method string, params []any, label string, validate func(json.RawMessage) error) (json.RawMessage, string, error) {
	var lastErr error
	for _, url := range c.urls {
		c.mu.Lock()
		skip := c.broken[url]
		c.mu.Unlock()
		if skip {
			continue
		}
		body, err := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: 1, Method: method, Params: params})
		if err != nil {
			return nil, "", err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(body)))
		if err != nil {
			return nil, "", err
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
		if len(out.Result) == 0 {
			lastErr = fmt.Errorf("empty result from %s for %s", url, label)
			continue
		}
		if validate != nil {
			if verr := validate(out.Result); verr != nil {
				lastErr = fmt.Errorf("%s from %s for %s", verr, url, label)
				continue
			}
		}
		return out.Result, url, nil
	}
	if lastErr == nil {
		lastErr = errors.New("no rpc endpoint answered")
	}
	return nil, "", lastErr
}

// Call performs eth_call and returns the raw hex result.
func (c *Client) Call(ctx context.Context, to, data string) (string, error) {
	var hex string
	_, _, err := c.doRPC(ctx, "eth_call",
		[]any{map[string]string{"to": to, "data": data}, "latest"}, to,
		func(raw json.RawMessage) error {
			if err := json.Unmarshal(raw, &hex); err != nil {
				return fmt.Errorf("eth_call result is not a string: %w", err)
			}
			if hex == "" || hex == "0x" {
				return errors.New("empty result")
			}
			return nil
		})
	if err != nil {
		return "", err
	}
	return hex, nil
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

// --- LP positions ------------------------------------------------------------

func padUint(v *big.Int) string {
	h := v.Text(16)
	if len(h) >= 64 {
		return h[len(h)-64:]
	}
	return strings.Repeat("0", 64-len(h)) + h
}

func padAddress(a string) string {
	h := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(a)), "0x")
	if len(h) > 40 {
		h = h[len(h)-40:]
	}
	return strings.Repeat("0", 64-len(h)) + h
}

func wordToInt24(w string) int32 {
	v := wordToBig(w)
	if v.Bit(255) == 1 {
		v.Sub(v, new(big.Int).Lsh(big.NewInt(1), 256))
	}
	return int32(v.Int64())
}

// Position is one NonfungiblePositionManager position, as positions(tokenId)
// returns it. TokensOwed0/1 are the fees stored at the last position touch, not
// the exact accrued total — computing the live accrual needs the pool's
// feeGrowthInside, which this first slice does not read.
type Position struct {
	Nonce       *big.Int
	Operator    string
	Token0      string
	Token1      string
	Fee         uint32
	TickLower   int32
	TickUpper   int32
	Liquidity   *big.Int
	TokensOwed0 *big.Int
	TokensOwed1 *big.Int
}

// Position reads one position from the position manager.
func (c *Client) Position(ctx context.Context, npm string, tokenID *big.Int) (*Position, error) {
	raw, err := c.Call(ctx, npm, selPositions+padUint(tokenID))
	if err != nil {
		return nil, err
	}
	w := words(raw)
	if len(w) < 12 {
		return nil, fmt.Errorf("positions returned %d words, expected 12", len(w))
	}
	return &Position{
		Nonce:       wordToBig(w[0]),
		Operator:    wordToAddress(w[1]),
		Token0:      wordToAddress(w[2]),
		Token1:      wordToAddress(w[3]),
		Fee:         uint32(wordToBig(w[4]).Uint64()),
		TickLower:   wordToInt24(w[5]),
		TickUpper:   wordToInt24(w[6]),
		Liquidity:   wordToBig(w[7]),
		TokensOwed0: wordToBig(w[10]),
		TokensOwed1: wordToBig(w[11]),
	}, nil
}

// OwnerOf reports who owns a position NFT.
func (c *Client) OwnerOf(ctx context.Context, npm string, tokenID *big.Int) (string, error) {
	raw, err := c.Call(ctx, npm, selOwnerOf+padUint(tokenID))
	if err != nil {
		return "", err
	}
	w := words(raw)
	if len(w) == 0 {
		return "", errors.New("ownerOf empty")
	}
	return wordToAddress(w[0]), nil
}

// TotalSupply reports how many positions exist. Used to find a live position
// for read-only verification without knowing any tokenId in advance.
func (c *Client) TotalSupply(ctx context.Context, npm string) (*big.Int, error) {
	raw, err := c.Call(ctx, npm, selTotalSupply)
	if err != nil {
		return nil, err
	}
	w := words(raw)
	if len(w) == 0 {
		return nil, errors.New("totalSupply empty")
	}
	return wordToBig(w[0]), nil
}

// GetPool resolves a pool from the factory. An empty address means no pool
// exists for that pair and fee.
func (c *Client) GetPool(ctx context.Context, factory, tokenA, tokenB string, fee uint32) (string, error) {
	data := selGetPool + padAddress(tokenA) + padAddress(tokenB) + padUint(new(big.Int).SetUint64(uint64(fee)))
	raw, err := c.Call(ctx, factory, data)
	if err != nil {
		return "", err
	}
	w := words(raw)
	if len(w) == 0 {
		return "", errors.New("getPool empty")
	}
	addr := wordToAddress(w[0])
	if addr == "0x0000000000000000000000000000000000000000" {
		return "", nil
	}
	return addr, nil
}

// --- discovery ---------------------------------------------------------------

// BlockNumber returns the chain's latest block height.
func (c *Client) BlockNumber(ctx context.Context) (int64, error) {
	var hex string
	_, _, err := c.doRPC(ctx, "eth_blockNumber", []any{}, "eth_blockNumber",
		func(raw json.RawMessage) error {
			if err := json.Unmarshal(raw, &hex); err != nil {
				return fmt.Errorf("block number is not a string: %w", err)
			}
			if hex == "" || hex == "0x" {
				return errors.New("empty result")
			}
			return nil
		})
	if err != nil {
		return 0, err
	}
	n, err := strconv.ParseInt(strings.TrimPrefix(hex, "0x"), 16, 64)
	if err != nil {
		return 0, fmt.Errorf("block number %q is not hex: %w", hex, err)
	}
	return n, nil
}

// TransferLog is one ERC-721 Transfer emitted by a contract, filtered to the
// recipients the caller asked about.
type TransferLog struct {
	Block   int64
	To      string
	TokenID *big.Int
}

// PositionTransfersTo reads the Transfer logs of an ERC-721 contract whose
// recipient is one of `to` — how a position is discovered without knowing its
// tokenId in advance. fromBlock and toBlock are inclusive; providers cap how
// many blocks one query may span (the reviewed endpoint allows 100,000 for a
// recipient-filtered query), so callers scan in windows. The recipients go in
// one OR array, so a query covers every agent wallet at once instead of one
// round trip per wallet.
func (c *Client) PositionTransfersTo(ctx context.Context, contract string, to []string, fromBlock, toBlock int64) ([]TransferLog, error) {
	if len(to) == 0 || fromBlock > toBlock {
		return nil, nil
	}
	recipients := make([]string, 0, len(to))
	for _, a := range to {
		recipients = append(recipients, "0x"+padAddress(a))
	}
	params := []any{map[string]any{
		"address":   contract,
		"topics":    []any{topicTransfer, nil, recipients},
		"fromBlock": fmt.Sprintf("0x%x", fromBlock),
		"toBlock":   fmt.Sprintf("0x%x", toBlock),
	}}
	label := fmt.Sprintf("logs %s %d..%d", contract, fromBlock, toBlock)
	raw, _, err := c.doRPC(ctx, "eth_getLogs", params, label, nil)
	if err != nil {
		return nil, err
	}
	var entries []struct {
		Topics      []string `json:"topics"`
		BlockNumber string   `json:"blockNumber"`
	}
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, fmt.Errorf("parse %s: %w", label, err)
	}
	out := make([]TransferLog, 0, len(entries))
	for _, e := range entries {
		// A Transfer carries four topics: event, from, to, tokenId. Anything
		// else is a log this method did not ask for, and guessing at it could
		// register the wrong tokenId — so it is refused rather than skipped.
		if len(e.Topics) != 4 {
			return nil, fmt.Errorf("%s: transfer log has %d topics, expected 4", label, len(e.Topics))
		}
		block, err := strconv.ParseInt(strings.TrimPrefix(e.BlockNumber, "0x"), 16, 64)
		if err != nil {
			return nil, fmt.Errorf("%s: block %q is not hex: %w", label, e.BlockNumber, err)
		}
		id := new(big.Int)
		if _, ok := id.SetString(strings.TrimPrefix(e.Topics[3], "0x"), 16); !ok {
			return nil, fmt.Errorf("%s: token id %q is not hex", label, e.Topics[3])
		}
		out = append(out, TransferLog{Block: block, To: wordToAddress(strings.TrimPrefix(e.Topics[2], "0x")), TokenID: id})
	}
	return out, nil
}
