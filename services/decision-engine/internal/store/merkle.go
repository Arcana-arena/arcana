package store

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

// AnchorScheme names the Merkle construction and the on-chain payload. See
// migration 0048 and docs/anchoring.md.
//
//	leaf  = sha256(0x00 || commitment)      commitment as its 32 raw bytes
//	node  = sha256(0x01 || left || right)
//	odd   = the last node of a level is carried up unchanged
//	order = decision id ascending
//
// DOMAIN SEPARATION is the 0x00/0x01 prefix. Without it, an interior node is
// 32 bytes like any leaf, and a proof could present a node as if it were a
// commitment. CARRYING the odd node rather than pairing it with itself is the
// other deliberate choice: duplicating the last leaf makes two different leaf
// lists share a root, which is a known way to forge a Merkle membership.
const AnchorScheme = "arcana-anchor/v1"

// LeafHash hashes one decision commitment (64 hex characters) into a leaf.
func LeafHash(commitment string) ([]byte, error) {
	b, err := hex.DecodeString(strings.TrimSpace(commitment))
	if err != nil || len(b) != 32 {
		return nil, fmt.Errorf("commitment %q is not 32 bytes of hex", commitment)
	}
	h := sha256.New()
	h.Write([]byte{0x00})
	h.Write(b)
	return h.Sum(nil), nil
}

func nodeHash(left, right []byte) []byte {
	h := sha256.New()
	h.Write([]byte{0x01})
	h.Write(left)
	h.Write(right)
	return h.Sum(nil)
}

// MerkleRoot returns the root over leaf hashes, in the order given. Nil for no
// leaves: there is no root of nothing, and anchoring one would prove nothing.
func MerkleRoot(leaves [][]byte) []byte {
	if len(leaves) == 0 {
		return nil
	}
	level := leaves
	for len(level) > 1 {
		level = nextLevel(level)
	}
	return level[0]
}

func nextLevel(level [][]byte) [][]byte {
	next := make([][]byte, 0, (len(level)+1)/2)
	for i := 0; i < len(level); i += 2 {
		if i+1 == len(level) {
			next = append(next, level[i])
			continue
		}
		next = append(next, nodeHash(level[i], level[i+1]))
	}
	return next
}

// ProofStep is one sibling on the path from a leaf to the root.
type ProofStep struct {
	Sibling       []byte
	SiblingOnLeft bool
}

// MerkleProof returns the path for leaves[index]. A level where the node is the
// carried odd one contributes no step.
func MerkleProof(leaves [][]byte, index int) ([]ProofStep, error) {
	if index < 0 || index >= len(leaves) {
		return nil, fmt.Errorf("leaf index %d outside %d leaves", index, len(leaves))
	}
	var proof []ProofStep
	level, i := leaves, index
	for len(level) > 1 {
		if i%2 == 1 {
			proof = append(proof, ProofStep{Sibling: level[i-1], SiblingOnLeft: true})
		} else if i+1 < len(level) {
			proof = append(proof, ProofStep{Sibling: level[i+1], SiblingOnLeft: false})
		}
		level = nextLevel(level)
		i /= 2
	}
	return proof, nil
}

// VerifyProof walks a proof from a leaf and reports whether it reaches root.
func VerifyProof(leaf []byte, proof []ProofStep, root []byte) bool {
	cur := leaf
	for _, s := range proof {
		if s.SiblingOnLeft {
			cur = nodeHash(s.Sibling, cur)
		} else {
			cur = nodeHash(cur, s.Sibling)
		}
	}
	return bytes.Equal(cur, root)
}
