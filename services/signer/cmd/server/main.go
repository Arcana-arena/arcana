// Command server runs the ARCANA signer.
//
// It is the only process that holds key material, it runs as its own Linux
// user, and it never accepts calldata — only a NAMED INTENT, from which it
// builds the transaction itself.
//
// THE SHAPE OF THE RULE: the signer can do the things whose shape is permitted,
// not the things no rule forbids. There are two trading intents and four lending
// ones, the lending ones refused until the allowlist enables them. A caller
// cannot ask for a raw transfer because the API has no way to express one, and
// an intent name it does not recognise is refused rather than interpreted.
//
// IT DOES NOT BROADCAST. It returns a signed transaction and stops. Nothing in
// this service can move funds, which is what makes it safe to prove the
// refusals now, before anything is at stake.
package main

import (
	"context"
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

	"github.com/arcana/internalauth"
	"github.com/arcana/signer/internal/chain"
	"github.com/arcana/signer/internal/keys"
	"github.com/arcana/signer/internal/policy"
	"github.com/arcana/signer/internal/sigcount"
	"github.com/arcana/signer/internal/tx"
)

// Stamped at link time; see the note in the other services.
var buildCommit = "unknown"

type server struct {
	// The INTERFACE, not the concrete keyring. Moving to a KMS before the
	// first wallet is funded should be one new implementation and one line at
	// boot, not a change that reaches into every handler. See keys.Vault.
	ring   keys.Vault
	allow  *policy.Allowlist
	chain  *chain.Client
	dryRun bool

	// The DURABLE signature count. Nil when the count could not be read, which
	// makes every signing request refuse: a brake that cannot be read is not a
	// brake that is empty.
	sigs    *sigcount.Store
	sigsErr error
}

