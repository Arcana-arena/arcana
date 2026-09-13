// Command anchor is the anchoring signer: it signs exactly one kind of
// transaction, and it holds exactly one key.
//
// # WHY IT IS NOT A THIRD INTENT ON THE SIGNER
//
// The signer (cmd/server) holds the seed every agent wallet is derived from, and
// its defining property is that a caller cannot put bytes into a transaction:
// no `to`, no `data`, no `value`. Anchoring a Merkle root is precisely putting
// bytes into a transaction. Adding it there would make "no caller-influenced
// data" false for the one process that holds other people's money, and
// docs/signer.md says a new shape is its own decision, not a small change.
//
// So it is a separate binary, run as a separate user, reading a separate key
// that is NOT derived from the seed — no agent id reaches it. It shares the
// transaction and signing code (internal/tx, internal/keys) so there is still
// one implementation of RLP, EIP-1559 hashing and low-S signing.
//
// # THE ONE SHAPE
//
// A zero-value EIP-1559 transaction from the anchoring address TO ITSELF whose
// input is "ARCANA" 0x00 0x01 followed by a 32-byte Merkle root. The caller
// supplies the root, the nonce, the fees and the gas — nothing else, and the
// request is refused if it names any other field. There is no contract: the
// root is readable by anyone from the transaction input with any RPC.
//
// Limits: fees and gas are capped, and signatures are counted per day on disk.
// Like the signer, it never broadcasts.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"sync"

	"github.com/arcana/internalauth"
	"github.com/arcana/signer/internal/keys"
	"github.com/arcana/signer/internal/sigcount"
	"github.com/arcana/signer/internal/tx"
	"github.com/decred/dcrd/dcrec/secp256k1/v4"
)

var buildCommit = "unknown"

// anchorMagic opens every anchoring transaction's input: "ARCANA" 0x00 0x01.
// Version byte last, so a later scheme is a different payload rather than a
// reinterpretation of this one.
var anchorMagic = []byte{'A', 'R', 'C', 'A', 'N', 'A', 0x00, 0x01}

var rootPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// countKey is the one "agent" whose signatures sigcount keeps for this service.
const countKey = "anchor"

type server struct {
	priv    *secp256k1.PrivateKey
	address string
	keyErr  error

	chainID *big.Int
	maxFee  *big.Int
	maxGas  uint64
	perDay  int

	mu      sync.Mutex
	sigs    *sigcount.Store
	sigsErr error
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "keygen" {
		keygen(os.Args[2:])
		return
	}

	port := envOr("PORT", "8087")
	keyPath := envOr("ANCHOR_KEY_FILE", "/etc/arcana/anchor/anchor.key")
	s := &server{
		chainID: big.NewInt(int64(envInt("ANCHOR_CHAIN_ID", 4663))),
		maxGas:  uint64(envInt("ANCHOR_MAX_GAS", 150000)),
		perDay:  envInt("ANCHOR_MAX_PER_DAY", 96),
	}
	maxFee, ok := new(big.Int).SetString(envOr("ANCHOR_MAX_FEE_WEI", "5000000000"), 10)
	if !ok || maxFee.Sign() <= 0 {
		log.Fatalf("ANCHOR_MAX_FEE_WEI is not a positive integer")
	}
	s.maxFee = maxFee

	countPath := envOr("ANCHOR_SIGNATURE_COUNT_FILE", "/etc/arcana/anchor/state/signatures.json")
	if sigs, err := sigcount.Open(countPath); err != nil {
		s.sigsErr = err
		log.Printf("WARN: anchoring signer CANNOT ENFORCE ITS DAILY CAP: %v — every request will be refused", err)
	} else {
		s.sigs = sigs
	}

	if priv, err := keys.LoadStandaloneKey(keyPath); err != nil {
		s.keyErr = err
		log.Printf("WARN: anchoring signer INACTIVE: %v", err)
		log.Printf("WARN: every request will be refused. Creating the key is a deliberate act: "+
			"sudo -u arcana-anchor /usr/local/bin/arcana-anchor-signer keygen %s", keyPath)
	} else {
		s.priv = priv
		s.address = keys.AddressOf(priv)
		log.Printf("anchoring signer ACTIVE: %s, chain %s, max fee %s wei, max gas %d, %d/day",
			s.address, s.chainID, s.maxFee, s.maxGas, s.perDay)
	}

	guard := internalauth.New("anchor-signer")
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]any{
			"status": "ok", "service": "anchor-signer", "commit": buildCommit,
			"configured": s.priv != nil, "address": nullable(s.address), "chain_id": s.chainID.String(),
		})
	})
	mux.HandleFunc("GET /internal/v1/anchor/address", guard.Wrap(s.handleAddress))
	mux.HandleFunc("POST /internal/v1/anchor/sign", guard.Wrap(s.handleSign))

	log.Printf("anchoring signer listening on 127.0.0.1:%s", port)
	if err := http.ListenAndServe("127.0.0.1:"+port, mux); err != nil {
		log.Fatal(err)
	}
}

func (s *server) handleAddress(w http.ResponseWriter, _ *http.Request) {
	if s.priv == nil {
		refuse(w, 503, "anchor_signer_not_configured", s.keyErr.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"address": s.address, "chain_id": s.chainID.String()})
}

type signRequest struct {
	Root      string  `json:"root"`
	Nonce     *uint64 `json:"nonce"`
	MaxFeeWei string  `json:"max_fee_wei"`
	TipWei    string  `json:"tip_wei"`
	Gas       uint64  `json:"gas"`
}

