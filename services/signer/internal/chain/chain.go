// Package chain answers the two questions the issuer can change under us.
//
// The Stock Tokens ARCANA trades carry a BLOCKLIST and a PAUSE, both held by
// the issuer, both usable without notice (docs/go-no-go-stock-tokens.md,
// conditions 1 and 2). Either one makes a transfer revert on chain.
//
// WHERE EACH CHECK BELONGS, and this was a decision rather than an accident:
//
//	wallet_blocked  -> PRIMARY HOME IS THE SIGNER.
//	    It is a property of the KEY the signer is about to use. The signer is
//	    the only component that knows which key that is, and it is the last
//	    thing to run before a signature exists. Checking it anywhere else means
//	    every future caller has to remember; checking it here means none of
//	    them can forget.
//
//	token_paused    -> PRIMARY HOME IS THE DECISION ENGINE, backstopped here.
//	    A paused token should stop an agent EARLIER than signing: before
//	    inference is purchased, before a decision is recorded that can never
//	    settle. But the issuer can pause between deciding and signing, so the
//	    signer checks it too. It is a backstop, not the owner of the rule.
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
	"log"
	"math/big"
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

// Preflight drops endpoints that cannot serve eth_call.
//
// An endpoint that answers eth_chainId and refuses eth_call is worse than no
// endpoint: it makes a list look redundant while contributing nothing, so
// nobody goes looking when the one real provider has a bad hour. Two
// independent providers on this chain behave exactly that way, which is why
// this is checked rather than assumed.
//
// It runs at boot, so a provider that changes its tier is noticed on the next
// restart instead of at the moment a signature is needed.
func (c *Client) Preflight(ctx context.Context) {
	probe := "0x313ce567" // decimals(), on a contract that certainly exists
	usable := make([]string, 0, len(c.urls))
	for _, u := range c.urls {
		saved := c.urls
		c.urls = []string{u}
		_, err := c.call(ctx, probeContract, strings.TrimPrefix(probe, "0x"))
		c.urls = saved
		if err != nil {
			log.Printf("signer: RPC endpoint dropped: %s — cannot serve eth_call (%v)", u, err)
			continue
		}
		usable = append(usable, u)
	}
	if len(usable) == 0 {
		log.Printf("signer: WARN no RPC endpoint can serve eth_call. Every signing request will be " +
			"refused with chain_state_unverifiable, which is the correct behaviour and not a workaround.")
		return
	}
	// The total is captured BEFORE the assignment: reading len(c.urls) after it
	// would always print N/N and quietly claim every endpoint passed.
	total := len(c.urls)
	c.urls = usable
	log.Printf("signer: %d/%d RPC endpoints serve eth_call", len(usable), total)
}

// probeContract is USDG: an allowlisted token that certainly exists, used only
// to prove an endpoint can execute a call at all.
const probeContract = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"