func main() {
	port := envOr("PORT", "8085")
	seedPath := envOr("SIGNER_MASTER_SEED_FILE", "/etc/arcana/signer/master.key")
	allowPath := envOr("SIGNER_ALLOWLIST_FILE", "allowlist/robinhood-mainnet.json")
	// Owner-supplied keys. Empty disables import entirely, which is the right
	// state for a deployment that has not opted into it: an unset variable
	// cannot accidentally enable key storage.
	importDir := os.Getenv("SIGNER_IMPORT_DIR")
	// Four endpoints, each probed with eth_call — the method this service
	// actually uses — rather than with eth_chainId, which anything answers.
	// Two otherwise-plausible providers (drpc, nodeflare) serve eth_chainId and
	// refuse eth_call, so a list checked the easy way would look redundant and
	// not be.
	//
	// Ordering is deliberate: the ones that publish no request tracking come
	// first. Every check this service makes reveals which wallet it is about to
	// sign for, so the endpoint that answers learns ARCANA's wallet set.
	rpcs := strings.Split(envOr("SIGNER_RPC_URLS",
		"https://rpc.mainnet.chain.robinhood.com,https://robinhood-rpc.publicnode.com,https://robinhood.api.pocket.network,https://rpc-robinhood.blockmachine.io"), ",")

	allow, err := policy.Load(allowPath)
	if err != nil {
		log.Fatalf("allowlist: %v", err)
	}
	log.Printf("allowlist loaded: chain %d, %d tokens, %d routers, reviewed %s",
		allow.ChainID, len(allow.Tokens), len(allow.Routers), allow.ReviewedAt)
	if len(allow.Routers) == 0 {
		log.Printf("NOTE: no router is allowlisted, so every swap will be REFUSED. That is the " +
			"correct state for a phase that must not move money — see the allowlist file.")
	}

	// The chain-state cache TTL is configurable because it is a real trade-off,
	// not a constant: shorter means an issuer pause is noticed sooner, longer
	// means fewer RPC calls on the hottest path this service has. 30s is the
	// default; the verification rig sets it near zero so it can drive the
	// paused/blocked states through their transitions without waiting.
	ttl := time.Duration(envInt("SIGNER_CHAIN_CACHE_TTL_MS", 30000)) * time.Millisecond
	srv := &server{
		allow:  allow,
		chain:  chain.New(rpcs, allow.ChainID, ttl),
		dryRun: os.Getenv("SIGNER_ALLOW_UNSAFE_SEED") == "",
	}

	// THE DAILY SIGNATURE COUNT, on disk and owned by this service.
	//
	// A missing file is a first boot and starts at zero. A file that exists and
	// cannot be understood makes every signing request refuse — see
	// countSignature. The distinction matters: refusing a fresh install would
	// mean nothing could ever sign, and trusting a corrupt one would mean the
	// cap silently reset.
	//
	// It is the signer's own record rather than a read of the executions table,
	// because executions describes what the decision engine did. Two of the
	// seven signatures this service had issued at the time of writing have no
	// row there at all.
	countPath := envOr("SIGNER_SIGNATURE_COUNT_FILE", "/etc/arcana/signer/state/signatures.json")
	if sigs, serr := sigcount.Open(countPath); serr != nil {
		srv.sigsErr = serr
		log.Printf("WARN: signer CANNOT ENFORCE THE DAILY CAP: %v", serr)
		log.Printf("WARN: every signing request will be refused. An unreadable brake is not an "+
			"empty one. Inspect or delete %s deliberately, then restart.", countPath)
	} else {
		srv.sigs = sigs
		day, counts := sigs.All()
		log.Printf("signature count loaded for %s: %d agent(s) with signatures today (cap %d/agent)",
			day, len(counts), allow.Limits.MaxSignaturesPerDay)
	}

	// The seed is loaded last, so a misconfiguration elsewhere fails before a
	// key is ever in memory.
	ring, err := keys.LoadKeyring(seedPath)
	if err != nil {
		// WITHOUT A SEED THE SERVICE STILL BOOTS AND SERVES /healthz, and every
		// signing request is REFUSED with the reason named. Same shape as the
		// vendor key and the LLM key: a visible stand-down, never a substitution.
		log.Printf("WARN: signer INACTIVE: %v", err)
		log.Printf("WARN: every signing request will be refused with reason 'signer_not_configured'. "+
			"No key material is held. Create the seed with: "+
			"sudo install -o arcana-signer -g arcana-signer -m 0400 /dev/null %s", seedPath)
	} else {
		if importDir != "" {
			ring, err = ring.WithImportDir(importDir)
			if err != nil {
				// Fatal. A misconfigured import directory means imported keys
				// either cannot be read or sit somewhere readable, and both are
				// worse than not starting.
				log.Fatalf("import dir: %v", err)
			}
			log.Printf("signer: owner-imported keys enabled at %s", importDir)
		} else {
			log.Printf("signer: owner-imported keys DISABLED (SIGNER_IMPORT_DIR unset); " +
				"every wallet is derived from the master seed")
		}
		srv.ring = ring
		log.Printf("signer ACTIVE: %s (seed %s)", ring.Describe(), seedPath)
	}

	// Drop any endpoint that cannot serve eth_call, loudly, before the first
	// signing request needs one.
	srv.chain.Preflight(context.Background())

	guard := internalauth.New("signer")

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]any{
			"status": "ok", "service": "signer", "commit": buildCommit,
			"signer_configured":   srv.ring != nil,
			"routers_allowlisted": len(allow.Routers), "chain_id": allow.ChainID,
			"lending_enabled": allow.Lending != nil && allow.Lending.Enabled,
		})
	})
	mux.HandleFunc("GET /internal/v1/signer/wallets/{agentId}", guard.Wrap(srv.handleWallet))
	mux.HandleFunc("POST /internal/v1/signer/sign", guard.Wrap(srv.handleSign))
	// The count is on disk and owned by this user, so it cannot be read with
	// SQL. This is how an operator or a watchdog sees it instead -- the answer
	// to "why can a database credential not just be added" has to come with a
	// way to get the same information without one.
	mux.HandleFunc("GET /internal/v1/signer/signatures", guard.Wrap(srv.handleSignatureCounts))
	mux.HandleFunc("POST /internal/v1/signer/wallets/{agentId}/export", guard.Wrap(srv.handleExport))
	mux.HandleFunc("POST /internal/v1/signer/wallets/{agentId}/import", guard.Wrap(srv.handleImport))

	log.Printf("signer listening on 127.0.0.1:%s", port)
	if err := http.ListenAndServe("127.0.0.1:"+port, mux); err != nil {
		log.Fatal(err)
	}
}

