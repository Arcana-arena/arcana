// Package chain answers the two questions the issuer can change under us.
//
// The Stock Tokens ARCANA trades carry a BLOCKLIST and a PAUSE, both held by
// the issuer, both usable without notice (docs/go-no-go-stock-tokens.md,
// conditions 1 and 2). Either one makes a transfer revert on chain.
//
// WHERE EACH CHECK BELONGS, and this was a decision rather than an accident:
//
//   wallet_blocked  -> PRIMARY HOME IS THE SIGNER.
//       It is a property of the KEY the signer is about to use. The signer is
//       the only component that knows which key that is, and it is the last
//       thing to run before a signature exists. Checking it anywhere else means
//       every future caller has to remember; checking it here means none of
//       them can forget.
//
//   token_paused    -> PRIMARY HOME IS THE DECISION ENGINE, backstopped here.
//       A paused token should stop an agent EARLIER than signing: before
//       inference is purchased, before a decision is recorded that can never
//       settle. But the issuer can pause between deciding and signing, so the
//       signer checks it too. It is a backstop, not the owner of the rule.
//
// AND THE RULE THAT BINDS BOTH: if the chain cannot be read, the signer
// REFUSES. "Could not check" is not "fine". A signer that signs when it cannot
// verify is a signer whose checks disappear exactly when the network is having
// the kind of day on which things go wrong.
package chain

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	selPaused    = "5c975abb" // paused()
	selIsBlocked = "fbac3951" // isBlocked(address)
)

type Client struct {
	urls    []string
	http    *http.Client
	chainID int64

	mu    sync.Mutex
	cache map[string]entry
	ttl   time.Duration
}

type entry struct {
	val bool
	at  time.Time
}

func New(urls []string, chainID int64, ttl time.Duration) *Client {
	if ttl == 0 {
		ttl = 30 * time.Second
	}
	return &Client{
		urls: urls, chainID: chainID, ttl: ttl,
		http:  &http.Client{Timeout: 8 * time.Second},
		cache: map[string]entry{},
	}
}

// ErrUnverifiable means the chain could not be read. The caller must refuse.
var ErrUnverifiable = fmt.Errorf("chain state could not be read")

func (c *Client) call(ctx context.Context, to, data string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "eth_call",
		"params": []any{map[string]string{"to": to, "data": "0x" + data}, "latest"},
	})
	var lastErr error
	for _, u := range c.urls {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
		if err != nil {
			lastErr = err
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		res, err := c.http.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<16))
		res.Body.Close()
		var parsed struct {
			Result string `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(raw, &parsed); err != nil {
			lastErr = err
			continue
		}
		if parsed.Error != nil {
			lastErr = fmt.Errorf("%s", parsed.Error.Message)
			continue
		}
		return parsed.Result, nil
	}
	return "", fmt.Errorf("%w: %v", ErrUnverifiable, lastErr)
}

func nonZero(hexResult string) bool {
	h := strings.TrimPrefix(hexResult, "0x")
	b, err := hex.DecodeString(h)
	if err != nil {
		return false
	}
	for _, x := range b {
		if x != 0 {
			return true
		}
	}
	return false
}

func (c *Client) cached(key string) (bool, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.cache[key]
	if !ok || time.Since(e.at) > c.ttl {
		return false, false
	}
	return e.val, true
}

func (c *Client) remember(key string, v bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cache[key] = entry{val: v, at: time.Now()}
}

// Paused reports whether the issuer has paused this token.
//
// A short TTL, not none: a signer that makes two RPC calls per signature adds a
// dependency to the hottest path it has. Thirty seconds is short enough that a
// pause cannot be missed for long and long enough that a burst of signatures
// does not become a burst of RPC.
func (c *Client) Paused(ctx context.Context, token string) (bool, error) {
	key := "paused:" + strings.ToLower(token)
	if v, ok := c.cached(key); ok {
		return v, nil
	}
	res, err := c.call(ctx, token, selPaused)
	if err != nil {
		return false, err
	}
	v := nonZero(res)
	c.remember(key, v)
	return v, nil
}

// Blocked reports whether the issuer has blocked this wallet.
//
// NOTE FROM THE GO/NO-GO TEST: isBlocked() currently REVERTS on these tokens,
// most likely delegating to a registry that is not set. A revert is returned as
// an error, which the caller turns into a refusal — never into "not blocked".
// The distinction between "checked and clear" and "could not check" is the one
// this codebase keeps having to relearn, and here it decides whether a key is
// used.
func (c *Client) Blocked(ctx context.Context, token, wallet string) (bool, error) {
	key := "blocked:" + strings.ToLower(token) + ":" + strings.ToLower(wallet)
	if v, ok := c.cached(key); ok {
		return v, nil
	}
	arg := strings.TrimPrefix(strings.ToLower(wallet), "0x")
	data := selIsBlocked + strings.Repeat("0", 64-len(arg)) + arg
	res, err := c.call(ctx, token, data)
	if err != nil {
		return false, err
	}
	v := nonZero(res)
	c.remember(key, v)
	return v, nil
}
