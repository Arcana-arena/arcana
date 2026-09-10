// Package keys holds the only secret material in ARCANA that can move money.
//
// DERIVED, NOT STORED. Every agent's private key is derived from one master
// seed with HKDF-SHA512, keyed by the agent's id. No per-agent private key is
// ever written anywhere — not to the database, not to disk, not to a log. The
// database stores addresses, which are public by nature.
//
// WHY DERIVATION RATHER THAN A KEY PER ROW. It reduces the number of things
// that must be backed up, guarded and rotated from N to one. A backup of
// hundreds of encrypted keys is a backup that can be partially lost; a seed
// cannot be partially lost. It also means creating an agent's wallet requires
// no write at all, so there is no window where a wallet exists on chain and not
// in the database, or the reverse.
//
// WHAT IT COSTS, stated plainly: the seed is a single point of total failure in
// both directions. Lose it and every wallet is unrecoverable, permanently, with
// no support path. Leak it and every wallet is drained. Both consequences are
// the reason the seed is the only thing in this system that gets its own Linux
// user, its own file mode, and a service that refuses to start when either is
// wrong. See docs/signer.md for the options that were weighed, including what a
// KMS would change and what it would cost.
//
// NOT BIP-32. ARCANA never needs to hand these keys to another wallet, so
// there is nothing to interoperate with, and BIP-32's extra machinery — chain
// codes, hardened paths, the public-derivation footgun — would be surface
// without a purpose. HKDF is the standard tool for "one secret, many keys".
package keys

import (
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"golang.org/x/crypto/hkdf"
	"golang.org/x/crypto/sha3"
)

// SeedMinBytes is the shortest master seed accepted. 32 bytes of real entropy;
// anything shorter is a passphrase somebody typed, and this is not the place
// for one.
const SeedMinBytes = 32

// Keyring derives per-agent signing keys from one master seed, and holds the
// small number of keys owners have imported instead.
type Keyring struct {
	seed []byte
	// Where owner-supplied keys live. Empty disables import entirely, which
	// is the correct state for a deployment that has not opted into it.
	importDir string
}

// LoadKeyring reads the master seed and REFUSES if the file is exposed.
//
// The permission check is not decoration. A seed at mode 0644 is readable by
// every process on the host including the six public-facing services, and the
// separation this whole component exists for would be a comment rather than a
// fact. Refusing to start is the only response that cannot be ignored.
//
// The seed is read from a FILE, not an environment variable, deliberately:
// environment is visible in /proc/<pid>/environ to anything running as the same
// user and is inherited by every child process. A file is read once.
func LoadKeyring(path string) (*Keyring, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("master seed: %w", err)
	}
	if mode := info.Mode().Perm(); mode&0o077 != 0 {
		return nil, fmt.Errorf(
			"master seed %s has mode %04o: it is readable or writable by group or others. "+
				"Set it to 0400 and own it by the signer user. Refusing to start rather than "+
				"hold keys behind a file anyone can read", path, mode)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("master seed: %w", err)
	}
	text := strings.TrimSpace(string(raw))
	// Accept hex or raw bytes; hex is what an operator will paste.
	seed, err := hex.DecodeString(strings.TrimPrefix(text, "0x"))
	if err != nil {
		seed = []byte(text)
	}
	if len(seed) < SeedMinBytes {
		return nil, fmt.Errorf(
			"master seed is %d bytes; at least %d are required. A short seed is a passphrase, "+
				"and a passphrase is not entropy", len(seed), SeedMinBytes)
	}
	return &Keyring{seed: seed}, nil
}