// --- wallets ---------------------------------------------------------------

func (s *server) handleWallet(w http.ResponseWriter, r *http.Request) {
	if s.ring == nil {
		refuse(w, "signer_not_configured", "no master seed is loaded")
		return
	}
	agentID := r.PathValue("agentId")
	addr, err := s.ring.Address(agentID)
	if err != nil {
		refuse(w, "derive_failed", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"agent_id": agentID, "address": addr})
}

// --- signing ----------------------------------------------------------------

// signRequest is the ENTIRE vocabulary a caller has.
//
// There is no `data` field, no `to` field, no `value` field. A caller cannot
// express "send these tokens to this address" because the words do not exist.
// Unknown JSON keys are rejected outright rather than ignored, so a request
// that thinks it is asking for something else is told it is wrong instead of
// quietly getting something it did not ask for.
type signRequest struct {
	Intent   string `json:"intent"` // approve | swap_exact_in | lending_approve | lending_supply | lending_borrow | lending_repay
	AgentID  string `json:"agent_id"`
	MarketID string `json:"market_id"` // lending only: an allowlisted Morpho market
	// RepayAll repays the WHOLE debt by shares, read from the chain here, rather
	// than an asset amount. `amount` is still required and bounds nothing else.
	RepayAll  bool   `json:"repay_all"`
	TokenIn   string `json:"token_in"`
	TokenOut  string `json:"token_out"` // swap only
	Router    string `json:"router"`
	Amount    string `json:"amount"`  // base units, decimal or 0x-hex
	MinOut    string `json:"min_out"` // swap only
	Nonce     uint64 `json:"nonce"`
	Gas       uint64 `json:"gas"`
	MaxFeeWei string `json:"max_fee_wei"`
	TipWei    string `json:"tip_wei"`
}

