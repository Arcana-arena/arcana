// Command server runs the ARCANA signer.
//
// It is the only process that holds key material, it runs as its own Linux
// user, and it never accepts calldata — only a NAMED INTENT, from which it
// builds the transaction itself.
//
// THE SHAPE OF THE RULE: the signer can do the things whose shape is permitted,
// not the things no rule forbids. There are two intents. A caller cannot ask
// for a raw transfer because the API has no way to express one, and an intent
// name it does not recognise is refused rather than interpreted.
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
	"sync"
	"time"

	"github.com/arcana/internalauth"
	"github.com/arcana/signer/internal/chain"
	"github.com/arcana/signer/internal/keys"
	"github.com/arcana/signer/internal/policy"
	"github.com/arcana/signer/internal/tx"
)

// Stamped at link time; see the note in the other services.
var buildCommit = "unknown"

type server struct {
	// The INTERFACE, not the concrete keyring. Moving to a KMS before the
	// first wallet is funded should be one new implementation and one line at
	// boot, not a change that reaches into every handler. See keys.Vault.
	ring    keys.Vault
	allow   *policy.Allowlist
	chain   *chain.Client
	dryRun  bool

	mu    sync.Mutex
	daily map[string]dayCount
}

type dayCount struct {
	day   string
	count int
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
		daily:  map[string]dayCount{},
		dryRun: os.Getenv("SIGNER_ALLOW_UNSAFE_SEED") == "",
	}

	// The seed is loaded last, so a misconfiguration elsewhere fails before a
	// key is ever in memory.
	ring, err := keys.LoadKeyring(seedPath)
	if err != nil {
		// WITHOUT A SEED THE SERVICE STILL BOOTS AND SERVES /healthz, and every
		// signing request is REFUSED with the reason named. Same shape as the
		// vendor key and the LLM key: a visible stand-down, never a substitution.
		log.Printf("WARN: signer INACTIVE: %v", err)
		log.Printf("WARN: every signing request will be refused with reason 'signer_not_configured'. " +
			"No key material is held. Create the seed with: " +
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
			"signer_configured": srv.ring != nil,
			"routers_allowlisted": len(allow.Routers), "chain_id": allow.ChainID,
		})
	})
	mux.HandleFunc("GET /internal/v1/signer/wallets/{agentId}", guard.Wrap(srv.handleWallet))
	mux.HandleFunc("POST /internal/v1/signer/sign", guard.Wrap(srv.handleSign))
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
	Intent    string `json:"intent"`     // approve | swap_exact_in
	AgentID   string `json:"agent_id"`
	TokenIn   string `json:"token_in"`
	TokenOut  string `json:"token_out"`  // swap only
	Router    string `json:"router"`
	Amount    string `json:"amount"`     // base units, decimal or 0x-hex
	MinOut    string `json:"min_out"`    // swap only
	PriceUSD  float64 `json:"price_usd"` // of token_in, for the notional cap
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
		if ref := s.allow.CheckApprove(req.TokenIn, req.Router, amount, req.PriceUSD); ref != nil {
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
		if ref := s.allow.CheckSwap(req.Router, req.TokenIn, req.TokenOut, wallet, wallet, amount, req.PriceUSD); ref != nil {
			refuseCode(w, ref)
			return
		}
		for _, t := range []string{req.TokenIn, req.TokenOut} {
			if ref := s.chainChecks(ctx, t, wallet); ref != nil {
				refuseCode(w, ref)
				return
			}
		}
		tok, _ := s.allow.Token(req.TokenOut)
		to = req.Router
		data = tx.EncodeExactInputSingle(tx.SwapParams{
			TokenIn: req.TokenIn, TokenOut: req.TokenOut, Fee: tok.PoolFee,
			Recipient: wallet, AmountIn: amount, MinOut: minOut,
		})

	default:
		// The allowlist principle, stated at the door: an intent nobody
		// permitted is refused, whether or not any rule forbids it.
		refuse(w, policy.CodeUnknownIntent, fmt.Sprintf(
			"intent %q is not one this signer can build. It knows two: approve, swap_exact_in. "+
				"An unrecognised shape is refused rather than interpreted", req.Intent))
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

	s.recordSignature(req.AgentID)
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

func (s *server) countSignature(agentID string) *policy.Refusal {
	if s.allow.Limits.MaxSignaturesPerDay <= 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	today := time.Now().UTC().Format("2006-01-02")
	c := s.daily[agentID]
	if c.day != today {
		c = dayCount{day: today}
	}
	if c.count >= s.allow.Limits.MaxSignaturesPerDay {
		return &policy.Refusal{Code: policy.CodeDailyCap, Detail: fmt.Sprintf(
			"agent %s has already had %d signatures today, the cap enforced at the signer",
			agentID, c.count)}
	}
	return nil
}

func (s *server) recordSignature(agentID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	today := time.Now().UTC().Format("2006-01-02")
	c := s.daily[agentID]
	if c.day != today {
		c = dayCount{day: today}
	}
	c.count++
	s.daily[agentID] = c
}

// --- helpers ---------------------------------------------------------------

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
