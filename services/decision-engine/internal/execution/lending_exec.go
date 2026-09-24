package execution

// ARCANA CAPITAL: carrying a validated supply, borrow or repay to the chain.
//
// THE SAME SHAPE AS Execute, deliberately: gas checked before anything is
// signed, an allowance sent and CONFIRMED before the action that needs it, the
// signer asked for a named intent, the raw transaction broadcast, the receipt
// awaited on a context the caller cannot cancel. A refusal, a revert and an
// unresolved transaction are outcomes to record, not errors.
//
// What decides WHETHER to act is not here. capital.Validate has already run by
// the time this is called, and the signer applies its own caps and the
// allowlist's `enabled` switch regardless of what this file believes.

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"time"
)

// CapitalResult is the outcome of one capital action.
type CapitalResult struct {
	Status        string // mined | reverted | unresolved | refused | blocked
	RefusalCode   string
	Note          string
	TxHash        string
	ApproveTxHash string
}

// ExecuteCapital sends one supply, borrow or repay of `amount` whole units.
func (b *Broker) ExecuteCapital(ctx context.Context, agentID, wallet string, m LendingMarketCfg, kind string, amount float64) *CapitalResult {
	res := &CapitalResult{Status: StatusBlocked}
	if b.cfg.Lending == nil {
		res.Note = "no lending section in the allowlist"
		return res
	}
	morpho := b.cfg.Lending.Morpho

	var intent, token string
	var decimals int
	switch kind {
	case "supply":
		coll, err := b.tokenByAddress(m.CollateralToken)
		if err != nil {
			res.Note = err.Error()
			return res
		}
		intent, token, decimals = "lending_supply", coll.Address, coll.Decimals
	case "borrow":
		intent, token, decimals = "lending_borrow", "", b.cfg.QuoteToken.Decimals
	case "repay":
		intent, token, decimals = "lending_repay", b.cfg.QuoteToken.Address, b.cfg.QuoteToken.Decimals
	case "withdraw":
		// Nothing leaves the wallet and nothing needs an allowance: the
		// collateral comes back from the market.
		coll, err := b.tokenByAddress(m.CollateralToken)
		if err != nil {
			res.Note = err.Error()
			return res
		}
		intent, token, decimals = "lending_withdraw", "", coll.Decimals
	default:
		res.Note = fmt.Sprintf("%q is not supply, borrow, repay or withdraw", kind)
		return res
	}
	units := baseUnits(amount, decimals)
	if units.Sign() <= 0 {
		res.Note = "the amount rounds to zero base units"
		return res
	}

	// A REPAY THAT COVERS THE WHOLE DEBT GOES BY SHARES. Repaying the debt's
	// asset value, rounded up the way Morpho values debt, converts to one share
	// more than is owed and reverts with an arithmetic underflow — the first
	// live repay did exactly that on 2026-09-24. So when the amount reaches the
	// debt, the signer is asked for repay_all (it reads the shares itself) and
	// the allowance and balance are checked against the full rounded-up debt.
	// A WITHDRAWAL IS CLAMPED TO WHAT IS POSTED, read from the chain here. The
	// owner's "all of it" arrives as a float whose conversion can land a base
	// unit above the posted collateral, and Morpho reverts that with an
	// underflow — the same shape the first repay hit. Validate has already
	// refused anything more than a rounding error over.
	if kind == "withdraw" {
		pos, perr := b.ReadPosition(ctx, m, wallet)
		if perr != nil {
			res.Note = "could not read the posted collateral: " + perr.Error()
			return res
		}
		if pos.Collateral.Sign() == 0 {
			res.Note = "there is no collateral posted in this market to withdraw"
			return res
		}
		if units.Cmp(pos.Collateral) > 0 {
			units = new(big.Int).Set(pos.Collateral)
		}
	}

	repayAll := false
	if kind == "repay" {
		pos, perr := b.ReadPosition(ctx, m, wallet)
		if perr != nil {
			res.Note = "could not read the debt: " + perr.Error()
			return res
		}
		ms, merr := b.ReadMarketState(ctx, m, time.Now())
		if merr != nil {
			res.Note = "could not read the market: " + merr.Error()
			return res
		}
		debt := DebtBaseUp(pos, ms)
		if debt.Sign() == 0 {
			res.Note = "there is no debt in this market to repay"
			return res
		}
		if units.Cmp(debt) >= 0 {
			repayAll, units = true, debt
		}
	}

	// What leaves the wallet must be in it. Borrow moves nothing out.
	if token != "" {
		have, err := b.rpc.TokenBalance(ctx, token, wallet)
		if err != nil {
			res.Note = "could not read the balance: " + err.Error()
			return res
		}
		if have.Cmp(units) < 0 {
			res.Note = fmt.Sprintf("the wallet holds %s base units and the action needs %s", have, units)
			return res
		}
	}

	need := new(big.Int).Mul(b.MaxFeeWei, new(big.Int).SetUint64(b.GasLimit))
	need.Mul(need, big.NewInt(2)) // approve plus the action, worst case
	gasBal, err := b.rpc.NativeBalance(ctx, wallet)
	if err != nil {
		res.Note = "could not read the gas balance: " + err.Error()
		return res
	}
	if gasBal.Cmp(need) < 0 {
		res.Note = fmt.Sprintf("gas reserve is %s wei and %s is required for two transactions, so signing "+
			"would produce a transaction that cannot be mined", gasBal, need)
		return res
	}

	if token != "" {
		allowance, err := b.rpc.Allowance(ctx, token, wallet, morpho)
		if err != nil {
			res.Note = "could not read the allowance: " + err.Error()
			return res
		}
		if allowance.Cmp(units) < 0 {
			if !b.sendAndWait(ctx, SignRequest{Intent: "lending_approve", AgentID: agentID, MarketID: m.ID,
				TokenIn: token, Amount: units.String()}, wallet, res, true) {
				return res
			}
		}
	}

	b.sendAndWait(ctx, SignRequest{Intent: intent, AgentID: agentID, MarketID: m.ID,
		TokenIn: token, Amount: units.String(), RepayAll: repayAll}, wallet, res, false)
	return res
}