func (s *server) handleSign(w http.ResponseWriter, r *http.Request) {
	if s.ring == nil {
		refuse(w, "signer_not_configured", "no master seed is loaded; nothing can be signed")
		return
	}

	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields() // an unrecognised field is a different request
	var req signRequest
	if err := dec.Decode(&req); err != nil {
		refuse(w, "bad_request", err.Error())
		return
	}
	if req.AgentID == "" {
		refuse(w, "bad_request", "agent_id is required")
		return
	}

	wallet, err := s.ring.Address(req.AgentID)
	if err != nil {
		refuse(w, "derive_failed", err.Error())
		return
	}

	// Daily cap, before anything expensive.
	if ref := s.countSignature(req.AgentID); ref != nil {
		refuseCode(w, ref)
		return
	}

	amount, err := tx.ParseHexAmount(req.Amount)
	if err != nil {
		refuse(w, "bad_request", err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	var data []byte
	var to string

	switch req.Intent {
	case "approve":
		if ref := s.allow.CheckApprove(req.TokenIn, req.Router, amount); ref != nil {
			refuseCode(w, ref)
			return
		}
		if ref := s.chainChecks(ctx, req.TokenIn, wallet); ref != nil {
			refuseCode(w, ref)
			return
		}
		to = req.TokenIn
		data = tx.EncodeApprove(req.Router, amount)

	case "swap_exact_in":
		minOut, err := tx.ParseHexAmount(req.MinOut)
		if err != nil {
			refuse(w, "bad_request", "min_out: "+err.Error())
			return
		}
		// The recipient is not a parameter. It is the agent's own wallet, and
		// there is no way for a caller to make it anything else.
		if ref := s.allow.CheckSwap(req.Router, req.TokenIn, req.TokenOut, wallet, wallet, amount); ref != nil {
			refuseCode(w, ref)
			return
		}
		for _, t := range []string{req.TokenIn, req.TokenOut} {
			if ref := s.chainChecks(ctx, t, wallet); ref != nil {
				refuseCode(w, ref)
				return
			}
		}
		fee, ref := s.allow.PoolFeeFor(req.TokenIn, req.TokenOut)
		if ref != nil {
			refuseCode(w, ref)
			return
		}
		to = req.Router
		data = tx.EncodeExactInputSingle(tx.SwapParams{
			TokenIn: req.TokenIn, TokenOut: req.TokenOut, Fee: fee,
			Recipient: wallet, AmountIn: amount, MinOut: minOut,
		})

	// --- ARCANA CAPITAL. Refused with lending_not_enabled until the allowlist
	// says otherwise; see policy/lending.go. The wallet is onBehalf and
	// receiver in every one of them, and there is no field to change that.
	case "lending_approve":
		morpho, ref := s.allow.CheckLendingApprove(req.MarketID, req.TokenIn, amount)
		if ref != nil {
			refuseCode(w, ref)
			return
		}
		if ref := s.chainChecks(ctx, req.TokenIn, wallet); ref != nil {
			refuseCode(w, ref)
			return
		}
		to = req.TokenIn
		data = tx.EncodeApprove(morpho, amount)

	case "lending_supply":
		m, morpho, ref := s.allow.CheckSupply(req.MarketID, amount)
		if ref != nil {
			refuseCode(w, ref)
			return
		}
		if ref := s.chainChecks(ctx, m.CollateralToken, wallet); ref != nil {
			refuseCode(w, ref)
			return
		}
		to = morpho
		data = tx.EncodeSupplyCollateral(marketParams(m), amount, wallet)

	case "lending_borrow":
		// The debt is read BEFORE the cap is applied and is never cached, so
		// the cap sees the borrow that went through a moment ago. An unreadable
		// debt reaches CheckBorrow as nil and refuses there.
		var current *big.Int
		if _, morpho, ref := s.allow.Market(req.MarketID); ref == nil {
			if d, derr := s.chain.DebtOf(ctx, morpho, req.MarketID, wallet); derr == nil {
				current = d
			} else {
				log.Printf("debt unreadable for agent=%s market=%s: %v", req.AgentID, req.MarketID, derr)
			}
		}
		m, morpho, ref := s.allow.CheckBorrow(req.MarketID, amount, current)
		if ref != nil {
			refuseCode(w, ref)
			return
		}
		if ref := s.chainChecks(ctx, m.LoanToken, wallet); ref != nil {
			refuseCode(w, ref)
			return
		}
		to = morpho
		data = tx.EncodeBorrow(marketParams(m), amount, wallet)

	case "lending_repay":
		m, morpho, ref := s.allow.CheckRepay(req.MarketID, amount)
		if ref != nil {
			refuseCode(w, ref)
			return
		}
		if ref := s.chainChecks(ctx, m.LoanToken, wallet); ref != nil {
			refuseCode(w, ref)
			return
		}
		to = morpho
		if req.RepayAll {
			// The shares are read here, from the chain, never taken from the
			// caller: a caller-supplied share count could repay someone else's
			// idea of the debt. Unreadable refuses.
			shares, serr := s.chain.BorrowSharesOf(ctx, morpho, req.MarketID, wallet)
			if serr != nil {
				refuse(w, policy.CodeChainUnverifiable, "the borrow shares to repay could not be read: "+serr.Error())
				return
			}
			if shares.Sign() == 0 {
				refuse(w, policy.CodeAmountNotPositive, "there is no debt in this market to repay")
				return
			}
			data = tx.EncodeRepayShares(marketParams(m), shares, wallet)
		} else {
			data = tx.EncodeRepay(marketParams(m), amount, wallet)
		}

	default:
		// The allowlist principle, stated at the door: an intent nobody
		// permitted is refused, whether or not any rule forbids it.
		refuse(w, policy.CodeUnknownIntent, fmt.Sprintf(
			"intent %q is not one this signer can build. It knows approve and swap_exact_in, and "+
				"lending_approve, lending_supply, lending_borrow and lending_repay while lending is "+
				"enabled. An unrecognised shape is refused rather than interpreted", req.Intent))
		return
	}

	maxFee, err := tx.ParseHexAmount(orDefault(req.MaxFeeWei, "1000000000"))
	if err != nil {
		refuse(w, "bad_request", "max_fee_wei: "+err.Error())
		return
	}
	tip, err := tx.ParseHexAmount(orDefault(req.TipWei, "20000000"))
	if err != nil {
		refuse(w, "bad_request", "tip_wei: "+err.Error())
		return
	}
	gas := req.Gas
	if gas == 0 {
		gas = 250000
	}

	t := &tx.Tx{
		ChainID:              big.NewInt(s.allow.ChainID),
		Nonce:                req.Nonce,
		MaxPriorityFeePerGas: tip,
		MaxFeePerGas:         maxFee,
		Gas:                  gas,
		To:                   to,
		Data:                 data,
	}
	hash := t.SigningHash()
	sr, ss, v, err := s.ring.SignHash(req.AgentID, hash)
	if err != nil {
		refuse(w, "sign_failed", err.Error())
		return
	}

	// Counted and persisted before the signed transaction leaves this function.
	if ref := s.recordSignature(req.AgentID); ref != nil {
		refuseCode(w, ref)
		return
	}
	log.Printf("signed intent=%s agent=%s to=%s chain=%d", req.Intent, req.AgentID, to, s.allow.ChainID)

	writeJSON(w, 200, map[string]any{
		"agent_id": req.AgentID,
		"from":     wallet,
		"to":       to,
		"chain_id": s.allow.ChainID,
		"intent":   req.Intent,
		"raw":      t.Signed(sr, ss, v),
		"tx_hash":  t.Hash(sr, ss, v),
		// Said out loud in every response, because a caller that assumes
		// otherwise is the bug this phase exists to prevent.
		"broadcast": false,
		"note":      "signed only; this service never broadcasts",
	})
}

// chainChecks asks the issuer's two switches, and refuses if it cannot.
func (s *server) chainChecks(ctx context.Context, token, wallet string) *policy.Refusal {
	paused, err := s.chain.Paused(ctx, token)
	if err != nil {
		return &policy.Refusal{Code: policy.CodeChainUnverifiable, Detail: fmt.Sprintf(
			"could not read paused() for %s: %v. Refusing: could not check is not the same as fine",
			token, err)}
	}
	if paused {
		return &policy.Refusal{Code: policy.CodeTokenPaused, Detail: fmt.Sprintf(
			"token %s is paused by its issuer; a transfer would revert", token)}
	}
	blocked, err := s.chain.Blocked(ctx, token, wallet)
	if err != nil {
		// AN UNREADABLE BLOCKLIST IS STILL NOT AN EMPTY ONE. The default here
		// is refusal, and it stays refusal for every token that has not been
		// examined and written down.
		//
		// What changes it is a per-token record in the allowlist saying this
		// token HAS no isBlocked() — with the revert payload proving it, and a
		// control selector that exists nowhere returning the same payload. The
		// exception is checked against the chain right here, on every
		// signature, rather than trusted from the file: if the token starts
		// answering, err is nil and this branch is not even reached; if it
		// reverts differently, the recorded evidence no longer describes the
		// contract and the exception is void. That is how it expires without
		// anybody remembering to expire it.
		tok, listErr := s.allow.Token(token)
		if listErr == nil && tok.BlocklistUnreadable != nil {
			var rev *chain.RevertError
			if errors.As(err, &rev) {
				if tok.BlocklistUnreadable.Matches(rev.Data) {
					return nil
				}
				return &policy.Refusal{Code: policy.CodeChainUnverifiable, Detail: fmt.Sprintf(
					"%s records isBlocked() as absent, reverting with %q when verified %s — it now reverts "+
						"with %q. The contract changed, so the recorded evidence no longer describes it and "+
						"the exception does not apply. Re-verify and update the allowlist",
					tok.Symbol, tok.BlocklistUnreadable.RevertData, tok.BlocklistUnreadable.VerifiedAt, rev.Data)}
			}
			return &policy.Refusal{Code: policy.CodeChainUnverifiable, Detail: fmt.Sprintf(
				"%s records isBlocked() as absent, but the call did not reach the contract at all: %v. "+
					"A network failure is not evidence about a blocklist", tok.Symbol, err)}
		}
		return &policy.Refusal{Code: policy.CodeChainUnverifiable, Detail: fmt.Sprintf(
			"could not read isBlocked(%s) on %s: %v. Refusing rather than assuming the wallet is clear",
			wallet, token, err)}
	}
	if blocked {
		return &policy.Refusal{Code: policy.CodeWalletBlocked, Detail: fmt.Sprintf(
			"wallet %s is blocked by the issuer of %s", wallet, token)}
	}
	return nil
}

// countSignature is the daily cap, read from disk rather than from memory.
//
// It used to be an in-process map, which reset on every restart. That was
// tolerable while the cadence was locked at four hours and a deploy or two a day
// merely loosened a limit measured in tens. It stopped being tolerable when the
// cadence floor came off and TP/SL added a second source of transactions that
// can fire without a decision cycle: three deploys in a day turned a cap of 24
// into an effective 72, and nothing said so.
func (s *server) countSignature(agentID string) *policy.Refusal {
	if s.allow.Limits.MaxSignaturesPerDay <= 0 {
		return nil
	}
	// AN UNREADABLE COUNT REFUSES. Assuming zero would silently reset the cap,
	// which is the exact failure the durable count exists to remove — and it is
	// the same rule an unreadable isBlocked() follows.
	if s.sigs == nil {
		return &policy.Refusal{Code: policy.CodeDailyCap, Detail: fmt.Sprintf(
			"the signature count could not be read (%v), so the daily cap cannot be "+
				"enforced. Refusing rather than treating an unreadable brake as an empty one",
			s.sigsErr)}
	}
	used := s.sigs.Count(agentID)
	if used >= s.allow.Limits.MaxSignaturesPerDay {
		return &policy.Refusal{Code: policy.CodeDailyCap, Detail: fmt.Sprintf(
			"agent %s has already had %d signatures today and the cap is %d, enforced at the "+
				"signer. Note that an approve and its swap are two signatures: the broker "+
				"approves exactly the trade amount, so every swap needs a fresh allowance",
			agentID, used, s.allow.Limits.MaxSignaturesPerDay)}
	}
	return nil
}

// recordSignature persists BEFORE the signature is handed back.
//
// A crash between counting and returning costs the agent one signature it never
// received. The other order loses one it DID receive, which is the cap refunding
// itself — and that is worse, because nothing downstream would ever notice.
//
// A failure to persist refuses the signature outright for the same reason.
func (s *server) recordSignature(agentID string) *policy.Refusal {
	if s.allow.Limits.MaxSignaturesPerDay <= 0 || s.sigs == nil {
		return nil
	}
	if err := s.sigs.Record(agentID); err != nil {
		return &policy.Refusal{Code: policy.CodeDailyCap, Detail: fmt.Sprintf(
			"the signature could not be counted (%v), so it is not issued. A signature that "+
				"is not counted is one the cap will never see", err)}
	}
	return nil
}

// --- helpers ---------------------------------------------------------------

func marketParams(m policy.LendingMarket) tx.MarketParams {
	loan, coll, oracle, irm, lltv := m.Params()
	return tx.MarketParams{LoanToken: loan, CollateralToken: coll, Oracle: oracle, IRM: irm, LLTV: lltv}
}

func refuse(w http.ResponseWriter, code, detail string) {
	log.Printf("REFUSED %s: %s", code, detail)
	writeJSON(w, http.StatusForbidden, map[string]any{
		"error": map[string]any{"code": code, "message": detail},
	})
}

func refuseCode(w http.ResponseWriter, r *policy.Refusal) { refuse(w, r.Code, r.Detail) }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
		log.Printf("WARN %s=%q is not a number; using %d", k, v, def)
	}
	return def
}

