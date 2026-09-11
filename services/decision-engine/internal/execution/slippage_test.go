package execution

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// min_out is the only thing left that bounds the PRICE a trade fills at.
//
// The notional ceiling that used to bound its SIZE was removed on 2026-09-11 —
// how much of their own money an owner commits to one trade is trading style,
// not a platform decision. That leaves two things bounding a swap, and neither
// is a rule anybody chose: the wallet's balance, and this floor.
//
// So these tests ask three questions that used to be covered by the ceiling:
//
//	does min_out still exist at a size the old cap would have refused
//	does it SCALE with the trade rather than staying put
//	when it fires, does the record say SLIPPAGE rather than "reverted"
//
// The chain is a scripted HTTP server, because a slippage revert on the real
// pool cannot be arranged on demand and waiting for one would mean this check
// existed only in principle.

// --- a fake chain --------------------------------------------------------

type fakeChain struct {
	t *testing.T
	// swapCalldata is the data of the last eth_call to the router, which is how
	// min_out is inspected: it is a field inside the calldata, not a parameter
	// anywhere else.
	swapCalldata []string
	quote        *big.Int
	balance      *big.Int
	// receiptOK decides whether the broadcast transaction is recorded as
	// succeeded or reverted.
	receiptOK bool
	// replayRevert is what an eth_call returns AFTER the revert, which is how
	// the reason is recovered.
	replayRevert string
	calls        int
	// signed is the min_out of every signing request, which is the floor that
	// actually reaches the chain. The quote's calldata carries min_out = 0 by
	// design -- it is a simulation that sends nothing.
	signed  []string
	amounts []string
}