// sendAndWait signs, broadcasts and follows one transaction, writing its
// outcome into res. It reports whether the caller may continue.
func (b *Broker) sendAndWait(ctx context.Context, req SignRequest, wallet string, res *CapitalResult, isApproval bool) bool {
	leg := "the action"
	if isApproval {
		leg = "the approval"
	}
	nonce, err := b.rpc.Nonce(ctx, wallet)
	if err != nil {
		res.Note = "could not read the nonce for " + leg + ": " + err.Error()
		return false
	}
	req.Nonce, req.Gas = nonce, b.GasLimit
	req.MaxFeeWei, req.TipWei = b.MaxFeeWei.String(), b.TipWei.String()

	signed, err := b.signer.Sign(ctx, req)
	if err != nil {
		var ref *Refusal
		var flt *Fault
		switch {
		case errors.As(err, &ref):
			res.Status, res.RefusalCode = StatusRefused, ref.Code
			res.Note = leg + " was refused by the signer, so nothing was sent: " + ref.Message
		case errors.As(err, &flt):
			res.RefusalCode = flt.Code
			res.Note = leg + " could not be signed: " + flt.Message
		default:
			res.Note = leg + " could not be signed: " + err.Error()
		}
		return false
	}
	hash, err := b.rpc.SendRaw(ctx, signed.Raw)
	if err != nil {
		res.Note = leg + " was rejected by every endpoint: " + err.Error()
		return false
	}
	if isApproval {
		res.ApproveTxHash = hash
	} else {
		res.TxHash = hash
	}

	// Broadcast: from here the caller may not cancel finding out.
	wctx, release := context.WithTimeout(context.WithoutCancel(ctx), b.ReceiptWait+30*time.Second)
	defer release()
	rcpt, err := b.rpc.WaitReceipt(wctx, hash, b.ReceiptWait, b.PollEvery)
	if err != nil || rcpt == nil {
		res.Status = StatusUnresolved
		res.Note = leg + " is broadcast and unresolved"
		if isApproval {
			res.Note += ", so the action was not attempted on top of an allowance that may or may not exist"
		}
		return false
	}
	if !rcpt.Succeeded() {
		res.Status = StatusReverted
		res.Note = leg + " reverted on chain"
		if !isApproval {
			res.Note += "; see transaction " + hash
		}
		return false
	}
	if !isApproval {
		res.Status = StatusMined
		res.Note = "mined"
	}
	return true
}

// WalletBalances reads the collateral token and USDG the wallet holds — not
// posted — in whole units.
func (b *Broker) WalletBalances(ctx context.Context, wallet string, m LendingMarketCfg) (collateral, usdg float64, err error) {
	coll, err := b.tokenByAddress(m.CollateralToken)
	if err != nil {
		return 0, 0, err
	}
	c, err := b.rpc.TokenBalance(ctx, coll.Address, wallet)
	if err != nil {
		return 0, 0, fmt.Errorf("collateral balance: %w", err)
	}
	u, err := b.rpc.TokenBalance(ctx, b.cfg.QuoteToken.Address, wallet)
	if err != nil {
		return 0, 0, fmt.Errorf("USDG balance: %w", err)
	}
	return toFloat(c, coll.Decimals), toFloat(u, b.cfg.QuoteToken.Decimals), nil
}
