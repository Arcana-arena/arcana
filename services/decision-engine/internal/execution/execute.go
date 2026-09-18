package execution

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math/big"
	"time"
)

// Execute carries one intent all the way to an outcome.
//
// It returns a Result for EVERY path including the failures, and an error only
// when it could not establish what happened at all. A refusal, a revert and an
// unresolved transaction are outcomes to be recorded, not errors to be thrown:
// the caller must write them down, and an error would tempt it to skip that.
func (b *Broker) Execute(ctx context.Context, req Request) (*Result, error) {
	tok, err := b.cfg.Token(req.Symbol)
	if err != nil {
		return &Result{Status: StatusBlocked, IntentAction: req.Action, Symbol: req.Symbol,
			Note: err.Error()}, nil
	}
	quote := b.cfg.QuoteToken

	var tokenIn, tokenOut TokenCfg
	var amountIn *big.Int
	switch req.Action {
	case "buy":
		tokenIn, tokenOut = quote, tok
		amountIn = baseUnits(req.Qty*req.Price, quote.Decimals)
	case "sell":
		tokenIn, tokenOut = tok, quote
		amountIn = baseUnits(req.Qty, tok.Decimals)
		if req.ExactUnitsIn != nil && req.ExactUnitsIn.Sign() > 0 {
			// An exit. Send the balance itself so nothing is left behind.
			amountIn = new(big.Int).Set(req.ExactUnitsIn)
		}
	default:
		return &Result{Status: StatusBlocked, IntentAction: req.Action, Symbol: req.Symbol,
			Note: "only buy and sell can be executed"}, nil
	}

	res := &Result{
		Status: StatusBlocked, IntentAction: req.Action, Symbol: tok.Symbol,
		TokenIn: tokenIn.Address, TokenOut: tokenOut.Address, AmountIn: amountIn,
	}
	if amountIn.Sign() <= 0 {
		res.Note = "the intent rounds to zero base units, so there is nothing to send"
		return res, nil
	}

	// THE BALANCE THE CHAIN SAYS, not the balance the portfolio remembers.
	haveIn, err := b.rpc.TokenBalance(ctx, tokenIn.Address, req.Wallet)
	if err != nil {
		res.Note = "could not read the input balance: " + err.Error()
		return res, nil
	}
	if haveIn.Cmp(amountIn) < 0 {
		res.Note = fmt.Sprintf("wallet holds %s base units of %s and the intent needs %s",
			haveIn.String(), tokenIn.Symbol, amountIn.String())
		return res, nil
	}

	// GAS IS CHECKED BEFORE SIGNING. A wallet with tokens and no gas produces a
	// perfectly valid transaction that no block will ever contain, and the only
	// trace left behind would be an unresolved row nobody can explain.
	need := new(big.Int).Mul(b.MaxFeeWei, new(big.Int).SetUint64(b.GasLimit))
	need.Mul(need, big.NewInt(2)) // approve plus swap, worst case
	gasBal, err := b.rpc.NativeBalance(ctx, req.Wallet)
	if err != nil {
		res.Note = "could not read the gas balance: " + err.Error()
		return res, nil
	}
	if gasBal.Cmp(need) < 0 {
		res.Note = fmt.Sprintf("gas reserve is %s wei and %s is required for two transactions at "+
			"maxFee %s over gas %d, so signing would produce a transaction that cannot be mined",
			gasBal.String(), need.String(), b.MaxFeeWei.String(), b.GasLimit)
		return res, nil
	}

	allowance, err := b.rpc.Allowance(ctx, tokenIn.Address, req.Wallet, b.cfg.Router())
	if err != nil {
		res.Note = "could not read the allowance: " + err.Error()
		return res, nil
	}
	if allowance.Cmp(amountIn) < 0 {
		if err := b.approve(ctx, req, tokenIn, amountIn, res); err != nil {
			return res, nil
		}
	}

	// The quote, from the EXACT calldata that will be signed. min_out is zero
	// here and only here: this call is a simulation that sends nothing, and a
	// floor would only stop it telling us what the fill would be.
	quoteData := EncodeExactInputSingle(tokenIn.Address, tokenOut.Address, tok.PoolFee,
		req.Wallet, amountIn, big.NewInt(0))
	quoted, err := b.rpc.SimulateSwap(ctx, req.Wallet, b.cfg.Router(), quoteData)
	if err != nil {
		res.Status = StatusQuoteFailed
		res.Note = "the swap reverted in simulation, so nothing was sent: " + err.Error()
		return res, nil
	}
	res.QuotedOut = quoted
	if quoted.Sign() <= 0 {
		res.Status = StatusQuoteFailed
		res.Note = "the simulation returned a zero fill"
		return res, nil
	}

	minOut := new(big.Int).Mul(quoted, big.NewInt(10000-b.SlippageBps))
	minOut.Div(minOut, big.NewInt(10000))
	res.MinOut = minOut

	// What the wallet holds BEFORE, so the fill is measured rather than taken
	// from the router return value.
	before, err := b.rpc.TokenBalance(ctx, tokenOut.Address, req.Wallet)
	if err != nil {
		res.Note = "could not read the output balance before the swap: " + err.Error()
		return res, nil
	}

	nonce, err := b.rpc.Nonce(ctx, req.Wallet)
	if err != nil {
		res.Note = "could not read the nonce: " + err.Error()
		return res, nil
	}

	signed, err := b.signer.Sign(ctx, SignRequest{
		Intent: "swap_exact_in", AgentID: req.AgentID,
		TokenIn: tokenIn.Address, TokenOut: tokenOut.Address, Router: b.cfg.Router(),
		Amount: amountIn.String(), MinOut: minOut.String(),
		Nonce: nonce,
		Gas:   b.GasLimit, MaxFeeWei: b.MaxFeeWei.String(), TipWei: b.TipWei.String(),
	})
	if err != nil {
		var ref *Refusal
		if errors.As(err, &ref) {
			res.Status = StatusRefused
			res.RefusalCode = ref.Code
			res.Note = ref.Message
			return res, nil
		}
		// A FAULT IS NAMED TOO, but it stays `blocked` rather than `refused`.
		// Nothing was signed either way; what differs is whether the signer
		// decided. Recording the code against a blocked row is what lets an
		// operator tell a transport problem from a policy one without reading
		// the note — which is the whole reason the code is carried.
		var flt *Fault
		if errors.As(err, &flt) {
			res.RefusalCode = flt.Code
			res.Note = flt.Message
			return res, nil
		}
		res.Note = "the signer could not be reached, so nothing was signed: " + err.Error()
		return res, nil
	}

	// Broadcast. From here the transaction exists whatever happens next.
	hash, err := b.rpc.SendRaw(ctx, signed.Raw)
	if err != nil {
		res.Note = "broadcast was rejected by every endpoint, so the transaction never entered " +
			"the network: " + err.Error()
		return res, nil
	}
	res.TxHash = hash
	log.Printf("execution: agent=%s %s %s broadcast %s", req.AgentID, req.Action, tok.Symbol, hash)

	// FROM HERE THE CALLER MAY NOT CANCEL US.
	//
	// The transaction is in the network. If the request context expires now —
	// a client disconnecting, a handler deadline — everything below stops and
	// a real, paid-for transaction is left with no row describing it. That is
	// the one outcome this whole path exists to prevent, and it would arrive
	// disguised as a timeout. So the rest of this function runs on a context
	// that is detached from the caller and bounded only by the work itself.
	ctx = context.WithoutCancel(ctx)
	var release context.CancelFunc
	ctx, release = context.WithTimeout(ctx, b.ReceiptWait+30*time.Second)
	defer release()

	rcpt, err := b.rpc.WaitReceipt(ctx, hash, b.ReceiptWait, b.PollEvery)
	if err != nil {
		res.Status = StatusUnresolved
		res.Note = "the transaction is broadcast and its receipt could not be read: " + err.Error()
		return res, nil
	}
	if rcpt == nil {
		res.Status = StatusUnresolved
		res.Note = fmt.Sprintf("broadcast and not mined within %s. It may still land, so this is "+
			"recorded as neither a success nor a non-event", b.ReceiptWait)
		return res, nil
	}

	if bn, ok := new(big.Int).SetString(trim0x(rcpt.BlockNumber), 16); ok {
		res.BlockNumber = bn.Int64()
	}
	if gu, ok := new(big.Int).SetString(trim0x(rcpt.GasUsed), 16); ok {
		res.GasUsed = gu.Int64()
		if gp, ok2 := new(big.Int).SetString(trim0x(rcpt.EffGasPrice), 16); ok2 {
			res.GasPriceWei = gp
			res.GasCostWei = new(big.Int).Mul(gu, gp)
		}
	}

	if !rcpt.Succeeded() {
		// MINED AND FAILED. This is the case the old applyIntent turned into a
		// hold. Gas was spent, the nonce is consumed, and nothing moved.
		res.Status = StatusReverted
		res.Filled = big.NewInt(0)
		res.Note = "mined and reverted: gas was paid and no funds moved"
		// AND THEN ASK WHY. A receipt carries a status bit and no reason, so a
		// swap stopped by its own min_out used to read exactly like a paused
		// token or a bad allowance. Since the notional ceiling came off, min_out
		// is the only thing bounding the price a trade fills at, and a
		// load-bearing check has to be legible when it fires.
		b.explainRevert(ctx, req, res, tokenIn, tokenOut, tok.PoolFee, amountIn, minOut)
		return res, nil
	}

	after, err := b.rpc.TokenBalance(ctx, tokenOut.Address, req.Wallet)
	if err != nil {
		res.Status = StatusUnresolved
		res.Note = "mined successfully but the resulting balance could not be read, so the fill " +
			"is unmeasured: " + err.Error()
		return res, nil
	}
	filled := new(big.Int).Sub(after, before)
	res.Filled = filled
	res.Status = StatusMined

	// WHAT THE POOL TOOK. Uniswap V3 charges the fee on the input before
	// swapping, and an exact-input swap consumes the whole input, so the fee is
	// amountIn * feeTier / 1e6. Both terms are from the calldata that was
	// actually sent, not from a table consulted afterwards.
	res.FeeTier = tok.PoolFee
	fee := new(big.Int).Mul(amountIn, new(big.Int).SetUint64(uint64(tok.PoolFee)))
	fee.Div(fee, big.NewInt(1000000))
	res.PoolFeeUnits = fee
	res.PoolFeeUSD = unitsToFloat(fee, tokenIn.Decimals) * priceOfInput(req, tokenIn, quote)

	// Gas in dollars, with the RATE STORED alongside it. A cost recorded
	// without the price used to convert it cannot be checked later, and a cost
	// converted at analysis time prices an old transaction at today's ETH.
	//
	// A feed that cannot be read leaves the dollar figures NULL rather than
	// defaulting them. The meter refuses on unreadable cost; it must not be fed
	// an invented one.
	if b.EthUSDFeed != "" && res.GasCostWei != nil {
		if px, ferr := b.rpc.EthUSD(ctx, b.EthUSDFeed); ferr == nil && px > 0 {
			res.EthUSD = px
			res.GasCostUSD = (float64(res.GasUsed) * bigToFloat(res.GasPriceWei) / 1e18) * px
		} else if ferr != nil {
			log.Printf("execution: agent=%s gas cost left unpriced, the ETH/USD feed could not be read: %v",
				req.AgentID, ferr)
		}
	}

	// Slippage against the QUOTE, not against the model price. The quote came
	// from the same calldata moments earlier, so any difference is the pool
	// moving underneath the transaction rather than the strategy being wrong.
	bps := new(big.Float).Quo(
		new(big.Float).SetInt(new(big.Int).Sub(filled, quoted)),
		new(big.Float).SetInt(quoted))
	bps.Mul(bps, big.NewFloat(10000))
	v, _ := bps.Float64()
	res.SlippageBps = &v
	return res, nil
}