// WithImportDir enables owner-supplied keys, stored in dir.
//
// The directory must already exist with the right ownership: creating it here
// would mean an installer could bring key storage into being as a side effect,
// and this project has already decided that creating key material is a
// deliberate act rather than a consequence of running a script.
func (k *Keyring) WithImportDir(dir string) (*Keyring, error) {
	if dir == "" {
		return k, nil
	}
	info, err := os.Stat(dir)
	if err != nil {
		return nil, fmt.Errorf("import dir: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("import dir %s is not a directory", dir)
	}
	if mode := info.Mode().Perm(); mode&0o077 != 0 {
		return nil, fmt.Errorf(
			"import dir %s has mode %04o: group or others can enter it. "+
				"Set it to 0700 and own it by the signer user", dir, mode)
	}
	k.importDir = dir
	return k, nil
}

// NewKeyringFromSeed is for tests and for the verification rig.
func NewKeyringFromSeed(seed []byte) (*Keyring, error) {
	if len(seed) < SeedMinBytes {
		return nil, errors.New("seed too short")
	}
	return &Keyring{seed: append([]byte(nil), seed...)}, nil
}

// derive returns the agent's private key. Never exported, never returned to a
// caller, never logged: the only thing that leaves this package is a signature
// and an address.
func (k *Keyring) derive(agentID string) (*secp256k1.PrivateKey, error) {
	// The info parameter binds the key to this agent AND to this purpose, so a
	// future second use of the same seed cannot collide with a trading key.
	info := []byte("arcana/agent-wallet/v1/" + strings.ToLower(strings.TrimSpace(agentID)))
	r := hkdf.New(sha512.New, k.seed, nil, info)

	// secp256k1 keys must be in [1, n-1]. Rejection sampling; the probability
	// of even one rejection is about 2^-128, but "astronomically unlikely" is
	// not the same as "handled".
	for attempt := 0; attempt < 8; attempt++ {
		var buf [32]byte
		if _, err := io.ReadFull(r, buf[:]); err != nil {
			return nil, fmt.Errorf("derive key: %w", err)
		}
		var scalar secp256k1.ModNScalar
		if overflow := scalar.SetBytes(&buf); overflow == 0 && !scalar.IsZero() {
			return secp256k1.NewPrivateKey(&scalar), nil
		}
	}
	return nil, errors.New("derive key: exhausted rejection sampling")
}

// privateFor returns the key ARCANA signs with for this agent.
//
// IMPORTED WINS. If an owner supplied a key, that is the agent's wallet, and
// the derived one is not merely unused but WRONG — signing with it would
// produce a valid transaction from an address holding none of the funds, which
// fails on chain after the gas is spent and after the decision is recorded.
//
// Checked on every call rather than cached, so an import takes effect without
// a restart and a lost import surfaces immediately rather than at the next
// deploy.
func (k *Keyring) privateFor(agentID string) (*secp256k1.PrivateKey, error) {
	if k.HasImported(agentID) {
		return k.loadImported(agentID)
	}
	return k.derive(agentID)
}

// Address returns the agent's Ethereum address. Public information.
func (k *Keyring) Address(agentID string) (string, error) {
	priv, err := k.privateFor(agentID)
	if err != nil {
		return "", err
	}
	return AddressOf(priv), nil
}

// AddressOf computes the address for a key: keccak256 of the uncompressed
// public key without its 0x04 prefix, last 20 bytes.
func AddressOf(priv *secp256k1.PrivateKey) string {
	pub := priv.PubKey().SerializeUncompressed()[1:]
	h := sha3.NewLegacyKeccak256()
	h.Write(pub)
	sum := h.Sum(nil)
	return "0x" + hex.EncodeToString(sum[12:])
}

// SignHash signs a 32-byte hash and returns r, s and the recovery id.
//
// Ethereum requires the low-S form; a high-S signature is valid mathematically
// and rejected by consensus, so producing one would create a transaction that
// looks signed and cannot be mined.
func (k *Keyring) SignHash(agentID string, hash []byte) (r, s [32]byte, v byte, err error) {
	if len(hash) != 32 {
		return r, s, 0, fmt.Errorf("sign: hash must be 32 bytes, got %d", len(hash))
	}
	// privateFor, NOT derive. An agent with an imported key must be signed for
	// with that key: the derived one produces a perfectly valid transaction
	// from an address that holds none of the funds, which fails on chain after
	// the gas is spent and after the decision has been recorded as made.
	priv, err := k.privateFor(agentID)
	if err != nil {
		return r, s, 0, err
	}
	sig := ecdsa.SignCompact(priv, hash, false)
	// SignCompact layout: [recovery+27] [R 32] [S 32]
	if len(sig) != 65 {
		return r, s, 0, fmt.Errorf("sign: unexpected signature length %d", len(sig))
	}
	v = sig[0] - 27
	copy(r[:], sig[1:33])
	copy(s[:], sig[33:65])
	return r, s, v, nil
}

// Keccak256 is exported because transaction hashing needs it and there should
// be one implementation of it in this service.
func Keccak256(b ...[]byte) []byte {
	h := sha3.NewLegacyKeccak256()
	for _, x := range b {
		h.Write(x)
	}
	return h.Sum(nil)
}

// ---------------------------------------------------------------------------
// Imported keys.
//
// PHASE 12. A user may bring a wallet they already control instead of using
// the one ARCANA derives. This is a real product need — some people will not
// hand a platform sole control of an address — and it inverts one of the
// properties this package was built on.
//
// WHAT IT COSTS, stated plainly rather than discovered later:
//
//   1. Derived keys are a pure function of the seed. Imported keys are not,
//      so they must be STORED, and a store is a thing that can be lost. Losing
//      the seed loses every derived wallet; losing this directory loses every
//      imported one, and no re-derivation brings it back. The user still has
//      their own copy — that is the entire point of an imported key — but
//      ARCANA's ability to trade on their behalf is gone until they import
//      again.
//
//   2. ARCANA can sign ANYTHING with an imported key, not only trades. The
//      policy layer restricts what this service will build, and that is a real
//      restriction, but it is ARCANA's restriction on itself rather than a
//      property of the key. So an imported wallet must be one the user uses for
//      NOTHING ELSE, and the API says so in the response rather than burying it
//      in documentation.
//
// The files sit beside the master seed, under the same directory, with the
// same ownership and the same refusal to read anything group- or
// world-readable.
// ---------------------------------------------------------------------------

// ErrNoImportedKey is returned when an agent has no imported key. It is not a
// failure at the call site that asks "is this imported?" — only at one that
// assumed it was.
var ErrNoImportedKey = errors.New("no imported key for this agent")

// importedPath returns where an agent's imported key lives.
//
// The agent id is a UUID from the database, but it arrives here as a string
// from an HTTP path, so it is validated as a filename rather than trusted.
// Without this, an id of "../../etc/passwd" reads and writes wherever it likes.
func (k *Keyring) importedPath(agentID string) (string, error) {
	if k.importDir == "" {
		return "", errors.New("no import directory configured")
	}
	id := strings.ToLower(strings.TrimSpace(agentID))
	if id == "" {
		return "", errors.New("empty agent id")
	}
	for _, c := range id {
		isHex := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')
		if !isHex && c != '-' {
			return "", fmt.Errorf("agent id %q is not a uuid", agentID)
		}
	}
	return filepath.Join(k.importDir, id+".key"), nil
}

// HasImported reports whether this agent's key was supplied by its owner.
func (k *Keyring) HasImported(agentID string) bool {
	p, err := k.importedPath(agentID)
	if err != nil {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}

// loadImported reads an imported key, refusing an exposed file for the same
// reason LoadKeyring does.
func (k *Keyring) loadImported(agentID string) (*secp256k1.PrivateKey, error) {
	p, err := k.importedPath(agentID)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(p)
	if err != nil {
		return nil, ErrNoImportedKey
	}
	if mode := info.Mode().Perm(); mode&0o077 != 0 {
		return nil, fmt.Errorf(
			"imported key %s has mode %04o: readable or writable by group or others. "+
				"Refusing to use it", p, mode)
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		return nil, fmt.Errorf("imported key: %w", err)
	}
	return parsePrivateKey(string(raw))
}

// parsePrivateKey accepts a 32-byte secp256k1 key as hex, with or without 0x.
//
// Every rejection below is a key that would otherwise be accepted and then be
// unable to sign, or be able to sign for an address nobody expects.
func parsePrivateKey(text string) (*secp256k1.PrivateKey, error) {
	s := strings.TrimSpace(text)
	s = strings.TrimPrefix(strings.TrimPrefix(s, "0x"), "0X")
	if len(s) != 64 {
		return nil, fmt.Errorf(
			"private key must be 64 hex characters (32 bytes); got %d", len(s))
	}
	b, err := hex.DecodeString(s)
	if err != nil {
		return nil, errors.New("private key is not valid hex")
	}
	var buf [32]byte
	copy(buf[:], b)
	var scalar secp256k1.ModNScalar
	// Zero and >= n are both invalid secp256k1 scalars. A key that overflows
	// silently reduces mod n in some libraries, producing a DIFFERENT key that
	// signs for a DIFFERENT address than the one the user believes they gave.
	if overflow := scalar.SetBytes(&buf); overflow != 0 {
		return nil, errors.New("private key is not a valid secp256k1 scalar (>= curve order)")
	}
	if scalar.IsZero() {
		return nil, errors.New("private key is zero")
	}
	return secp256k1.NewPrivateKey(&scalar), nil
}

// Import stores an owner-supplied key and returns the address it controls.
//
// The address is DERIVED FROM THE KEY, never accepted from the caller. If the
// caller could state the address, a wallet row would say one thing and the
// signer would sign for another, and the divergence would only surface when
// money went somewhere unexpected.
//
// Refuses to overwrite. Replacing an agent's key silently would strand any
// funds at the previous address with nothing in the system pointing at it.
func (k *Keyring) Import(agentID, privHex string) (string, error) {
	p, err := k.importedPath(agentID)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(p); err == nil {
		return "", errors.New(
			"this agent already has an imported key; refusing to overwrite it. " +
				"Replacing it would strand whatever is held at the previous address")
	}
	priv, err := parsePrivateKey(privHex)
	if err != nil {
		return "", err
	}

	// 0600 and written by O_EXCL: exclusive creation is what makes "refuses to
	// overwrite" true under a race rather than only under sequential calls.
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", fmt.Errorf("store imported key: %w", err)
	}
	defer f.Close()
	if _, err := f.WriteString(hex.EncodeToString(priv.Serialize())); err != nil {
		return "", fmt.Errorf("store imported key: %w", err)
	}
	if err := f.Sync(); err != nil {
		return "", fmt.Errorf("store imported key: %w", err)
	}
	return AddressOf(priv), nil
}

// Export returns an agent's private key as hex.
//
// THE ONLY PLACE IN ARCANA THAT RETURNS KEY MATERIAL, and it exists because a
// custodial wallet the owner can never take possession of is not the owner's
// wallet. The alternative — no export — means a user's funds are hostage to
// the platform continuing to exist and continuing to cooperate.
//
// The caller is responsible for recording that this happened. Once a key has
// been handed over, ARCANA is no longer the only party who can spend from that
// address, and every later assumption about the balance has to account for it:
// see agent_wallets.key_custody and the custody_drift table.
//
// Not logged, not returned in an error, not retained. The value crosses the
// internal API once.
func (k *Keyring) Export(agentID string) (privHex, address string, err error) {
	priv, err := k.privateFor(agentID)
	if err != nil {
		return "", "", err
	}
	return hex.EncodeToString(priv.Serialize()), AddressOf(priv), nil
}