func orDefault(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return v
}

// --- key custody: export and import ------------------------------------------
//
// THESE TWO ENDPOINTS ARE THE ONLY WAY KEY MATERIAL CROSSES THIS SERVICE'S
// BOUNDARY IN EITHER DIRECTION, and both exist because a custodial wallet the
// owner can never take possession of is not really the owner's wallet.
//
// Both are machine tier behind the internal key. agent-service calls them
// having already proved, from the session, that the caller owns the agent. The
// signer does not and cannot check ownership — it has no idea who owns what —
// so the internal key is doing real work here rather than being ceremony.

// handleExport hands an agent's private key to its owner. Once.
//
// AFTER THIS, ARCANA IS NOT THE ONLY PARTY WHO CAN SPEND. The caller is
// responsible for recording that (agent_wallets.key_custody = 'shared'), and
// every later assumption about the balance has to account for an owner who can
// move funds without asking. See the custody_drift table.
//
// The key is not logged, not put in an error message, and not retained. What
// IS logged is that an export happened, for which agent, and when — the event
// is exactly the thing an audit needs and the value is exactly the thing it
// must not contain.
func (s *server) handleExport(w http.ResponseWriter, r *http.Request) {
	if s.ring == nil {
		refuse(w, "signer_not_configured", "no master seed is loaded")
		return
	}
	agentID := r.PathValue("agentId")
	privHex, addr, err := s.ring.Export(agentID)
	if err != nil {
		refuse(w, "export_failed", err.Error())
		return
	}
	log.Printf("KEY EXPORTED for agent %s (address %s) — this wallet is now jointly held",
		agentID, addr)
	writeJSON(w, 200, map[string]any{
		"agent_id":    agentID,
		"address":     addr,
		"private_key": "0x" + privHex,
		"custody":     "shared",
		"warning": "You now hold this key and so does ARCANA. Anyone with it can " +
			"spend everything at this address. ARCANA cannot un-export it and cannot " +
			"tell whether you have kept it safe. If you move funds from this wallet " +
			"yourself the platform will find out by reading the chain, not by being " +
			"told, and will reconcile its record to what the chain says.",
	})
}