func (f *fakeChain) handler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Method string            `json:"method"`
		Params []json.RawMessage `json:"params"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	f.calls++
	reply := func(v any) {
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": v})
	}
	revert := func(msg, data string) {
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1,
			"error": map[string]any{"code": 3, "message": "execution reverted: " + msg, "data": data}})
	}
	hex32 := func(v *big.Int) string {
		h := v.Text(16)
		return "0x" + strings.Repeat("0", 64-len(h)) + h
	}

	switch req.Method {
	case "eth_call":
		var call struct {
			To   string `json:"to"`
			Data string `json:"data"`
		}
		_ = json.Unmarshal(req.Params[0], &call)
		switch {
		case strings.HasPrefix(call.Data, "0x70a08231"): // balanceOf
			reply(hex32(f.balance))
		case strings.HasPrefix(call.Data, "0xdd62ed3e"): // allowance
			reply(hex32(new(big.Int).Lsh(big.NewInt(1), 200))) // plenty, so no approve
		case strings.HasPrefix(call.Data, "0x04e45aaf"): // exactInputSingle
			f.swapCalldata = append(f.swapCalldata, call.Data)
			// AFTER the transaction reverted, the replay is the diagnosis.
			if f.replayRevert != "" && len(f.swapCalldata) > 1 {
				revert(f.replayRevert, encodeErrorString(f.replayRevert))
				return
			}
			reply(hex32(f.quote))
		default:
			reply("0x" + strings.Repeat("0", 64))
		}
	case "eth_getTransactionCount":
		reply("0x1")
	case "eth_getBalance":
		reply(hex32(new(big.Int).Lsh(big.NewInt(1), 64)))
	case "eth_sendRawTransaction":
		reply("0x" + strings.Repeat("ab", 32))
	case "eth_getTransactionReceipt":
		status := "0x1"
		if !f.receiptOK {
			status = "0x0"
		}
		reply(map[string]any{
			"status": status, "blockNumber": "0x64",
			"gasUsed": "0x30d40", "effectiveGasPrice": "0x3b9aca00",
		})
	default:
		reply("0x0")
	}
}

// encodeErrorString builds the ABI payload a contract returns for
// `revert("...")`, which is what the decoder under test has to read.
func encodeErrorString(s string) string {
	pad := func(b []byte) string {
		h := fmt.Sprintf("%x", b)
		for len(h)%64 != 0 {
			h += "0"
		}
		return h
	}
	length := fmt.Sprintf("%064x", len(s))
	offset := fmt.Sprintf("%064x", 32)
	return "0x08c379a0" + offset + length + pad([]byte(s))
}

func newTestBroker(t *testing.T, f *fakeChain) (*Broker, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "allow.json")
	cfg := map[string]any{
		"chain_id":    4663,
		"routers":     []string{"0x00000000000000000000000000000000000000aa"},
		"quote_token": map[string]any{"symbol": "USDG", "address": "0x00000000000000000000000000000000000000bb", "decimals": 6},
		"tokens": []map[string]any{
			{"symbol": "AAPL", "address": "0x00000000000000000000000000000000000000cc", "decimals": 18, "pool_fee": 500},
		},
	}
	raw, _ := json.Marshal(cfg)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}

	chain := httptest.NewServer(http.HandlerFunc(f.handler))
	t.Cleanup(chain.Close)
	signer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var sr struct {
			MinOut string `json:"min_out"`
			Amount string `json:"amount"`
		}
		_ = json.NewDecoder(r.Body).Decode(&sr)
		f.signed = append(f.signed, sr.MinOut)
		f.amounts = append(f.amounts, sr.Amount)
		_ = json.NewEncoder(w).Encode(map[string]any{"raw": "0x02aabb", "hash": "0x" + strings.Repeat("ab", 32)})
	}))
	t.Cleanup(signer.Close)

	b := NewBroker(c, NewRPC([]string{chain.URL}, 5*time.Second),
		NewSignerClient(signer.URL, "k", HTTPClient(5*time.Second)))
	b.ReceiptWait = time.Second
	b.PollEvery = 50 * time.Millisecond
	return b, "0x00000000000000000000000000000000000000dd"
}

// lastSignedMinOut is the floor the broker asked the signer to put in the
// transaction. Read from the signing request rather than from the Result,
// because that is the number the chain ends up enforcing.
func lastSignedMinOut(t *testing.T, f *fakeChain) *big.Int {
	t.Helper()
	if len(f.signed) == 0 {
		t.Fatal("nothing was sent to the signer, so no floor reached the chain")
	}
	v, ok := new(big.Int).SetString(f.signed[len(f.signed)-1], 10)
	if !ok {
		t.Fatalf("min_out in the signing request is not a number: %q", f.signed[len(f.signed)-1])
	}
	return v
}

// quoteMinOut is the floor inside the QUOTE's calldata, which must be zero.
func quoteMinOut(t *testing.T, data string) *big.Int {
	t.Helper()
	body := strings.TrimPrefix(data, "0x")[8:]
	if len(body) < 64*7 {
		t.Fatalf("calldata too short to contain min_out: %d chars", len(body))
	}
	v, ok := new(big.Int).SetString(body[64*6:64*7], 16)
	if !ok {
		t.Fatalf("min_out field is not a number: %q", body[64*6:64*7])
	}
	return v
}

// --- the tests -----------------------------------------------------------

func TestMinOutIsSentAtASizeTheOldCeilingWouldHaveRefused(t *testing.T) {
	// $500,000 of input. The removed cap was $100.
	quote := new(big.Int).Mul(big.NewInt(1500), new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil))
	f := &fakeChain{t: t, quote: quote, receiptOK: true,
		balance: new(big.Int).Lsh(big.NewInt(1), 200)}
	b, wallet := newTestBroker(t, f)

	res, err := b.Execute(context.Background(), Request{
		AgentID: "a", Wallet: wallet, Action: "buy", Symbol: "AAPL",
		Qty: 1500, Price: 333.33,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != StatusMined {
		t.Fatalf("a large trade was not executed: %s — %s", res.Status, res.Note)
	}
	if len(f.swapCalldata) == 0 {
		t.Fatal("no swap calldata reached the chain")
	}
	// The quote carries no floor, deliberately, and the signed transaction does.
	if q := quoteMinOut(t, f.swapCalldata[0]); q.Sign() != 0 {
		t.Fatalf("the quote was simulated with a floor of %s; a floor there would only stop it "+
			"reporting what the fill would be", q)
	}
	got := lastSignedMinOut(t, f)
	want := new(big.Int).Div(new(big.Int).Mul(quote, big.NewInt(10000-b.SlippageBps)), big.NewInt(10000))
	if got.Cmp(want) != 0 {
		t.Fatalf("min_out in the calldata is %s, want %s", got, want)
	}
	if got.Sign() <= 0 {
		t.Fatal("min_out is zero at large size: the floor is not being applied")
	}
}

func TestMinOutScalesWithTheTradeRatherThanStayingPut(t *testing.T) {
	// The property that a fixed ceiling used to hide: the floor is a fraction of
	// the quote, so it grows with the trade. A floor that did not would be
	// meaningless on anything large.
	var outs []*big.Int
	for _, mult := range []int64{1, 1000, 1000000} {
		quote := new(big.Int).Mul(big.NewInt(mult), new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil))
		f := &fakeChain{t: t, quote: quote, receiptOK: true,
			balance: new(big.Int).Lsh(big.NewInt(1), 200)}
		b, wallet := newTestBroker(t, f)
		if _, err := b.Execute(context.Background(), Request{
			AgentID: "a", Wallet: wallet, Action: "buy", Symbol: "AAPL",
			Qty: float64(mult), Price: 1,
		}); err != nil {
			t.Fatal(err)
		}
		outs = append(outs, lastSignedMinOut(t, f))
	}
	for i := 1; i < len(outs); i++ {
		if outs[i].Cmp(outs[i-1]) <= 0 {
			t.Fatalf("min_out did not grow with the trade: %v", outs)
		}
	}
	// And it is the stated fraction of the quote at every size, not a constant.
	ratio := new(big.Int).Div(outs[2], outs[1])
	if ratio.Cmp(big.NewInt(999)) < 0 || ratio.Cmp(big.NewInt(1001)) > 0 {
		t.Fatalf("min_out is not proportional to the quote: ratio %s over a 1000x size step", ratio)
	}
}

func TestASlippageRevertIsNamedAsSlippage(t *testing.T) {
	quote := new(big.Int).Mul(big.NewInt(1000), new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil))
	f := &fakeChain{t: t, quote: quote, receiptOK: false,
		balance:      new(big.Int).Lsh(big.NewInt(1), 200),
		replayRevert: "Too little received"}
	b, wallet := newTestBroker(t, f)

	res, err := b.Execute(context.Background(), Request{
		AgentID: "a", Wallet: wallet, Action: "buy", Symbol: "AAPL", Qty: 1000, Price: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != StatusReverted {
		t.Fatalf("want reverted, got %s", res.Status)
	}
	if res.RefusalCode != SlippageRefusal {
		t.Fatalf("a slippage revert was recorded as %q, not %q. That reads exactly like a paused "+
			"token or a bad allowance: %s", res.RefusalCode, SlippageRefusal, res.Note)
	}
	for _, want := range []string{"slippage floor", "min_out", "Too little received", "bps"} {
		if !strings.Contains(res.Note, want) {
			t.Fatalf("the note does not mention %q:\n%s", want, res.Note)
		}
	}
	t.Logf("%s", res.Note)
}

func TestARevertForAnotherReasonIsNotCalledSlippage(t *testing.T) {
	// THE CONTROL. Without it the check above would pass just as happily if
	// every revert were labelled slippage, which would be worse than the
	// silence it replaced.
	quote := new(big.Int).Mul(big.NewInt(1000), new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil))
	f := &fakeChain{t: t, quote: quote, receiptOK: false,
		balance:      new(big.Int).Lsh(big.NewInt(1), 200),
		replayRevert: "STF"}
	b, wallet := newTestBroker(t, f)

	res, err := b.Execute(context.Background(), Request{
		AgentID: "a", Wallet: wallet, Action: "buy", Symbol: "AAPL", Qty: 1000, Price: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.RefusalCode == SlippageRefusal {
		t.Fatalf("a transfer failure was labelled slippage: %s", res.Note)
	}
	if !strings.Contains(res.Note, "STF") {
		t.Fatalf("the real reason was not recorded: %s", res.Note)
	}
	t.Logf("%s", res.Note)
}

func TestNothingCapsTheTradeSize(t *testing.T) {
	// The removal itself, asserted rather than assumed. A trade of a hundred
	// million dollars is signed and sent; what stops an oversized trade is the
	// wallet balance, which is checked here as the thing that DOES refuse.
	quote := new(big.Int).Mul(big.NewInt(1), new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil))
	f := &fakeChain{t: t, quote: quote, receiptOK: true, balance: big.NewInt(1000)}
	b, wallet := newTestBroker(t, f)

	res, err := b.Execute(context.Background(), Request{
		AgentID: "a", Wallet: wallet, Action: "buy", Symbol: "AAPL", Qty: 1e8, Price: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != StatusBlocked {
		t.Fatalf("want blocked by the balance, got %s", res.Status)
	}
	if !strings.Contains(res.Note, "wallet holds") {
		t.Fatalf("the refusal does not name the balance, so something else refused it: %s", res.Note)
	}
	if strings.Contains(strings.ToLower(res.Note), "cap") {
		t.Fatalf("a cap refused a trade after the caps were removed: %s", res.Note)
	}
}
