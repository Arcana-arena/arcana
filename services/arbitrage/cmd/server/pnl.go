/**
 * LP PnL: collected fees minus gas, per position, from what already exists.
 *
 * WHY IT READS RECEIPTS RATHER THAN STORING A LEDGER. The collected amounts
 * were never written to a table: the executor records gas_used and the tx hash,
 * and the chain keeps what the transaction actually paid out in the position
 * manager's Collect event. Reading that event is the only way to report a
 * realised figure that can be checked against the transaction, instead of a
 * number this service computed once and now asserts.
 *
 * WHAT IS COUNTED. Fees from minted collect transactions whose action is a
 * harvest (no decrease, burn or mint in the same action, which would return
 * principal too). Gas from every transaction the platform sent for the
 * position: the open, each executor step, and attempts that reverted, because a
 * reverted transaction still burns gas.
 *
 * WHAT IS NOT COUNTED. Fees still accruing inside the position, and any change
 * in the position's own value. Those are unrealised and live in the position
 * endpoint, not here.
 */
package main

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/arcana/arbitrage/internal/chain"
	"github.com/arcana/arbitrage/internal/lp"
	"github.com/arcana/arbitrage/internal/store"
)

// pnlStepScan is how many recent execution steps the endpoint reads. A
// position's whole history is in there today; the response says when the scan
// was truncated rather than reporting a silent partial total.
const pnlStepScan = 2000

type tokenMeta struct {
	Symbol   string
	Decimals int
}

type pnlToken struct {
	Symbol   string  `json:"symbol"`
	Decimals int     `json:"decimals"`
	Raw      string  `json:"raw"`
	Human    float64 `json:"human"`
}

type pnlHarvest struct {
	TS      string  `json:"ts,omitempty"`
	TxHash  string  `json:"tx_hash"`
	Status  string  `json:"status"`
	Amount0 string  `json:"amount0"`
	Amount1 string  `json:"amount1"`
	GasETH  float64 `json:"gas_eth"`
}

type pnlGas struct {
	Txs      int      `json:"txs"`
	Reverted int      `json:"reverted"`
	GasUsed  string   `json:"gas_used"`
	GasETH   float64  `json:"gas_eth"`
	ValueUSD *float64 `json:"value_usdg"`
}

type pnlPosition struct {
	PositionManager string       `json:"position_manager"`
	TokenID         string       `json:"token_id"`
	AgentID         string       `json:"agent_id"`
	Wallet          string       `json:"wallet"`
	Status          string       `json:"status"`
	Token0          pnlToken     `json:"token0"`
	Token1          pnlToken     `json:"token1"`
	FeesValueUSD    *float64     `json:"fees_value_usdg"`
	Gas             pnlGas       `json:"gas"`
	NetUSD          *float64     `json:"net_usdg"`
	Harvests        []pnlHarvest `json:"harvests"`
	Unreadable      []string     `json:"unreadable,omitempty"`
}

func ptr(f float64) *float64 { return &f }

func round6(f float64) float64 { return math.Round(f*1e6) / 1e6 }

func (s *server) tokenMetas() map[string]tokenMeta {
	out := map[string]tokenMeta{}
	add := func(symbol, address string, decimals int) {
		if address != "" {
			out[strings.ToLower(address)] = tokenMeta{Symbol: symbol, Decimals: decimals}
		}
	}
	add(s.cfg.QuoteToken.Symbol, s.cfg.QuoteToken.Address, s.cfg.QuoteToken.Decimals)
	for _, t := range s.cfg.Tokens {
		add(t.Symbol, t.Address, t.Decimals)
	}
	if s.cfg.WETH != nil {
		add(s.cfg.WETH.Symbol, s.cfg.WETH.Address, s.cfg.WETH.Decimals)
	}
	return out
}

// pairUSD prices both sides of a position at its own pool's spot price. One
// side is USDG ($1); the other is read from the pool, never assumed.
func (s *server) pairUSD(ctx context.Context, p store.LPPosition, meta map[string]tokenMeta) (usd0, usd1 float64, err error) {
	m0, ok0 := meta[strings.ToLower(p.Token0)]
	m1, ok1 := meta[strings.ToLower(p.Token1)]
	if !ok0 || !ok1 {
		return 0, 0, fmt.Errorf("no symbol/decimals for %s or %s", p.Token0, p.Token1)
	}
	q := s.cfg.QuoteToken
	switch {
	case strings.EqualFold(p.Token0, q.Address):
		usd0 = 1
		usd1, err = s.chain.PoolPrice(ctx, p.Pool, p.Token1, m1.Decimals, q.Decimals)
		if err != nil {
			return 0, 0, fmt.Errorf("price %s: %w", m1.Symbol, err)
		}
	case strings.EqualFold(p.Token1, q.Address):
		usd1 = 1
		usd0, err = s.chain.PoolPrice(ctx, p.Pool, p.Token0, m0.Decimals, q.Decimals)
		if err != nil {
			return 0, 0, fmt.Errorf("price %s: %w", m0.Symbol, err)
		}
	default:
		return 0, 0, errors.New("neither side of the position is the quote token")
	}
	return usd0, usd1, nil
}

