package store

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The gate the DB-backed tests in this package pass through.
//
// WHY THIS FILE EXISTS. `go test ./...` printed this:
//
//	ok  	github.com/arcana/decision-engine/internal/store	0.002s
//
// Forty-four tests had passed and six had not run. The six were the ones that
// matter most — an agent billed for its customers' gas, a decline recorded once
// instead of every tick, and the four guard-lifecycle tests that exist because
// CloseGuard shipped a query Postgres refuses. They skipped because DATABASE_URL
// was absent, and `ok` says nothing about a test that did not run.
//
// The skips themselves were right, and they explained themselves. The summary
// was what lied. That is the same defect this repository keeps writing down: a
// check that reports success because it found nothing to check.
//
// ABSENT IS NOT BROKEN — the rule sigcount already follows for its count file. A
// missing file there is a fresh install and starts at zero; a file that exists
// and cannot be read makes the signer refuse. The same split applies here. A
// clone on a laptop with no Postgres anywhere genuinely cannot run these, and
// skipping is honest. A machine where Postgres is up, listening, and one
// environment variable away is a different thing: there the test could have run
// and didn't, and that is a failure to run the test rather than an absence of
// one.
//
// HOW THE TWO ARE TOLD APART, and why the answer cannot be "look at
// DATABASE_URL". DATABASE_URL is the variable that is missing in the case we
// care about; asking whether it is set only ever re-describes the skip. So the
// question put to the environment is about the DATABASE, not about the
// configuration: is something listening at the address this repository's own
// compose file publishes Postgres on, and does it answer the Postgres protocol?
//
// The probe sends an SSLRequest and reads one byte. It never sends a startup
// message, never authenticates, and needs no credential — which is deliberate,
// because a gate that required a password to decide whether a password was
// available would be circular. A server that answers 'S' or 'N' to SSLRequest is
// Postgres. Anything else, including a refused connection, is taken as "no
// database here" and the tests skip.

// The address is the repository's own convention, not a guess:
// infra/docker/docker-compose.yml publishes Postgres on
// "${HOST_POSTGRES:-5432}". HOST_POSTGRES is read because it is where this repo
// records a moved port; it is not DATABASE_URL and cannot stand in for it.
// ARCANA_TEST_PG_ADDR overrides the whole address for anyone whose Postgres is
// on another host — and is how the no-database branch of this gate is tested.
const (
	defaultProbeHost = "127.0.0.1"
	defaultProbePort = "5432"
	probeTimeout     = 1500 * time.Millisecond
	sslRequestCode   = 80877103
)

func postgresProbeAddr() string {
	if addr := os.Getenv("ARCANA_TEST_PG_ADDR"); addr != "" {
		return addr
	}
	port := os.Getenv("HOST_POSTGRES")
	if port == "" {
		port = defaultProbePort
	}
	return net.JoinHostPort(defaultProbeHost, port)
}

// speaksPostgres reports whether something at addr answers the Postgres wire
// protocol. Read-only, credential-free, and writes nothing to any database.
func speaksPostgres(addr string) bool {
	conn, err := net.DialTimeout("tcp", addr, probeTimeout)
	if err != nil {
		return false
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(probeTimeout)); err != nil {
		return false
	}

	req := make([]byte, 8)
	binary.BigEndian.PutUint32(req[0:4], 8)
	binary.BigEndian.PutUint32(req[4:8], sslRequestCode)
	if _, err := conn.Write(req); err != nil {
		return false
	}

	reply := make([]byte, 1)
	if _, err := io.ReadFull(conn, reply); err != nil {
		return false
	}
	// 'S' willing, 'N' not willing. 'E' is an error response from a server too
	// old to know the request, which is still Postgres answering. Reading any of
	// the three as "the database is there" errs toward failing rather than
	// skipping, which is the direction this file exists to err in.
	return reply[0] == 'S' || reply[0] == 'N' || reply[0] == 'E'
}

// The probe runs once per package, not once per test: six tests asking the same
// question of the same socket would be six answers that must agree.
var (
	probeOnce  sync.Once
	probeAddr  string
	probeFound bool
	probedURL  string

	// Counted so the run can say what did not run.
	skippedForNoDatabase atomic.Int64
)

// TestMain exists for a line of output, not for setup.
//
// AND IT IS NOT ENOUGH BY ITSELF, which was worth finding out. `go test`
// discards the entire output of a PASSING package — stdout and stderr, printed
// before or after m.Run() alike; a throwaway module was used to check all four
// combinations rather than reasoning about it. So when every DB-backed test here
// skips, the package still prints a bare "ok" and this line is invisible.
//
// It is kept because it IS visible in the two places a person looks closely: a
// -v run, and the test binary run directly. What makes the ordinary summary
// honest is the runner — `make test-go` reads the verbose log and prints the
// skip count, because that is the only place it can be printed.
func TestMain(m *testing.M) {
	code := m.Run()
	if n := skippedForNoDatabase.Load(); n > 0 {
		fmt.Fprintf(os.Stderr,
			"NOTE: %d test(s) in this package did NOT run: nothing answered the Postgres "+
				"protocol at %s and DATABASE_URL is not set. They were SKIPPED, not passed. "+
				"Run `make test-go` from the repo root to run them.\n",
			n, probeAddr)
	}
	os.Exit(code)
}

func databaseURLForTests(t *testing.T) string {
	t.Helper()
	probeOnce.Do(func() {
		probedURL = os.Getenv("DATABASE_URL")
		if probedURL == "" {
			probeAddr = postgresProbeAddr()
			probeFound = speaksPostgres(probeAddr)
		}
	})

	if probedURL != "" {
		return probedURL
	}

	if probeFound {
		t.Fatalf("DATABASE_URL is not set, but Postgres answered at %s.\n"+
			"This test did not run, and on this machine that is a failure rather than an absence: "+
			"the database it needs is up and one variable away.\n"+
			"Run the suite the way the repository documents it — `make test-go` from the repo root, "+
			"which sources .env — or export DATABASE_URL yourself.\n"+
			"If %s is not the database you meant, set ARCANA_TEST_PG_ADDR to the one you did.",
			probeAddr, probeAddr)
	}

	skippedForNoDatabase.Add(1)
	t.Skipf("nothing answered the Postgres protocol at %s and DATABASE_URL is not set, "+
		"so this test cannot run here — it is skipped, NOT passed.\n"+
		"This is the honest outcome on a clone with no database. "+
		"If your Postgres is elsewhere, set ARCANA_TEST_PG_ADDR to its address and it will be used.",
		probeAddr)
	return ""
}
