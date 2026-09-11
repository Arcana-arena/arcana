package execution

import (
	"context"
	"fmt"
	"math/big"
	"net/http"
	"time"
)

// Status values written to executions.status.
const (
	StatusMined       = "mined"        // mined, status 0x1, funds moved
	StatusReverted    = "reverted"     // mined, status 0x0: gas paid, nothing moved
	StatusUnresolved  = "unresolved"   // broadcast, not mined inside the wait
	StatusRefused     = "refused"      // the signer declined; nothing was sent
	StatusQuoteFailed = "quote_failed" // the simulation reverted; nothing was sent
	StatusBlocked     = "blocked"      // a precondition failed; nothing was sent
)

// Result is everything that can only be known afterwards.
//
// Filled is nil unless a fill was MEASURED. It is never defaulted to zero,
// because zero means "moved nothing" and nil means "not known yet", and an
// unresolved transaction is the second one.
type Result struct {
	Status       string
	IntentAction string
	Symbol       string
	TokenIn      string
	TokenOut     string
	AmountIn     *big.Int
	QuotedOut    *big.Int
	MinOut       *big.Int
	Filled       *big.Int
	SlippageBps  *float64
	TxHash       string
	BlockNumber  int64
	GasUsed      int64
	GasPriceWei  *big.Int
	GasCostWei   *big.Int
	RefusalCode  string
	Note         string

	// Approve is set when the broker had to grant an allowance first. It is a
	// separate transaction with its own hash, nonce and gas bill, so it is
	// reported separately rather than averaged into the swap.
	Approve *ApproveRecord
}

// Moved reports whether funds actually changed hands.
func (r *Result) Moved() bool {
	return r.Status == StatusMined && r.Filled != nil && r.Filled.Sign() > 0
}

// Broker runs one trade from intent to recorded outcome.
type Broker struct {
	cfg    *Config
	rpc    *RPC
	signer *SignerClient

	// SlippageBps is how far below the quote the swap may still fill. It goes
	// INTO the transaction as min_out, so the chain enforces it rather than
	// this process checking afterwards and finding out too late.
	SlippageBps int64
	// ReceiptWait bounds how long a broadcast transaction is followed before
	// it is recorded as unresolved.
	ReceiptWait time.Duration
	PollEvery   time.Duration
	// GasLimit and fees mirror the signer defaults, sent explicitly so the
	// reserve checked here is the reserve the transaction actually uses.
	GasLimit  uint64
	MaxFeeWei *big.Int
	TipWei    *big.Int
}

func NewBroker(cfg *Config, rpc *RPC, signer *SignerClient) *Broker {
	return &Broker{
		cfg: cfg, rpc: rpc, signer: signer,
		SlippageBps: 100,
		ReceiptWait: 90 * time.Second,
		PollEvery:   time.Second,
		GasLimit:    250000,
		MaxFeeWei:   big.NewInt(1000000000),
		TipWei:      big.NewInt(20000000),
	}
}

// Request is one intent, expressed the way the decider expresses it.
type Request struct {
	AgentID string
	Wallet  string
	Action  string // buy | sell
	Symbol  string
	Qty     float64 // shares
	Price   float64 // USD per share, from the market snapshot
}

// HTTPClient is the shared client for signer calls.
func HTTPClient(timeout time.Duration) *http.Client { return &http.Client{Timeout: timeout} }

func trim0x(s string) string {
	if len(s) > 2 && (s[:2] == "0x" || s[:2] == "0X") {
		return s[2:]
	}
	return s
}

// priceOfInput is the USD price of the token being SPENT, which is what the
// signer notional cap is expressed against. For a buy that is the quote token
// at 1.0; for a sell it is the share price from the snapshot.
func priceOfInput(req Request, tokenIn, quote TokenCfg) float64 {
	if tokenIn.Address == quote.Address {
		return 1.0
	}
	return req.Price
}


// DecimalsOf is the token precision the engine needs to turn base units back
// into shares. An unknown symbol returns 18, which is every Stock Token on
// this chain; the quote token is asked for by address, never by this path.
func (b *Broker) DecimalsOf(symbol string) int {
	if t, err := b.cfg.Token(symbol); err == nil {
		return t.Decimals
	}
	return 18
}

// QuoteDecimals is the precision of the cash token.
func (b *Broker) QuoteDecimals() int { return b.cfg.QuoteToken.Decimals }

// AddressOf is the token contract behind a symbol, for the drift record.
func (b *Broker) AddressOf(symbol string) string {
	if t, err := b.cfg.Token(symbol); err == nil {
		return t.Address
	}
	return ""
}

// Position is one reading of a wallet, kept in BOTH representations.
//
// The chain answers in integers and the portfolio is denominated in dollars
// and shares, and both are needed every cycle: the integers for reconciliation,
// the decimals for the snapshot a person reads. Deriving one from the other
// here means the chain is read ONCE. The first version called two separate
// readers and made twenty sequential eth_calls before the agent had decided
// anything, which is also how a single slow endpoint took a whole cycle down.
type Position struct {
	Units     map[string]*big.Int
	CashUnits *big.Int
	Holdings  map[string]float64
	Cash      float64
}

// Read takes one complete reading of the wallet.
func (b *Broker) Read(ctx context.Context, wallet string) (*Position, error) {
	cash, err := b.rpc.TokenBalance(ctx, b.cfg.QuoteToken.Address, wallet)
	if err != nil {
		return nil, fmt.Errorf("read cash: %w", err)
	}
	p := &Position{
		Units:     map[string]*big.Int{},
		CashUnits: cash,
		Holdings:  map[string]float64{},
		Cash:      unitsToFloat(cash, b.cfg.QuoteToken.Decimals),
	}
	for _, t := range b.cfg.Tokens {
		v, err := b.rpc.TokenBalance(ctx, t.Address, wallet)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", t.Symbol, err)
		}
		p.Units[t.Symbol] = v
		if v.Sign() > 0 {
			p.Holdings[t.Symbol] = unitsToFloat(v, t.Decimals)
		}
	}
	return p, nil
}

// ApproveRecord is the ERC-20 approval the broker sent before a swap.
//
// IT GETS ITS OWN ROW because it is its own transaction: it is broadcast, it
// consumes a nonce, and it costs real gas. The first version folded it into
// nothing at all — the swap's receipt overwrote the Result's gas fields and the
// approval's cost vanished. Measured on the first cadence-era agent, that was
// 7,295,400,482,000 wei, 26% of everything it had spent, with no row anywhere.
//
// Gas is an operating cost rather than a trading result, so it stays out of NAV
// and out of the score. An operating cost still has to be RECORDED: one that is
// not cannot be budgeted, and the first sign of it is a wallet that has quietly
// stopped being able to trade.
//
// Filled is meaningless here and is left NULL rather than zero — an approval
// moves nothing by design, which is different from a swap that moved nothing.
type ApproveRecord struct {
	TxHash      string
	Status      string
	GasUsed     int64
	GasPriceWei *big.Int
	GasCostWei  *big.Int
	Amount      *big.Int
	Token       string
	Note        string
}
