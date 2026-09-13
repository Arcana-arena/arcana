package store

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"testing"
)

func commitmentN(n int) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("commitment-%d", n)))
	return hex.EncodeToString(sum[:])
}

func leavesN(t *testing.T, n int) [][]byte {
	t.Helper()
	out := make([][]byte, n)
	for i := range out {
		h, err := LeafHash(commitmentN(i))
		if err != nil {
			t.Fatal(err)
		}
		out[i] = h
	}
	return out
}

func TestLeafIsDomainSeparated(t *testing.T) {
	c := commitmentN(1)
	raw, _ := hex.DecodeString(c)
	plain := sha256.Sum256(raw)
	leaf, _ := LeafHash(c)
	if bytes.Equal(leaf, plain[:]) {
		t.Fatal("a leaf equals sha256(commitment); without the 0x00 prefix a node could pose as a leaf")
	}
}

func TestSingleLeafRootIsTheLeaf(t *testing.T) {
	l := leavesN(t, 1)
	if !bytes.Equal(MerkleRoot(l), l[0]) {
		t.Fatal("the root of one leaf is not that leaf")
	}
}

func TestOddNodeIsCarriedNotDuplicated(t *testing.T) {
	three := leavesN(t, 3)
	// Duplicating the last leaf would make [a,b,c] and [a,b,c,c] share a root.
	four := append(append([][]byte{}, three...), three[2])
	if bytes.Equal(MerkleRoot(three), MerkleRoot(four)) {
		t.Fatal("[a,b,c] and [a,b,c,c] share a root: the odd leaf is being duplicated")
	}
	want := nodeHash(nodeHash(three[0], three[1]), three[2])
	if !bytes.Equal(MerkleRoot(three), want) {
		t.Fatal("three leaves did not carry the odd one up")
	}
}

func TestEveryProofReachesTheRoot(t *testing.T) {
	for n := 1; n <= 33; n++ {
		l := leavesN(t, n)
		root := MerkleRoot(l)
		for i := 0; i < n; i++ {
			p, err := MerkleProof(l, i)
			if err != nil {
				t.Fatal(err)
			}
			if !VerifyProof(l[i], p, root) {
				t.Fatalf("n=%d leaf %d: proof does not reach the root", n, i)
			}
			if n > 1 && VerifyProof(l[(i+1)%n], p, root) {
				t.Fatalf("n=%d leaf %d: the proof also accepts a different leaf", n, i)
			}
		}
	}
}

func TestChangingAnyLeafOrTheOrderChangesTheRoot(t *testing.T) {
	l := leavesN(t, 7)
	root := MerkleRoot(l)
	for i := range l {
		m := append([][]byte{}, l...)
		other, _ := LeafHash(commitmentN(100 + i))
		m[i] = other
		if bytes.Equal(MerkleRoot(m), root) {
			t.Fatalf("replacing leaf %d kept the root", i)
		}
	}
	swapped := append([][]byte{}, l...)
	swapped[0], swapped[1] = swapped[1], swapped[0]
	if bytes.Equal(MerkleRoot(swapped), root) {
		t.Fatal("swapping two leaves kept the root; order is part of what is anchored")
	}
}

func TestLeafRefusesNonCommitments(t *testing.T) {
	for _, bad := range []string{"", "abc", commitmentN(1)[:62], "zz" + commitmentN(1)[2:]} {
		if _, err := LeafHash(bad); err == nil {
			t.Fatalf("LeafHash accepted %q", bad)
		}
	}
}
