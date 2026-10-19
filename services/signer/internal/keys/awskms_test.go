package keys

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// --- SigV4 against AWS's own vectors ----------------------------------------
//
// aws-sig-v4-test-suite, the fixed credentials and time every case uses. If
// this implementation ever "agrees with itself" but not with the vendor, these
// fail — which is the point of anchoring on published numbers.

func suiteCreds() (awsCredentials, time.Time) {
	return awsCredentials{
		accessKey: "AKIDEXAMPLE",
		secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
		region:    "us-east-1",
		service:   "service",
	}, time.Date(2015, 8, 30, 12, 36, 0, 0, time.UTC)
}

func hashHex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func TestSigV4GetVanillaVector(t *testing.T) {
	creds, now := suiteCreds()
	h := sigv4(creds, "GET", "/", "",
		map[string]string{"host": "example.amazonaws.com"}, hashHex(nil), now)

	const wantAuth = "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
		"SignedHeaders=host;x-amz-date, " +
		"Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
	if h["authorization"] != wantAuth {
		t.Fatalf("authorization mismatch:\n got %s\nwant %s", h["authorization"], wantAuth)
	}
	if h["x-amz-date"] != "20150830T123600Z" {
		t.Fatalf("x-amz-date: got %s", h["x-amz-date"])
	}
}

func TestSigV4PostFormUrlencodedVector(t *testing.T) {
	creds, now := suiteCreds()
	h := sigv4(creds, "POST", "/", "", map[string]string{
		"content-type": "application/x-www-form-urlencoded",
		"host":         "example.amazonaws.com",
	}, hashHex([]byte("Param1=value1")), now)

	const wantAuth = "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
		"SignedHeaders=content-type;host;x-amz-date, " +
		"Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a"
	if h["authorization"] != wantAuth {
		t.Fatalf("authorization mismatch:\n got %s\nwant %s", h["authorization"], wantAuth)
	}
}

func TestSigV4SignsSessionToken(t *testing.T) {
	creds, now := suiteCreds()
	creds.sessionToken = "SESSIONTOKEN"
	h := sigv4(creds, "GET", "/", "",
		map[string]string{"host": "example.amazonaws.com"}, hashHex(nil), now)
	if h["x-amz-security-token"] != "SESSIONTOKEN" {
		t.Fatalf("session token not returned: %v", h)
	}
	if !strings.Contains(h["authorization"], "host;x-amz-date;x-amz-security-token") {
		t.Fatalf("session token must be in SignedHeaders: %s", h["authorization"])
	}
}

// --- the sealed loader -------------------------------------------------------

type fakeOpener struct {
	plain []byte
	err   error
	got   []byte
}

func (f *fakeOpener) Open(_ context.Context, ciphertext []byte) ([]byte, error) {
	f.got = ciphertext
	if f.err != nil {
		return nil, f.err
	}
	return f.plain, nil
}

func writeBlob(t *testing.T, mode os.FileMode, content []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "master.key.kms")
	if err := os.WriteFile(p, content, mode); err != nil {
		t.Fatal(err)
	}
	// WriteFile applies umask; chmod explicitly so the mode is what we say.
	if err := os.Chmod(p, mode); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoadKeyringSealedReproducesTheSameWallets(t *testing.T) {
	seed := make([]byte, 40)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	// What `aws kms encrypt` of the hex seed file produces in plaintext: the
	// hex text, not raw bytes.
	opener := &fakeOpener{plain: []byte(hex.EncodeToString(seed))}
	path := writeBlob(t, 0o400, []byte("ciphertext-blob"))

	sealed, err := LoadKeyringSealed(context.Background(), path, opener)
	if err != nil {
		t.Fatalf("LoadKeyringSealed: %v", err)
	}
	plain, err := NewKeyringFromSeed(seed)
	if err != nil {
		t.Fatal(err)
	}
	a1, err := sealed.Address("agent-7")
	if err != nil {
		t.Fatal(err)
	}
	a2, err := plain.Address("agent-7")
	if err != nil {
		t.Fatal(err)
	}
	if a1 != a2 {
		t.Fatalf("sealed seed must derive the same wallet: %s vs %s", a1, a2)
	}
	if !strings.Contains(sealed.Describe(), "KMS-sealed") {
		t.Fatalf("Describe must name the custody: %s", sealed.Describe())
	}
	if string(opener.got) != "ciphertext-blob" {
		t.Fatalf("opener got %q", opener.got)
	}
}

func TestLoadKeyringSealedRefusesExposedBlob(t *testing.T) {
	opener := &fakeOpener{plain: []byte(hex.EncodeToString(make([]byte, 40)))}
	path := writeBlob(t, 0o644, []byte("blob"))
	if _, err := LoadKeyringSealed(context.Background(), path, opener); err == nil {
		t.Fatal("a group/world-readable blob must be refused")
	}
}

func TestLoadKeyringSealedRefusesShortPlaintext(t *testing.T) {
	opener := &fakeOpener{plain: []byte("short")}
	path := writeBlob(t, 0o400, []byte("blob"))
	_, err := LoadKeyringSealed(context.Background(), path, opener)
	if err == nil || !strings.Contains(err.Error(), "at least") {
		t.Fatalf("short plaintext must be refused: %v", err)
	}
}