// approve sends the allowance the router needs. It writes its own outcome into
// res and returns an error only to stop the caller continuing.
//
// An unresolved APPROVAL stops everything. Swapping on top of an allowance that
// may or may not exist is how one uncertain transaction becomes two.
func (b *Broker) approve(ctx context.Context, req Request, tokenIn TokenCfg, amount *big.Int, res *Result) error {
	nonce, err := b.rpc.Nonce(ctx, req.Wallet)
	if err != nil {
		res.Note = "could not read the nonce for the approval: " + err.Error()
		return err
	}
	signed, err := b.signer.Sign(ctx, SignRequest{
		Intent: "approve", AgentID: req.AgentID, TokenIn: tokenIn.Address,
		Router: b.cfg.Router(), Amount: amount.String(), Nonce: nonce,
		Gas: b.GasLimit, MaxFeeWei: b.MaxFeeWei.String(), TipWei: b.TipWei.String(),
	})
	if err != nil {
		var ref *Refusal
		var flt *Fault
		if errors.As(err, &ref) {
			res.Status = StatusRefused
			res.RefusalCode = ref.Code
			res.Note = "the approval was refused, so no swap was attempted: " + ref.Message
		} else if errors.As(err, &flt) {
			// Blocked, not refused: see the swap leg above. The approval is the
			// leg where this matters most — an unresolved approval stops
			// everything, and an operator needs to know whether to fix the
			// signer's policy or the route to it.
			res.RefusalCode = flt.Code
			res.Note = "the approval could not be signed, so no swap was attempted: " + flt.Message
		} else {
			res.Note = "the approval could not be signed: " + err.Error()
		}
		return err
	}
	hash, err := b.rpc.SendRaw(ctx, signed.Raw)
	if err != nil {
		res.Note = "the approval was rejected by every endpoint: " + err.Error()
		return err
	}
	// Same rule as the swap: once it is broadcast, the caller may not cancel
	// the part that finds out what happened to it.
	actx := context.WithoutCancel(ctx)
	actx, arelease := context.WithTimeout(actx, b.ReceiptWait+30*time.Second)
	defer arelease()
	rcpt, err := b.rpc.WaitReceipt(actx, hash, b.ReceiptWait, b.PollEvery)
	if err != nil || rcpt == nil {
		res.Status = StatusUnresolved
		res.TxHash = hash
		res.Note = "the APPROVAL is broadcast and unresolved, so no swap was attempted on top of " +
			"an allowance that may or may not exist"
		return fmt.Errorf("approval unresolved")
	}
	// Record the approval's own cost BEFORE deciding whether it worked. Its gas
	// was spent either way, and a reverted approval that leaves no trace of what
	// it cost is the same gap in a worse disguise.
	ar := &ApproveRecord{TxHash: hash, Token: tokenIn.Address, Amount: amount}
	if gu, ok := new(big.Int).SetString(trim0x(rcpt.GasUsed), 16); ok {
		ar.GasUsed = gu.Int64()
		if gp, ok2 := new(big.Int).SetString(trim0x(rcpt.EffGasPrice), 16); ok2 {
			ar.GasPriceWei = gp
			ar.GasCostWei = new(big.Int).Mul(gu, gp)
		}
	}
	res.Approve = ar

	if !rcpt.Succeeded() {
		ar.Status = StatusReverted
		ar.Note = "the approval was mined and reverted"
		// A reverted approval still burned gas, and an unpriced cost row is
		// read by the meter as an unreadable bill.
		b.priceApproval(actx, ar)
		res.Status = StatusReverted
		res.TxHash = hash
		res.Filled = big.NewInt(0)
		res.Note = "the approval reverted, so the swap was never attempted"
		return fmt.Errorf("approval reverted")
	}
	ar.Status = StatusMined
	ar.Note = "allowance granted so the swap could spend " + tokenIn.Symbol
	b.priceApproval(actx, ar)
	log.Printf("execution: agent=%s approval mined %s gas_wei=%v", req.AgentID, hash, ar.GasCostWei)
	return nil
}
