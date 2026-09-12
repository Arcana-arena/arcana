package keys

import "errors"

// Vault is everything the signer needs from whatever holds its keys.
//
// # WHY THIS EXISTS BEFORE THERE IS A SECOND IMPLEMENTATION
//
// Key custody is option A today: one master seed in a file on the host, owned
// by a Linux user nothing else runs as. That was a deliberate decision for a
// phase with no money in it, taken with the cost stated openly, and moving to
// a KMS is a precondition before the first wallet is funded.
//
// The point of naming the interface now is that the swap should be one
// implementation and one line at boot, decided when there is money at stake
// rather than discovered then. `*Keyring` satisfies it; the whole server talks
// to this and to nothing narrower.
//
// # THE TRADE-OFF A KMS FORCES, AND IT IS NOT SMALL
//
// There are two shapes of KMS and they are not interchangeable:
//
//  1. KMS AS A SIGNING SERVICE. The private key is generated inside the KMS
//     and never leaves it; you send a digest and get a signature back. This
//     is the strongest custody available and it makes Export() IMPOSSIBLE —
//     not hard, impossible, because there is nothing to export.
//
//     Phase 12 promises every user that they can take possession of their
//     agent's key at any time, on the grounds that a wallet whose owner can
//     never hold the key is the platform's wallet with the owner's name on
//     it. This shape breaks that promise.
//
//  2. KMS AS AN ENCRYPTED SECRET STORE. The master seed is sealed with a KMS
//     key and unsealed into memory at boot. Derived keys still exist, so
//     Export() still works and the user's promise holds. What is gained is
//     that no plaintext seed sits on disk, no plaintext seed can be read from
//     a stolen backup archive, and access is logged and revocable.
//
// **Shape 2 is the recommendation**, and the reason is that shape 1 buys
// custody the platform is not entitled to: the user's key is the user's. The
// threat option A actually carries is a plaintext file on a host, and shape 2
// removes exactly that.
//
// Whichever is chosen, Export must be allowed to REFUSE rather than being
// absent from the interface. An implementation that cannot export says so, at
// the call, to a caller that can tell the user — instead of the interface
// quietly not offering something the product promised.
type Vault interface {
	// Address returns the agent's public address. Never fails for a reason
	// worth hiding: an address is public by nature.
	Address(agentID string) (string, error)

	// SignHash signs a 32-byte digest. The only operation that must work in
	// every implementation; everything else may refuse.
	SignHash(agentID string, hash []byte) (r, s [32]byte, v byte, err error)

	// Export hands the private key to its owner, or returns ErrExportUnsupported.
	Export(agentID string) (privHex, address string, err error)

	// Import adopts a key the owner already controls, or returns
	// ErrImportUnsupported.
	Import(agentID, privHex string) (address string, err error)

	// Describe names the backing store for the boot log, so an operator can
	// see which custody is in force without reading the configuration.
	Describe() string
}

// ErrExportUnsupported is returned by a vault that physically cannot produce a
// private key — a KMS used as a signing service, where the key was generated
// inside the module and never existed anywhere else.
//
// A distinct error rather than a generic failure, because the caller has to
// tell the user something true: not "export failed, try again", but "this
// platform cannot hand you this key, and here is what that means".
var ErrExportUnsupported = errors.New(
	"this key custody cannot export private keys: the key was generated inside the " +
		"hardware module and has never existed outside it")

// ErrImportUnsupported is its counterpart.
var ErrImportUnsupported = errors.New(
	"this key custody cannot accept an imported private key")

// Describe reports what is holding the keys.
func (k *Keyring) Describe() string {
	if k.importDir != "" {
		return "file-backed master seed (option A), owner-imported keys enabled"
	}
	return "file-backed master seed (option A), derived keys only"
}

// Compile-time proof that the file-backed keyring satisfies the interface.
// Without this the mismatch would surface only when a second implementation
// arrived, which is the moment it is least convenient to find.
var _ Vault = (*Keyring)(nil)
