package keys

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// AWSKMSConfig is everything the KMS opener needs, all REQUIRED.
//
// Nothing here has a fallback that could silently point somewhere else: a key
// id, a region and credentials are all named by the deployment, and a config
// missing any of them refuses to build rather than reaching for ambient
// environment, shared credentials files or instance metadata. For a
// key-decryption path, "it found credentials somewhere" is exactly the
// property an attacker benefits from.
type AWSKMSConfig struct {
	Region          string
	KeyID           string
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string // optional: temporary credentials
	// Endpoint overrides the KMS address. Empty means the real one for the
	// region. It exists so tests can point this at a local server; nothing in
	// the deployment sets it.
	Endpoint string
}

// AWSKMS unseals a seed with one AWS KMS Decrypt call.
//
// EXACTLY ONE KMS API IS IMPLEMENTED. Sealing (Encrypt) belongs to the
// operator's tooling — `aws kms encrypt` in the runbook — so the key-holding
// process has one method to audit instead of an SDK: no key generation, no
// grants, no data-key caching, no credential-provider chain, no ambient
// discovery. The request it can make is fixed.
type AWSKMS struct {
	cfg      AWSKMSConfig
	endpoint string
	client   *http.Client
	now      func() time.Time // test seam
}

func NewAWSKMS(cfg AWSKMSConfig) (*AWSKMS, error) {
	missing := []string{}
	if strings.TrimSpace(cfg.Region) == "" {
		missing = append(missing, "region (SIGNER_KMS_REGION or AWS_REGION)")
	}
	if strings.TrimSpace(cfg.KeyID) == "" {
		missing = append(missing, "key id (SIGNER_KMS_KEY_ID)")
	}
	if strings.TrimSpace(cfg.AccessKeyID) == "" {
		missing = append(missing, "access key id (SIGNER_KMS_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID)")
	}
	if strings.TrimSpace(cfg.SecretAccessKey) == "" {
		missing = append(missing, "secret access key (SIGNER_KMS_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY)")
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("AWS KMS: %s not set; refusing to guess", strings.Join(missing, ", "))
	}
	endpoint := strings.TrimSpace(cfg.Endpoint)
	if endpoint == "" {
		endpoint = "https://kms." + cfg.Region + ".amazonaws.com/"
	}
	if _, err := url.Parse(endpoint); err != nil {
		return nil, fmt.Errorf("AWS KMS: endpoint %q: %w", endpoint, err)
	}
	return &AWSKMS{
		cfg:      cfg,
		endpoint: endpoint,
		client:   &http.Client{Timeout: 15 * time.Second},
		now:      time.Now,
	}, nil
}

// Describe names the backing store for the boot log. Never the secret.
func (k *AWSKMS) Describe() string {
	return fmt.Sprintf("aws kms (key %s, region %s)", k.cfg.KeyID, k.cfg.Region)
}