func (s *server) handleSign(w http.ResponseWriter, r *http.Request) {
	if s.priv == nil {
		refuse(w, 503, "anchor_signer_not_configured", s.keyErr.Error())
		return
	}
	if s.sigs == nil {
		refuse(w, 503, "signature_count_unreadable", fmt.Sprint(s.sigsErr))
		return
	}

	var req signRequest
	dec := json.NewDecoder(io.LimitReader(r.Body, 4096))
	// NO OTHER FIELD. A request naming `data`, `to` or `value` is refused, not
	// ignored: ignoring it would let a caller believe it had said something.
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		refuse(w, 400, "bad_request", "the request must be exactly {root, nonce, max_fee_wei, tip_wei, gas}: "+err.Error())
		return
	}
	if !rootPattern.MatchString(req.Root) {
		refuse(w, 400, "bad_root", "root must be 64 lowercase hex characters: a sha256 Merkle root and nothing else")
		return
	}
	if req.Nonce == nil {
		refuse(w, 400, "nonce_required", "nonce is required; this service does not read the chain")
		return
	}
	maxFee, err := tx.ParseHexAmount(req.MaxFeeWei)
	if err != nil || maxFee.Sign() <= 0 {
		refuse(w, 400, "bad_fee", "max_fee_wei must be a positive integer")
		return
	}
	tip, err := tx.ParseHexAmount(req.TipWei)
	if err != nil {
		refuse(w, 400, "bad_fee", "tip_wei must be a non-negative integer")
		return
	}
	if maxFee.Cmp(s.maxFee) > 0 {
		refuse(w, 422, "fee_above_cap", fmt.Sprintf("max_fee_wei %s is above the cap of %s", maxFee, s.maxFee))
		return
	}
	if tip.Cmp(maxFee) > 0 {
		refuse(w, 422, "tip_above_fee", "tip_wei cannot exceed max_fee_wei")
		return
	}
	if req.Gas < 21000 || req.Gas > s.maxGas {
		refuse(w, 422, "gas_out_of_range", fmt.Sprintf("gas %d is outside [21000, %d]", req.Gas, s.maxGas))
		return
	}

	// COUNTED BEFORE THE SIGNATURE LEAVES, under one lock, so two requests
	// racing at the cap cannot both pass it.
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sigs.Count(countKey) >= s.perDay {
		refuse(w, 429, "daily_cap_reached", fmt.Sprintf("%d anchors have been signed today; the cap is %d", s.sigs.Count(countKey), s.perDay))
		return
	}

	root, _ := hex.DecodeString(req.Root)
	data := append(append([]byte{}, anchorMagic...), root...)
	t := &tx.Tx{
		ChainID:              s.chainID,
		Nonce:                *req.Nonce,
		MaxPriorityFeePerGas: tip,
		MaxFeePerGas:         maxFee,
		Gas:                  req.Gas,
		To:                   s.address, // ITSELF. Nothing is sent anywhere.
		Data:                 data,
	}
	rs, ss, v, err := keys.SignHashWith(s.priv, t.SigningHash())
	if err != nil {
		refuse(w, 500, "sign_failed", err.Error())
		return
	}
	if err := s.sigs.Record(countKey); err != nil {
		refuse(w, 503, "signature_count_unwritable", "the signature was not released because it could not be counted: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{
		"raw":       t.Signed(rs, ss, v),
		"tx_hash":   t.Hash(rs, ss, v),
		"from":      s.address,
		"to":        s.address,
		"data":      "0x" + hex.EncodeToString(data),
		"chain_id":  s.chainID.String(),
		"broadcast": false,
	})
}

// keygen creates the anchoring key. Deliberately a command someone runs, never
// something an installer does, and it refuses to overwrite: replacing the key
// would orphan every anchor's sender address.
func keygen(args []string) {
	path := "/etc/arcana/anchor/anchor.key"
	if len(args) > 0 && args[0] != "" {
		path = args[0]
	}
	if _, err := os.Stat(path); err == nil {
		log.Fatalf("keygen: %s already exists; refusing to overwrite the anchoring key", path)
	}
	var hexKey string
	for i := 0; i < 8; i++ {
		buf := make([]byte, 32)
		if _, err := rand.Read(buf); err != nil {
			log.Fatalf("keygen: %v", err)
		}
		candidate := hex.EncodeToString(buf)
		if _, err := keys.ParsePrivateKeyHex(candidate); err == nil {
			hexKey = candidate
			break
		}
	}
	if hexKey == "" {
		log.Fatal("keygen: could not produce a valid key")
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o400)
	if err != nil {
		log.Fatalf("keygen: %v", err)
	}
	if _, err := f.WriteString(hexKey + "\n"); err != nil {
		f.Close()
		log.Fatalf("keygen: %v", err)
	}
	if err := f.Close(); err != nil {
		log.Fatalf("keygen: %v", err)
	}
	priv, err := keys.LoadStandaloneKey(path)
	if err != nil {
		log.Fatalf("keygen: wrote %s but cannot read it back: %v", path, err)
	}
	fmt.Printf("anchoring key created at %s\naddress %s\nfund this address with the chain's gas token; it needs nothing else\n",
		path, keys.AddressOf(priv))
}

func refuse(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"refused": true, "code": code, "message": message})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
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

var _ = errors.New