func TestLoadKeyringSealedPropagatesUnsealError(t *testing.T) {
	opener := &fakeOpener{err: errors.New("access denied")}
	path := writeBlob(t, 0o400, []byte("blob"))
	_, err := LoadKeyringSealed(context.Background(), path, opener)
	if err == nil || !strings.Contains(err.Error(), "access denied") {
		t.Fatalf("unseal error must surface: %v", err)
	}
}

func TestLoadKeyringSealedRefusesWithoutOpener(t *testing.T) {
	path := writeBlob(t, 0o400, []byte("blob"))
	if _, err := LoadKeyringSealed(context.Background(), path, nil); err == nil {
		t.Fatal("no opener must be refused")
	}
}

// --- the AWS KMS client ------------------------------------------------------

func TestNewAWSKMSRefusesIncompleteConfig(t *testing.T) {
	full := AWSKMSConfig{Region: "us-east-1", KeyID: "key/abc", AccessKeyID: "AKID", SecretAccessKey: "secret"}
	if _, err := NewAWSKMS(full); err != nil {
		t.Fatalf("complete config must build: %v", err)
	}
	cases := map[string]AWSKMSConfig{
		"region":  {KeyID: "key/abc", AccessKeyID: "AKID", SecretAccessKey: "secret"},
		"key id":  {Region: "us-east-1", AccessKeyID: "AKID", SecretAccessKey: "secret"},
		"access":  {Region: "us-east-1", KeyID: "key/abc", SecretAccessKey: "secret"},
		"secret":  {Region: "us-east-1", KeyID: "key/abc", AccessKeyID: "AKID"},
		"nothing": {},
	}
	for name, cfg := range cases {
		if _, err := NewAWSKMS(cfg); err == nil {
			t.Fatalf("%s: incomplete config must be refused", name)
		}
	}
}

func TestAWSKMSOpenAgainstLocalEndpoint(t *testing.T) {
	seed := []byte(hex.EncodeToString(make([]byte, 40)))
	const keyID = "arn:aws:kms:us-east-1:111122223333:key/abc"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method: got %s", r.Method)
		}
		if got := r.Header.Get("X-Amz-Target"); got != "TrentService.Decrypt" {
			t.Errorf("x-amz-target: got %q", got)
		}
		if got := r.Header.Get("Content-Type"); got != "application/x-amz-json-1.1" {
			t.Errorf("content-type: got %q", got)
		}
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/") {
			t.Errorf("authorization: got %q", auth)
		}
		if !strings.Contains(auth, "SignedHeaders=content-type;host;x-amz-date;x-amz-target") {
			t.Errorf("signed headers: got %q", auth)
		}
		var body struct {
			CiphertextBlob string `json:"CiphertextBlob"`
			KeyID          string `json:"KeyId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		if body.CiphertextBlob != base64.StdEncoding.EncodeToString([]byte("sealed-blob")) {
			t.Errorf("ciphertext: got %q", body.CiphertextBlob)
		}
		if body.KeyID != keyID {
			t.Errorf("key id: got %q", body.KeyID)
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"Plaintext": base64.StdEncoding.EncodeToString(seed),
		})
	}))
	defer srv.Close()

	kms, err := NewAWSKMS(AWSKMSConfig{
		Region:          "us-east-1",
		KeyID:           keyID,
		AccessKeyID:     "AKIDEXAMPLE",
		SecretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
		Endpoint:        srv.URL,
	})
	if err != nil {
		t.Fatal(err)
	}
	out, err := kms.Open(context.Background(), []byte("sealed-blob"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if string(out) != string(seed) {
		t.Fatalf("plaintext mismatch: %q", out)
	}
}

func TestAWSKMSOpenMapsServiceErrorWithoutEchoingTheBlob(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"__type":  "AccessDeniedException",
			"message": "User is not authorized",
		})
	}))
	defer srv.Close()

	kms, err := NewAWSKMS(AWSKMSConfig{
		Region: "us-east-1", KeyID: "key/abc",
		AccessKeyID: "AKID", SecretAccessKey: "secret", Endpoint: srv.URL,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = kms.Open(context.Background(), []byte("very-secret-ciphertext"))
	if err == nil {
		t.Fatal("a refused decrypt must error")
	}
	if !strings.Contains(err.Error(), "AccessDeniedException") || !strings.Contains(err.Error(), "not authorized") {
		t.Fatalf("service error must surface: %v", err)
	}
	if strings.Contains(err.Error(), "very-secret-ciphertext") {
		t.Fatalf("the error must not echo the ciphertext: %v", err)
	}
}

func TestAWSKMSOpenRefusesEmptyPlaintext(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"Plaintext": ""})
	}))
	defer srv.Close()

	kms, err := NewAWSKMS(AWSKMSConfig{
		Region: "us-east-1", KeyID: "key/abc",
		AccessKeyID: "AKID", SecretAccessKey: "secret", Endpoint: srv.URL,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := kms.Open(context.Background(), []byte("blob")); err == nil {
		t.Fatal("empty plaintext must be refused")
	}
}