// Open sends one Decrypt call and returns the plaintext.
//
// On any failure — unreachable, refused, malformed — the error names the
// service's message and NOTHING of the request's secret material: a failure
// path that echoes what it was carrying is how secrets reach logs.
func (k *AWSKMS) Open(ctx context.Context, ciphertext []byte) ([]byte, error) {
	body, err := json.Marshal(map[string]string{
		"CiphertextBlob": base64.StdEncoding.EncodeToString(ciphertext),
		"KeyId":          k.cfg.KeyID,
	})
	if err != nil {
		return nil, err
	}
	u, err := url.Parse(k.endpoint)
	if err != nil {
		return nil, err
	}
	uri := u.Path
	if uri == "" {
		uri = "/"
	}
	sum := sha256.Sum256(body)
	signed := sigv4(awsCredentials{
		accessKey:    k.cfg.AccessKeyID,
		secretKey:    k.cfg.SecretAccessKey,
		sessionToken: k.cfg.SessionToken,
		region:       k.cfg.Region,
		service:      "kms",
	}, http.MethodPost, uri, u.RawQuery, map[string]string{
		"host":         u.Host,
		"content-type": "application/x-amz-json-1.1",
		"x-amz-target": "TrentService.Decrypt",
	}, hex.EncodeToString(sum[:]), k.now())

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, k.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-amz-json-1.1")
	req.Header.Set("X-Amz-Target", "TrentService.Decrypt")
	req.Header.Set("X-Amz-Date", signed["x-amz-date"])
	req.Header.Set("Authorization", signed["authorization"])
	if tok, ok := signed["x-amz-security-token"]; ok {
		req.Header.Set("X-Amz-Security-Token", tok)
	}

	res, err := k.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("aws kms decrypt: %w", err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("aws kms decrypt: read response: %w", err)
	}
	if res.StatusCode != http.StatusOK {
		var svcErr struct {
			Type    string `json:"__type"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &svcErr)
		if svcErr.Type == "" {
			svcErr.Type = fmt.Sprintf("HTTP %d", res.StatusCode)
		}
		return nil, fmt.Errorf("aws kms decrypt refused: %s: %s", svcErr.Type, svcErr.Message)
	}
	var out struct {
		Plaintext string `json:"Plaintext"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("aws kms decrypt: malformed response: %w", err)
	}
	plain, err := base64.StdEncoding.DecodeString(out.Plaintext)
	if err != nil {
		return nil, fmt.Errorf("aws kms decrypt: plaintext is not base64: %w", err)
	}
	if len(plain) == 0 {
		return nil, errors.New("aws kms decrypt returned empty plaintext")
	}
	return plain, nil
}

// awsCredentials is what SigV4 signs with.
type awsCredentials struct {
	accessKey    string
	secretKey    string
	sessionToken string
	region       string
	service      string
}

// sigv4 signs one request and returns the headers that carry the signature:
// x-amz-date and authorization, plus x-amz-security-token for temporary
// credentials.
//
// IMPLEMENTED FROM THE PUBLISHED ALGORITHM, NOT AN SDK, on purpose. The signer
// holds the only key material in ARCANA, and its dependency surface is part of
// its argument — vault.go makes the same point about the Keyring. The algorithm
// is HMAC-SHA256 over a canonical string, and the tests assert this
// implementation against AWS's OWN published test vectors
// (aws-sig-v4-test-suite: get-vanilla and post-x-www-form-urlencoded), so its
// correctness is checked by the vendor's numbers rather than by this code
// agreeing with itself.
//
// headers must use lowercase names and must not include x-amz-date or the
// authorization header: this function adds x-amz-date itself and signs the
// whole set.
func sigv4(c awsCredentials, method, canonicalURI, query string, headers map[string]string, payloadHash string, now time.Time) map[string]string {
	amzDate := now.UTC().Format("20060102T150405Z")
	date := now.UTC().Format("20060102")

	all := make(map[string]string, len(headers)+2)
	for k, v := range headers {
		all[k] = v
	}
	all["x-amz-date"] = amzDate
	if c.sessionToken != "" {
		all["x-amz-security-token"] = c.sessionToken
	}

	names := make([]string, 0, len(all))
	for k := range all {
		names = append(names, k)
	}
	sort.Strings(names)
	var canonicalHeaders strings.Builder
	for _, n := range names {
		canonicalHeaders.WriteString(n + ":" + strings.TrimSpace(all[n]) + "\n")
	}
	signedHeaders := strings.Join(names, ";")

	canonicalRequest := strings.Join([]string{
		method, canonicalURI, query, canonicalHeaders.String(), signedHeaders, payloadHash,
	}, "\n")
	reqSum := sha256.Sum256([]byte(canonicalRequest))
	scope := date + "/" + c.region + "/" + c.service + "/aws4_request"
	stringToSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + hex.EncodeToString(reqSum[:])
	signature := hex.EncodeToString(hmacSHA256(signingKey(c, date), []byte(stringToSign)))

	out := map[string]string{
		"x-amz-date":    amzDate,
		"authorization": "AWS4-HMAC-SHA256 Credential=" + c.accessKey + "/" + scope + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature,
	}
	if c.sessionToken != "" {
		out["x-amz-security-token"] = c.sessionToken
	}
	return out
}

// signingKey derives the request signing key: date → region → service →
// "aws4_request", each step HMAC-SHA256 with the previous result as the key.
func signingKey(c awsCredentials, date string) []byte {
	k := hmacSHA256([]byte("AWS4"+c.secretKey), []byte(date))
	k = hmacSHA256(k, []byte(c.region))
	k = hmacSHA256(k, []byte(c.service))
	return hmacSHA256(k, []byte("aws4_request"))
}

func hmacSHA256(key, data []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(data)
	return m.Sum(nil)
}
