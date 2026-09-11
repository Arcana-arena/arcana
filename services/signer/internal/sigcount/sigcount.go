// Package sigcount is the signer's own durable record of what it has signed.
//
// WHY THE SIGNER KEEPS ITS OWN COUNT, rather than reading the executions table
// the decision engine writes.
//
// executions records what the ENGINE did. It is not a record of what the signer
// SIGNED, and the difference is not theoretical: at the time this was written
// the signer had issued seven signatures and executions held five rows. The two
// missing ones were a real approve and a real swap from phase 8, signed here and
// broadcast by hand with no engine in the middle. Their gas was spent and the
// daily cap would never have seen them.
//
// A brake that counts from a downstream service's record is blind to exactly the
// paths that bypass that service — which are the paths somebody wanting to get
// around the brake would use. There are two smaller versions of the same
// problem: an executions row is written AFTER the receipt, so anything in flight
// is uncounted, and a failed write (already a logged, tolerated outcome) loses
// the signature from the count forever.
//
// So the signer counts what the signer did.
//
// WHY A FILE AND NOT A TABLE. The alternative was a database connection with a
// least-privilege role. That means a credential in the environment of the one
// process that holds the master seed, and network access from it to Postgres.
// This service currently has the seed and the allowlist and nothing else:
// ProtectHome=yes, ProtectSystem=strict, the allowlist read-only so that "a
// compromised signer still cannot rewrite the allowlist to admit a router of its
// choosing". Widening the privileges of the key-holding process in order to
// install its own brake is a trade in the wrong direction.
//
// The cost is that operators cannot query it with SQL, which is answered by an
// internal read endpoint rather than by a credential.
//
// ABSENT IS NOT CORRUPT. A missing file is a fresh install and starts at zero.
// A file that exists and cannot be parsed makes the signer REFUSE, because a
// brake that cannot be read is not a brake that is empty — the same rule the
// blocklist check follows for an unreadable isBlocked().
package sigcount

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// state is the on-disk shape. Deliberately small and boring: a day, and a count
// per agent. Nothing here is secret — agent ids are uuids the platform prints
// in its own API responses — so the file's mode is about integrity, not privacy.
type state struct {
	Day    string         `json:"day"`
	Counts map[string]int `json:"counts"`
	// Written so a person reading the file knows what produced it.
	Note string `json:"note"`
}

// Store is a durable per-agent, per-UTC-day signature count.
type Store struct {
	mu   sync.Mutex
	path string
	st   state
}

// ErrUnreadable means the count exists and could not be understood. The caller
// must refuse to sign; assuming zero would silently reset the cap.
var ErrUnreadable = fmt.Errorf("signature count could not be read")

// Open loads the count, creating nothing yet.
//
// A missing file returns a usable empty Store and no error: that is a first
// boot, and refusing it would mean a fresh install cannot sign at all. Anything
// else — unreadable, unparseable, wrong shape — is an error, and the server
// turns that into a refusal to sign rather than a refusal to start, so /healthz
// still answers and says what is wrong.
func Open(path string) (*Store, error) {
	s := &Store{path: path, st: state{Day: today(), Counts: map[string]int{}}}
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreadable, err)
	}
	var loaded state
	if err := json.Unmarshal(raw, &loaded); err != nil {
		return nil, fmt.Errorf("%w: %s is not valid JSON: %v", ErrUnreadable, path, err)
	}
	if loaded.Counts == nil {
		return nil, fmt.Errorf("%w: %s has no counts object", ErrUnreadable, path)
	}
	if loaded.Day != today() {
		// A new UTC day. The old counts are dropped rather than kept, because
		// the cap is per day and yesterday's total has no claim on today.
		loaded = state{Day: today(), Counts: map[string]int{}}
	}
	s.st = loaded
	return s, nil
}

// Count is how many signatures this agent has been issued today.
func (s *Store) Count(agentID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rollLocked()
	return s.st.Counts[agentID]
}

// Record adds one and persists before returning.
//
// PERSISTED BEFORE THE SIGNATURE IS RETURNED, not after. A crash between
// counting and signing loses a signature the agent never got, which costs it
// one of its daily allowance and nothing else. The other order loses a
// signature that WAS issued, which is the cap quietly refunding itself — and
// that is the failure this whole package exists to remove.
func (s *Store) Record(agentID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rollLocked()
	s.st.Counts[agentID]++
	if err := s.persistLocked(); err != nil {
		// Undo, so the in-memory count never claims something the disk does not.
		s.st.Counts[agentID]--
		return err
	}
	return nil
}

// All returns today's counts, for the internal read endpoint.
func (s *Store) All() (string, map[string]int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rollLocked()
	out := make(map[string]int, len(s.st.Counts))
	for k, v := range s.st.Counts {
		out[k] = v
	}
	return s.st.Day, out
}

func (s *Store) rollLocked() {
	if s.st.Day != today() {
		s.st = state{Day: today(), Counts: map[string]int{}}
	}
}

// persistLocked writes atomically: a temp file in the same directory, fsynced,
// then renamed over the target, then the directory fsynced.
//
// A truncated write would be an UNPARSEABLE file, which makes the signer refuse
// to sign until somebody looks at it. That is the safe direction, but a brake
// that jams under a power cut is still an outage, so the write is done in the
// way that cannot half-happen.
func (s *Store) persistLocked() error {
	s.st.Note = "ARCANA signer daily signature counts. Written by the signer, read by nobody else. " +
		"Delete this file only to reset the per-agent daily cap deliberately."
	raw, err := json.MarshalIndent(s.st, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.path)
	tmp, err := os.CreateTemp(dir, ".signatures-*.tmp")
	if err != nil {
		return fmt.Errorf("signature count: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return fmt.Errorf("signature count: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("signature count: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("signature count: %w", err)
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return fmt.Errorf("signature count: %w", err)
	}
	if err := os.Rename(tmpName, s.path); err != nil {
		return fmt.Errorf("signature count: %w", err)
	}
	// Rename is atomic but not durable until the directory entry is synced.
	d, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("signature count: %w", err)
	}
	defer d.Close()
	if err := d.Sync(); err != nil {
		return fmt.Errorf("signature count: %w", err)
	}
	return nil
}

func today() string { return time.Now().UTC().Format("2006-01-02") }
