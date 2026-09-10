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

// Keyring derives per-agent signing keys from one master seed.
type Keyring struct {
	seed []byte
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

// Address returns the agent's Ethereum address. Public information.
func (k *Keyring) Address(agentID string) (string, error) {
	priv, err := k.derive(agentID)
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
	priv, err := k.derive(agentID)
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
