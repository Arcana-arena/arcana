// Command anchor writes Merkle roots of decision commitments onto the chain.
//
// # WHAT IT CLOSES
//
// Migration 0047 seals every decision with a commitment and the database refuses
// to change a sealed row. That binds the application, not the database: whoever
// holds superuser can drop the trigger and rewrite history. This makes the
// history expensive to rewrite for everybody, ARCANA included — once a root is
// mined, any change to an anchored decision breaks a proof checkable against
// the chain.
//
// # ONE RUN
//
//  1. Settle any anchor still pending: record its receipt, rebroadcast the same
//     signed bytes, or mark it dropped if its nonce was spent elsewhere.
//  2. Take every sealed live decision not yet in an anchor, build the tree.
//  3. Ask the anchoring signer to sign ONE transaction carrying the root. The
//     signer builds it; this process only chooses the root, nonce and fees.
//  4. Record the anchor and its leaves, then broadcast, then wait for a receipt.
//
// It never signs, and it never holds a key. See docs/anchoring.md.
package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/arcana/decision-engine/internal/execution"
	"github.com/arcana/decision-engine/internal/store"
)

var buildCommit = "unknown"

// anchorMagic is the payload prefix the anchoring signer writes before the root.
// The SIGNER is the authority for it (services/signer/cmd/anchor); it is
// restated here only to estimate gas for the exact bytes that will be sent.
const anchorMagicHex = "415243414e410001"

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	log.Printf("anchor: commit %s", buildCommit)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	if err := run(ctx); err != nil {
		log.Printf("anchor: FAILED: %v", err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	key := os.Getenv("INTERNAL_API_KEY")
	if key == "" {
		return errors.New("INTERNAL_API_KEY is required: the anchoring signer is a machine-tier endpoint")
	}
	urls := splitCSV(envOr("EXECUTION_RPC_URLS", "https://rpc.mainnet.chain.robinhood.com,https://robinhood-rpc.publicnode.com"))
	chainID := int64(envInt("ANCHOR_CHAIN_ID", 4663))
	maxLeaves := envInt("ANCHOR_MAX_LEAVES", 4096)
	feed := envOr("EXECUTION_ETH_USD_FEED", "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9")

	pool, err := store.NewPool(ctx, dbURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	st := store.New(pool)
	rpc := execution.NewRPC(urls, 20*time.Second)
	sg := &signer{url: strings.TrimRight(envOr("ANCHOR_SIGNER_URL", "http://127.0.0.1:8087"), "/"), key: key}

	sender, err := sg.address(ctx)
	if err != nil {
		return fmt.Errorf("anchoring signer: %w", err)
	}

	// ---- 1. settle what is still open --------------------------------------
	pending, err := st.PendingAnchors(ctx)
	if err != nil {
		return err
	}
	for _, p := range pending {
		settle(ctx, st, rpc, feed, sender, p)
	}
	if pending, err = st.PendingAnchors(ctx); err != nil {
		return err
	}
	if len(pending) > 0 {
		// ONE AT A TIME. A second anchor behind an unmined first would take the
		// next nonce, and if the first is dropped the second cannot land either.
		log.Printf("anchor: anchor %d (%s, %s) has no final answer yet; not opening another until it does",
			pending[0].ID, pending[0].TxHash, pending[0].Status)
		return nil
	}

	// ---- 2. the batch --------------------------------------------------------
	leaves, err := st.UnanchoredCommitments(ctx, maxLeaves)
	if err != nil {
		return err
	}
	if len(leaves) == 0 {
		log.Printf("anchor: every sealed decision is already anchored; nothing to write")
		return nil
	}
	hashes := make([][]byte, len(leaves))
	for i, l := range leaves {
		if hashes[i], err = store.LeafHash(l.Commitment); err != nil {
			return fmt.Errorf("decision %d: %w", l.DecisionID, err)
		}
	}
	root := hex.EncodeToString(store.MerkleRoot(hashes))

	// ---- 3. fees, and whether the wallet can pay them -----------------------
	gasPrice, err := rpc.GasPrice(ctx)
	if err != nil {
		return fmt.Errorf("gas price: %w", err)
	}
	maxFee := new(big.Int).Mul(gasPrice, big.NewInt(2))
	tip := new(big.Int).Div(gasPrice, big.NewInt(10))
	if tip.Sign() == 0 {
		tip = big.NewInt(1)
	}
	gas, err := rpc.EstimateGas(ctx, sender, sender, "0x"+anchorMagicHex+root)
	if err != nil {
		return fmt.Errorf("estimate gas: %w", err)
	}
	gas = gas * 13 / 10

	need := new(big.Int).Mul(new(big.Int).SetUint64(gas), maxFee)
	balance, err := rpc.NativeBalance(ctx, sender)
	if err != nil {
		return fmt.Errorf("anchoring wallet balance: %w", err)
	}
	if balance.Cmp(need) < 0 {
		msg := fmt.Sprintf("the anchoring wallet %s holds %s wei and one anchor needs up to %s; %d sealed decision(s) are waiting",
			sender, balance, need, len(leaves))
		ever, _ := st.AnyAnchorMined(ctx)
		if !ever {
			// NOT YET FUNDED is a setup step, not an outage: nothing has ever been
			// anchored, so nothing has stopped. Said loudly and left to
			// anchor-verify, which fails the sweep in this state, rather than
			// alerting every fifteen minutes until somebody funds it.
			log.Printf("anchor: NOT YET FUNDED — %s. Send the chain's gas token to %s.", msg, sender)
			return nil
		}
		return errors.New(msg)
	}

	nonce, err := rpc.Nonce(ctx, sender)
	if err != nil {
		return fmt.Errorf("nonce: %w", err)
	}

	// ---- 4. sign, record, send ----------------------------------------------
	signed, err := sg.sign(ctx, root, nonce, maxFee, tip, gas)
	if err != nil {
		return fmt.Errorf("sign anchor: %w", err)
	}
	if !strings.EqualFold(signed.From, sender) || !strings.EqualFold(signed.To, sender) {
		return fmt.Errorf("the signer built a transaction from %s to %s; expected a self-send from %s", signed.From, signed.To, sender)
	}
	if !strings.EqualFold(signed.Data, "0x"+anchorMagicHex+root) {
		return fmt.Errorf("the signer's payload %s is not the anchor for root %s", signed.Data, root)
	}

	id, err := st.RecordAnchor(ctx, store.AnchorInsert{
		Root: root, ChainID: chainID, Sender: strings.ToLower(sender), Nonce: nonce,
		TxHash: strings.ToLower(signed.TxHash), RawTx: signed.Raw,
	}, leaves)
	if err != nil {
		return err
	}
	if _, err := rpc.SendRaw(ctx, signed.Raw); err != nil {
		return fmt.Errorf("anchor %d is signed and recorded but was not broadcast (the next run retries the same bytes): %w", id, err)
	}
	if err := st.MarkAnchorBroadcast(ctx, id); err != nil {
		return fmt.Errorf("anchor %d broadcast but not marked: %w", id, err)
	}

	rec, err := rpc.WaitReceipt(ctx, signed.TxHash, 90*time.Second, 3*time.Second)
	if err != nil {
		log.Printf("anchor: anchor %d broadcast as %s; receipt not read (%v), the next run settles it", id, signed.TxHash, err)
		return nil
	}
	if rec == nil {
		log.Printf("anchor: anchor %d broadcast as %s; not mined within 90s, the next run settles it", id, signed.TxHash)
		return nil
	}
	record(ctx, st, rpc, feed, id, rec)
	log.Printf("anchor: anchor %d — %d decision(s) %d..%d, root %s, tx %s, block %s, status %s",
		id, len(leaves), leaves[0].DecisionID, leaves[len(leaves)-1].DecisionID, root, signed.TxHash, rec.BlockNumber, rec.Status)
	if !rec.Succeeded() {
		return fmt.Errorf("anchor %d reverted on chain (tx %s); its decisions return to the queue", id, signed.TxHash)
	}
	return nil
}

// settle gives a pending anchor its final answer if the chain has one.
func settle(ctx context.Context, st *store.Store, rpc *execution.RPC, feed, sender string, p store.PendingAnchor) {
	rec, err := rpc.WaitReceipt(ctx, p.TxHash, time.Millisecond, time.Millisecond)
	if err != nil {
		log.Printf("anchor: anchor %d: receipt unreadable, left pending: %v", p.ID, err)
		return
	}
	if rec != nil {
		record(ctx, st, rpc, feed, p.ID, rec)
		log.Printf("anchor: anchor %d settled: %s in block %s", p.ID, rec.Status, rec.BlockNumber)
		return
	}
	latest, err := rpc.NonceLatest(ctx, sender)
	if err == nil && latest > p.Nonce {
		note := fmt.Sprintf("nonce %d was consumed by another transaction and %s has no receipt", p.Nonce, p.TxHash)
		if derr := st.MarkAnchorDropped(ctx, p.ID, note); derr != nil {
			log.Printf("anchor: anchor %d could not be marked dropped: %v", p.ID, derr)
		} else {
			log.Printf("anchor: anchor %d DROPPED: %s; its decisions return to the queue", p.ID, note)
		}
		return
	}
	// Not mined and its nonce is still free: send the same bytes again. A node
	// that already has it answers "already known", which is not a failure.
	if _, serr := rpc.SendRaw(ctx, p.RawTx); serr != nil {
		log.Printf("anchor: anchor %d rebroadcast answered: %v", p.ID, serr)
	}
	if p.Status == "signed" {
		_ = st.MarkAnchorBroadcast(ctx, p.ID)
	}
}

// record writes a receipt, and what the anchor cost the platform.
func record(ctx context.Context, st *store.Store, rpc *execution.RPC, feed string, id int64, rec *execution.Receipt) {
	block, _ := parseHex(rec.BlockNumber)
	gasUsed, _ := parseHex(rec.GasUsed)
	eff, _ := parseHex(rec.EffGasPrice)
	var costWei *big.Int
	if gasUsed != nil && eff != nil {
		costWei = new(big.Int).Mul(gasUsed, eff)
	}
	var ethUSD, costUSD *float64
	if costWei != nil {
		if px, err := rpc.EthUSD(ctx, feed); err == nil {
			eth, _ := new(big.Float).Quo(new(big.Float).SetInt(costWei), big.NewFloat(1e18)).Float64()
			usd := eth * px
			ethUSD, costUSD = &px, &usd
		} else {
			// Unknown, not zero. The wei cost is still recorded.
			log.Printf("anchor: anchor %d: eth/usd unreadable, dollar cost left null: %v", id, err)
		}
	}
	var b, g uint64
	if block != nil {
		b = block.Uint64()
	}
	if gasUsed != nil {
		g = gasUsed.Uint64()
	}
	if err := st.MarkAnchorSettled(ctx, id, !rec.Succeeded(), b, g, eff, costWei, ethUSD, costUSD); err != nil {
		log.Printf("anchor: anchor %d receipt not recorded: %v", id, err)
	}
}

// --- the anchoring signer ------------------------------------------------------

type signer struct {
	url string
	key string
}

type signedAnchor struct {
	Raw    string `json:"raw"`
	TxHash string `json:"tx_hash"`
	From   string `json:"from"`
	To     string `json:"to"`
	Data   string `json:"data"`
}

func (s *signer) do(ctx context.Context, method, path string, body any, out any) error {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.url+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("X-Internal-Key", s.key)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<16))
	if res.StatusCode >= 300 {
		return fmt.Errorf("%s %s answered %d: %s", method, path, res.StatusCode, strings.TrimSpace(string(raw)))
	}
	return json.Unmarshal(raw, out)
}

func (s *signer) address(ctx context.Context) (string, error) {
	var out struct {
		Address string `json:"address"`
	}
	if err := s.do(ctx, http.MethodGet, "/internal/v1/anchor/address", nil, &out); err != nil {
		return "", err
	}
	if len(out.Address) != 42 {
		return "", fmt.Errorf("the signer answered an address of %q", out.Address)
	}
	return out.Address, nil
}

func (s *signer) sign(ctx context.Context, root string, nonce uint64, maxFee, tip *big.Int, gas uint64) (*signedAnchor, error) {
	var out signedAnchor
	err := s.do(ctx, http.MethodPost, "/internal/v1/anchor/sign", map[string]any{
		"root": root, "nonce": nonce, "max_fee_wei": maxFee.String(), "tip_wei": tip.String(), "gas": gas,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// --- helpers ------------------------------------------------------------------

func parseHex(s string) (*big.Int, error) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "0x")
	if s == "" {
		return nil, errors.New("empty")
	}
	v, ok := new(big.Int).SetString(s, 16)
	if !ok {
		return nil, fmt.Errorf("not hex: %q", s)
	}
	return v, nil
}

func splitCSV(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(k)); err == nil && v > 0 {
		return v
	}
	return def
}