// gasPriceUSDG reads one WETH in USDG from the deepest live WETH/USDG pool.
func (s *server) gasPriceUSDG(ctx context.Context) (price float64, pool string, err error) {
	if s.cfg.WETH == nil {
		return 0, "", errors.New("weth is not configured, so gas cannot be priced")
	}
	pool, _, err = s.chain.DeepestPool(ctx, s.cfg.V3Factory, s.cfg.WETH.Address, s.cfg.QuoteToken.Address,
		[]uint32{100, 500, 3000, 10000})
	if err != nil {
		return 0, "", err
	}
	price, err = s.chain.PoolPrice(ctx, pool, s.cfg.WETH.Address, s.cfg.WETH.Decimals, s.cfg.QuoteToken.Decimals)
	if err != nil {
		return 0, "", err
	}
	return price, pool, nil
}

// GET /v1/arbitrage/lp/pnl?status=all&limit=100
//
// REALISED, NOT A MARK-TO-MARKET. "Net" is what the collect transactions paid
// out, minus what the transactions burned, both valued at today's prices. A
// reader who wants the position's current worth is looking at the position
// endpoint, and the note in this response says so.
func (s *server) handleLPPnL(w http.ResponseWriter, r *http.Request) {
	status := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("status")))
	if status != "open" && status != "closed" {
		status = "all"
	}
	limit := atoiDefault(r.URL.Query().Get("limit"), 100)
	if limit < 1 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	positions, err := s.lpreg.Positions(ctx, status, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "positions_unavailable", err.Error())
		return
	}
	steps, err := s.lpreg.Executions(ctx, pnlStepScan)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "executions_unavailable", err.Error())
		return
	}
	opens, err := s.lpreg.Opens(ctx, 500)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "opens_unavailable", err.Error())
		return
	}

	meta := s.tokenMetas()
	intents := map[int64][]string{}
	stepsByPosition := map[string][]store.LPExecutionStep{}
	for _, st := range steps {
		intents[st.ActionID] = append(intents[st.ActionID], st.Intent)
		stepsByPosition[st.TokenID] = append(stepsByPosition[st.TokenID], st)
	}
	openTxs := map[string][]string{}
	for _, o := range opens {
		if o.TxHash != "" && o.TokenID != "" {
			openTxs[o.TokenID] = append(openTxs[o.TokenID], o.TxHash)
		}
	}

	wethPrice, wethPool, wethErr := s.gasPriceUSDG(ctx)

	rows := make([]pnlPosition, 0, len(positions))
	var sumFees, sumGas float64
	valueComplete := wethErr == nil
	for _, p := range positions {
		m0 := meta[strings.ToLower(p.Token0)]
		m1 := meta[strings.ToLower(p.Token1)]
		row := pnlPosition{
			PositionManager: p.PositionManager,
			TokenID:         p.TokenID,
			AgentID:         p.AgentID,
			Wallet:          p.Wallet,
			Status:          p.Status,
			Token0:          pnlToken{Symbol: m0.Symbol, Decimals: m0.Decimals},
			Token1:          pnlToken{Symbol: m1.Symbol, Decimals: m1.Decimals},
			Harvests:        []pnlHarvest{},
		}

		var collected0, collected1 big.Int
		var gasUsed, gasWei big.Int
		unpriced := 0
		seenTx := map[string]bool{}

		readReceipt := func(txHash string) *chain.Receipt {
			key := strings.ToLower(txHash)
			if seenTx[key] {
				return nil
			}
			seenTx[key] = true
			rc, err := s.chain.Receipt(ctx, txHash)
			if err != nil {
				row.Unreadable = append(row.Unreadable, txHash+": "+err.Error())
				return nil
			}
			row.Gas.Txs++
			if !rc.Success {
				row.Gas.Reverted++
			}
			if rc.GasUsed != nil {
				gasUsed.Add(&gasUsed, rc.GasUsed)
			}
			wei := lp.GasWei(rc.GasUsed, rc.GasPrice)
			if wei == nil {
				unpriced++
			} else {
				gasWei.Add(&gasWei, wei)
			}
			return rc
		}

		// The open transaction is gas this platform spent on the position even
		// though it never appears as an execution step.
		for _, hash := range openTxs[p.TokenID] {
			readReceipt(hash)
		}

		for _, st := range stepsByPosition[p.TokenID] {
			if st.TxHash == "" {
				continue
			}
			rc := readReceipt(st.TxHash)
			if rc == nil || !rc.Success {
				continue
			}
			if !strings.EqualFold(st.Intent, "lp_collect") || !lp.FeeOnlyCollect(intents[st.ActionID]) {
				continue
			}
			a0, a1, found := chain.CollectForToken(rc, p.PositionManager, p.TokenID)
			if !found {
				continue
			}
			collected0.Add(&collected0, a0)
			collected1.Add(&collected1, a1)
			row.Harvests = append(row.Harvests, pnlHarvest{
				TS:      st.TS.UTC().Format(time.RFC3339),
				TxHash:  st.TxHash,
				Status:  st.Status,
				Amount0: a0.String(),
				Amount1: a1.String(),
				GasETH:  lp.WeiETH(lp.GasWei(rc.GasUsed, rc.GasPrice)),
			})
		}

		row.Token0.Raw = collected0.String()
		row.Token0.Human = lp.Human(&collected0, m0.Decimals)
		row.Token1.Raw = collected1.String()
		row.Token1.Human = lp.Human(&collected1, m1.Decimals)

		usd0, usd1, priceErr := s.pairUSD(ctx, p, meta)
		if priceErr == nil {
			fees := lp.ValueUSD(&collected0, &collected1, m0.Decimals, m1.Decimals, usd0, usd1)
			row.FeesValueUSD = ptr(round6(fees))
			sumFees += fees
		} else {
			row.Unreadable = append(row.Unreadable, "fees not valued: "+priceErr.Error())
			valueComplete = false
		}

		row.Gas.GasUsed = gasUsed.String()
		row.Gas.GasETH = lp.WeiETH(&gasWei)
		if unpriced > 0 || wethErr != nil || s.cfg.WETH == nil {
			valueComplete = false
		} else if row.Gas.Txs > 0 {
			gasUSD := row.Gas.GasETH * wethPrice
			row.Gas.ValueUSD = ptr(round6(gasUSD))
			sumGas += gasUSD
		} else {
			row.Gas.ValueUSD = ptr(0)
		}

		if row.FeesValueUSD != nil && row.Gas.ValueUSD != nil {
			row.NetUSD = ptr(round6(*row.FeesValueUSD - *row.Gas.ValueUSD))
		}
		rows = append(rows, row)
	}

	valuation := map[string]any{
		"fees": "each position's pair at its own pool's current spot price; the quote side is 1",
		"gas": map[string]any{
			"symbol":    "WETH/" + s.cfg.QuoteToken.Symbol,
			"pool":      wethPool,
			"weth_usdg": nil,
			"error":     nil,
		},
	}
	gasVal := valuation["gas"].(map[string]any)
	if wethErr != nil {
		gasVal["error"] = wethErr.Error()
	} else {
		gasVal["weth_usdg"] = round6(wethPrice)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"as_of": time.Now().UTC().Format(time.RFC3339),
		"note": "REALISED ONLY. Collected fees are the amounts the minted collect transactions actually " +
			"paid out, read from the position manager's Collect event on each receipt. Fees still accruing " +
			"inside a position are not counted, and neither is any change in the position's own value. Gas is " +
			"every transaction this platform sent for the position, including the open and reverted attempts, " +
			"priced at each receipt's effectiveGasPrice. Fees are valued at the pair's current pool price and " +
			"gas at the deepest live WETH/USDG pool, both as of this response: a realised amount is being shown " +
			"at today's price, not at the price when it was collected.",
		"valuation": valuation,
		"positions": rows,
		"totals": map[string]any{
			"positions":       len(rows),
			"fees_value_usdg": round6(sumFees),
			"gas_value_usdg":  round6(sumGas),
			"net_usdg":        round6(sumFees - sumGas),
			"complete":        valueComplete,
		},
		"steps_scanned": len(steps),
		"truncated":     len(steps) >= pnlStepScan,
	})
}
