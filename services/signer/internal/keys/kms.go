package keys

import (
	"context"
	"fmt"
	"os"
)

// Opener unseals the master seed. The one implementation today is AWS KMS
// (awskms.go); the interface exists so the loader below is testable without a
// cloud account, and so a second provider is a file, not a refactor.
type Opener interface {
	// Open decrypts the sealed blob and returns the seed material. It must
	// never log, retain or write the plaintext it returns.
	Open(ctx context.Context, ciphertext []byte) ([]byte, error)
}

// LoadKeyringSealed reads a KMS-sealed master seed and unseals it into memory.
//
// OPTION B, SHAPE 2. See vault.go: the seed is SEALED (encrypted by a KMS the
// operator controls) rather than the key being generated inside the module,
// because the product promise that an owner can export their agent's key needs
// the derived keys to exist. What this removes is exactly the threat option A
// carries: a plaintext seed on disk, in a disk image, or inside a backup
// archive. What replaces it is a decrypt call that is logged and revocable.
//
// THE PLAINTEXT NEVER TOUCHES DISK. It exists in the returned keyring's memory
// for the life of the process and is written nowhere — no temp file, no log
// line, no core dump (LimitCORE=0 in the unit).
//
// The same file-mode rule as the plaintext seed is kept, uniformly and on
// purpose: it is not the ciphertext that is secret but what it decrypts to,
// and an operator should never have to reason about which mode matters for
// which file. The blob is written by the sealing tooling (see docs/signer.md),
// never by this service.
func LoadKeyringSealed(ctx context.Context, path string, opener Opener) (*Keyring, error) {
	if opener == nil {
		return nil, fmt.Errorf("sealed seed %s: no unsealer configured", path)
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("sealed seed: %w", err)
	}
	if mode := info.Mode().Perm(); mode&0o077 != 0 {
		return nil, fmt.Errorf(
			"sealed seed %s has mode %04o: it is readable or writable by group or others. "+
				"Set it to 0400 and own it by the signer user. Refusing to start rather than "+
				"decrypt a blob anyone can replace", path, mode)
	}
	blob, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("sealed seed: %w", err)
	}
	if len(blob) == 0 {
		return nil, fmt.Errorf("sealed seed %s is empty", path)
	}

	plain, err := opener.Open(ctx, blob)
	if err != nil {
		// The error names the unsealer, never the ciphertext or the plaintext.
		return nil, fmt.Errorf("sealed seed %s: unseal: %w", path, err)
	}
	seed, err := seedFromBytes(plain)
	if err != nil {
		return nil, fmt.Errorf("sealed seed %s: %w", path, err)
	}
	return &Keyring{seed: seed, source: "KMS-sealed master seed (option B)"}, nil
}
