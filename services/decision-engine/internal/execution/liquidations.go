package execution

// AGENT CREDIT: reading liquidations. READ-ONLY, like capital.go.
//
// A liquidation is carried out by a third party and leaves no ARCANA row, so
// the only place it can be read is Morpho's own event:
//
//	Liquidate(Id indexed id, address indexed caller, address indexed borrower,
//	          uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets,
//	          uint256 badDebtAssets, uint256 badDebtShares)
//
// The topic below is keccak256 of that signature. It was checked against the
// chain on 2026-10-02: eth_getLogs for it on Morpho (0x9D53…1010, chain 4663)
// returned 163 events since block 71404524, with three indexed topics and five
// data words each — the shape decoded here.
//
// UNITS: repaidAssets and badDebtAssets are loan-token base units, seizedAssets
// is collateral base units. They are converted once, by the caller, with the
// allowlist's decimals.

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"time"
)

const liquidateTopic = "0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41"

// Liquidation is one Liquidate event, undecoded beyond its fields.
type Liquidation struct {
	Borrower     string
	Liquidator   string
	Block        uint64
	TxHash       string
	LogIndex     int
	RepaidAssets *big.Int
	SeizedAssets *big.Int
	BadDebt      *big.Int
}

// LatestBlock is the chain's head.
func (b *Broker) LatestBlock(ctx context.Context) (uint64, error) {
	s, err := b.rpc.hexString(ctx, "eth_blockNumber", []any{})
	if err != nil {
		return 0, err
	}
	v, err := hexToBig(s)
	if err != nil {
		return 0, err
	}
	return v.Uint64(), nil
}

// BlockTime is a block's own timestamp.
func (b *Broker) BlockTime(ctx context.Context, block uint64) (time.Time, error) {
	raw, err := b.rpc.call(ctx, "eth_getBlockByNumber", []any{fmt.Sprintf("0x%x", block), false})
	if err != nil {
		return time.Time{}, err
	}
	var blk struct {
		Timestamp string `json:"timestamp"`
	}
	if err := json.Unmarshal(raw, &blk); err != nil || blk.Timestamp == "" {
		return time.Time{}, fmt.Errorf("block %d: no timestamp in %s", block, string(raw))
	}
	ts, err := hexToBig(blk.Timestamp)
	if err != nil {
		return time.Time{}, err
	}
	return time.Unix(ts.Int64(), 0).UTC(), nil
}

// Liquidations reads every Liquidate event of one market in [from, to].
//
// Filtered by market and not by borrower: the borrower list is every agent
// wallet and grows, while liquidations in one market are rare. The caller
// matches borrowers.
func (b *Broker) Liquidations(ctx context.Context, m LendingMarketCfg, from, to uint64) ([]Liquidation, error) {
	raw, err := b.rpc.call(ctx, "eth_getLogs", []any{map[string]any{
		"address":   b.cfg.Lending.Morpho,
		"topics":    []string{liquidateTopic, strings.ToLower(m.ID)},
		"fromBlock": fmt.Sprintf("0x%x", from),
		"toBlock":   fmt.Sprintf("0x%x", to),
	}})
	if err != nil {
		return nil, fmt.Errorf("liquidations of %s in blocks %d–%d: %w", m.Name, from, to, err)
	}
	var logs []rawLog
	if err := json.Unmarshal(raw, &logs); err != nil {
		return nil, fmt.Errorf("liquidations of %s: unexpected result: %w", m.Name, err)
	}
	out := make([]Liquidation, 0, len(logs))
	for _, l := range logs {
		liq, err := decodeLiquidation(l)
		if err != nil {
			// An event that cannot be decoded is not skipped: the range would be
			// marked read with a liquidation missing from it.
			return nil, fmt.Errorf("liquidations of %s: %w", m.Name, err)
		}
		out = append(out, liq)
	}
	return out, nil
}

type rawLog struct {
	Topics      []string `json:"topics"`
	Data        string   `json:"data"`
	BlockNumber string   `json:"blockNumber"`
	TxHash      string   `json:"transactionHash"`
	LogIndex    string   `json:"logIndex"`
	Removed     bool     `json:"removed"`
}

func decodeLiquidation(l rawLog) (Liquidation, error) {
	var out Liquidation
	if len(l.Topics) != 4 || !strings.EqualFold(l.Topics[0], liquidateTopic) {
		return out, fmt.Errorf("log in %s is not a Liquidate event: %d topics", l.TxHash, len(l.Topics))
	}
	addr := func(topic string) string {
		t := strings.TrimPrefix(topic, "0x")
		if len(t) != 64 {
			return ""
		}
		return "0x" + t[24:]
	}
	out.Liquidator, out.Borrower = addr(l.Topics[2]), addr(l.Topics[3])
	if out.Borrower == "" || out.Liquidator == "" {
		return out, fmt.Errorf("log in %s has a malformed address topic", l.TxHash)
	}
	var err error
	if out.RepaidAssets, err = word(l.Data, 0); err != nil {
		return out, fmt.Errorf("log in %s: %w", l.TxHash, err)
	}
	if out.SeizedAssets, err = word(l.Data, 2); err != nil {
		return out, fmt.Errorf("log in %s: %w", l.TxHash, err)
	}
	if out.BadDebt, err = word(l.Data, 3); err != nil {
		return out, fmt.Errorf("log in %s: %w", l.TxHash, err)
	}
	blk, err := hexToBig(l.BlockNumber)
	if err != nil {
		return out, fmt.Errorf("log in %s: %w", l.TxHash, err)
	}
	idx, err := hexToBig(l.LogIndex)
	if err != nil {
		return out, fmt.Errorf("log in %s: %w", l.TxHash, err)
	}
	out.Block, out.LogIndex, out.TxHash = blk.Uint64(), int(idx.Int64()), l.TxHash
	return out, nil
}

// LiquidationAmounts converts an event's base units to whole units, once, with
// the allowlist's decimals: USDG repaid, collateral seized, USDG written off.
func (b *Broker) LiquidationAmounts(m LendingMarketCfg, l Liquidation) (repaid, seized, badDebt float64, err error) {
	coll, err := b.tokenByAddress(m.CollateralToken)
	if err != nil {
		return 0, 0, 0, err
	}
	loanDec := b.cfg.QuoteToken.Decimals
	return toFloat(l.RepaidAssets, loanDec), toFloat(l.SeizedAssets, coll.Decimals), toFloat(l.BadDebt, loanDec), nil
}

// LiquidationsFromBlock is where the scan starts with no cursor, or 0 when the
// allowlist does not say.
func (b *Broker) LiquidationsFromBlock() uint64 {
	if b.cfg.Lending == nil {
		return 0
	}
	return b.cfg.Lending.LiquidationsFromBlock
}