func New(urls []string, chainID int64, ttl time.Duration) *Client {
	if ttl < 0 {
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

// RevertError is a call that reached the chain and was rejected BY THE
// CONTRACT, carrying whatever the contract returned.
//
// WHY THE DATA IS KEPT rather than flattened into a message. A revert with an
// empty payload and a revert with a custom-error selector are different facts
// about a contract, and one of them is how you tell "this function does not
// exist" from "this function said no". The allowlist can record the exact
// payload a token is known to produce, and the signer can then check that the
// token STILL produces it — which is the only way an exception can expire on
// its own instead of outliving its reason. Flattening the payload into prose
// would make that comparison impossible.
//
// It is still an ErrUnverifiable: a caller that does not care about the
// payload keeps refusing exactly as before.
type RevertError struct {
	Message string
	Data    string
}

func (e *RevertError) Error() string {
	if e.Data != "" {
		return fmt.Sprintf("%v: %s (revert data %s)", ErrUnverifiable, e.Message, e.Data)
	}
	return fmt.Sprintf("%v: %s (revert with no data)", ErrUnverifiable, e.Message)
}

func (e *RevertError) Unwrap() error { return ErrUnverifiable }

// isRevert distinguishes the contract saying no from the network failing to
// ask. Node implementations word it differently; all of them say "revert".
func isRevert(msg string) bool {
	return strings.Contains(strings.ToLower(msg), "revert")
}

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
				Data    string `json:"data"`
			} `json:"error"`
		}
		if err := json.Unmarshal(raw, &parsed); err != nil {
			lastErr = err
			continue
		}
		if parsed.Error != nil {
			// A REVERT IS NOT A REASON TO ASK ANOTHER NODE. It is the
			// contract's own answer and every honest node returns it, so
			// retrying elsewhere only blurs a deterministic contract fact into
			// what looks like a transport problem. Transport failures still
			// fall through to the next URL below.
			if isRevert(parsed.Error.Message) {
				return "", &RevertError{Message: parsed.Error.Message, Data: parsed.Error.Data}
			}
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

// --- Morpho debt, for the per-agent cap --------------------------------------

const (
	selPosition = "93c52062" // position(bytes32,address) -> (supplyShares, borrowShares, collateral)
	selMarket   = "5c60e39a" // market(bytes32) -> (totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee)
)

// Morpho's virtual offsets, from SharesMathLib. Shares convert to assets as
// shares * (totalAssets + 1) / (totalShares + 1e6).
var (
	virtualShares = new(big.Int).Exp(big.NewInt(10), big.NewInt(6), nil)
	virtualAssets = big.NewInt(1)
)

// DebtOf is the wallet's borrowed assets in a Morpho market, in the loan
// token's base units, ROUNDED UP — the way Morpho itself values debt, so the
// cap is never checked against a number smaller than the one owed.
//
// NEVER CACHED. The cap is only a cap if it sees the borrow that just happened;
// a cached debt is the one read that can let two borrows through where one fits.
// Interest accrued since the market's last update is not included, which makes
// this a floor on the debt by at most that interest.
func (c *Client) DebtOf(ctx context.Context, morpho, marketID, wallet string) (*big.Int, error) {
	id := strings.TrimPrefix(strings.ToLower(marketID), "0x")
	if len(id) != 64 {
		return nil, fmt.Errorf("market id %q is not 32 bytes", marketID)
	}
	pos, err := c.call(ctx, morpho, selPosition+id+strings.Repeat("0", 24)+strings.TrimPrefix(strings.ToLower(wallet), "0x"))
	if err != nil {
		return nil, err
	}
	shares, err := wordAt(pos, 1)
	if err != nil {
		return nil, fmt.Errorf("position(): %w", err)
	}
	if shares.Sign() == 0 {
		return new(big.Int), nil
	}
	mkt, err := c.call(ctx, morpho, selMarket+id)
	if err != nil {
		return nil, err
	}
	totalAssets, err := wordAt(mkt, 2)
	if err != nil {
		return nil, fmt.Errorf("market(): %w", err)
	}
	totalShares, err := wordAt(mkt, 3)
	if err != nil {
		return nil, fmt.Errorf("market(): %w", err)
	}
	num := new(big.Int).Mul(shares, new(big.Int).Add(totalAssets, virtualAssets))
	den := new(big.Int).Add(totalShares, virtualShares)
	q, r := new(big.Int).QuoRem(num, den, new(big.Int))
	if r.Sign() > 0 {
		q.Add(q, big.NewInt(1))
	}
	return q, nil
}

// wordAt reads the i-th 32-byte word of an ABI-encoded result.
func wordAt(hexResult string, i int) (*big.Int, error) {
	body := strings.TrimPrefix(hexResult, "0x")
	if len(body) < (i+1)*64 {
		return nil, fmt.Errorf("short answer: %d hex chars, wanted word %d", len(body), i)
	}
	v, ok := new(big.Int).SetString(body[i*64:(i+1)*64], 16)
	if !ok {
		return nil, fmt.Errorf("word %d is not hex", i)
	}
	return v, nil
}