type importRequest struct {
	PrivateKey string `json:"private_key"`
}

// handleImport takes a key the owner already controls.
//
// THE ADDRESS IS DERIVED FROM THE KEY, never accepted from the caller. If a
// caller could state the address, the wallet row would say one thing and the
// signer would sign for another, and nobody would find out until money arrived
// somewhere unexpected.
//
// Unknown JSON fields are rejected outright, the same rule the sign endpoint
// follows: a request that thinks it is asking for something else must be told
// it is wrong rather than quietly getting something it did not ask for.
func (s *server) handleImport(w http.ResponseWriter, r *http.Request) {
	if s.ring == nil {
		refuse(w, "signer_not_configured", "no master seed is loaded")
		return
	}
	agentID := r.PathValue("agentId")

	dec := json.NewDecoder(io.LimitReader(r.Body, 4096))
	dec.DisallowUnknownFields()
	var req importRequest
	if err := dec.Decode(&req); err != nil {
		refuse(w, "bad_request", err.Error())
		return
	}
	if strings.TrimSpace(req.PrivateKey) == "" {
		refuse(w, "bad_request", "private_key is required")
		return
	}

	addr, err := s.ring.Import(agentID, req.PrivateKey)
	if err != nil {
		// The error text never contains the key: parsePrivateKey reports the
		// SHAPE of the problem (wrong length, not hex, out of range) and never
		// echoes the value.
		refuse(w, "import_failed", err.Error())
		return
	}
	log.Printf("KEY IMPORTED for agent %s (address %s) — owner-supplied, jointly held from the start",
		agentID, addr)
	writeJSON(w, 200, map[string]any{
		"agent_id": agentID,
		"address":  addr,
		"custody":  "shared",
		"warning": "USE A WALLET DEDICATED TO THIS AGENT AND NOTHING ELSE. ARCANA now " +
			"holds this key and can sign ANY transaction with it, not only trades. " +
			"This service restricts what it will build — an allowlisted router, an " +
			"allowlisted token, a capped size — but that is ARCANA restricting itself, " +
			"not a property of the key you gave it. Do not import a wallet that holds " +
			"anything you are not putting under this agent's control.",
	})
}

// handleSignatureCounts reports today's per-agent signature usage.
//
// Read-only, internal-tier, and it reports the CAP alongside the counts so a
// reader does not have to go and find the allowlist to know what the numbers
// mean. An unreadable count answers with its error rather than with zeros,
// because zeros here would read as "nothing has signed today".
func (s *server) handleSignatureCounts(w http.ResponseWriter, _ *http.Request) {
	if s.sigs == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": map[string]any{
				"code":    "signature_count_unreadable",
				"message": fmt.Sprintf("%v", s.sigsErr),
			},
		})
		return
	}
	day, counts := s.sigs.All()
	writeJSON(w, http.StatusOK, map[string]any{
		"day":           day,
		"cap_per_agent": s.allow.Limits.MaxSignaturesPerDay,
		"counts":        counts,
		"note":          "One approve and its swap are two signatures. The broker approves exactly the trade amount, so every swap needs a fresh allowance.",
	})
}
