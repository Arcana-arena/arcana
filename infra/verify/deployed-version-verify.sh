#!/usr/bin/env bash
# deployed-version-verify.sh — is the code that is RUNNING the code that is
# CHECKED OUT?
#
# THE TRAP THIS CLOSES. The Go services used to run under `go run`, which
# recompiled on every start, so restarting a service was the same as deploying
# it. They now run built binaries — faster, one process instead of two, and
# systemd supervising the service rather than the compiler — but that breaks the
# equivalence: `git pull && systemctl restart` keeps running the old code, and
# says nothing about it.
#
# That is not hypothetical. It happened in this repo the day the signer was
# installed: a preflight change simply did not take effect, and the only symptom
# was a log line that never appeared. Nothing failed. Nothing was reported. The
# service was healthy and wrong.
#
# So every Go binary is stamped at link time with the commit it was built from
# and reports it on /healthz, and this compares that against HEAD.
#
# The Node services carry the same stamp, written into dist/.build-commit by
# the installer. They cannot report it over HTTP without a code change in each
# service, so it is read from disk instead — weaker in that a stamp could in
# principle outlive the build it names, and stated rather than glossed.
#
# Read-only.
#
# Usage:  bash infra/verify/deployed-version-verify.sh
# Exits non-zero if anything running is not what is checked out.

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

HEAD="$(git rev-parse HEAD 2>/dev/null)"
SHORT="${HEAD:0:12}"
pass=0; fail=0

ok() { printf '  PASS  %s\n' "$1"; pass=$((pass+1)); }
no() { printf '  FAIL  %s — %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

echo "deployed-version-verify: HEAD is $SHORT"
echo

echo "=== Go services report the commit they were built from ==="
check_go() {
  local name="$1" port="$2"
  local body commit
  body="$(curl -s --max-time 6 "http://127.0.0.1:${port}/healthz" 2>/dev/null)"
  if [ -z "$body" ]; then
    no "$name is answering" "no response on :$port"
    return
  fi
  commit="$(printf '%s' "$body" | sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p')"
  if [ -z "$commit" ]; then
    no "$name reports a commit" "healthz has no commit field — an old binary, from before stamping"
    return
  fi
  if [ "$commit" = "$HEAD" ]; then
    ok "$name runs ${commit:0:12} — matches HEAD"
  else
    no "$name runs HEAD" "running ${commit:0:12}, checked out $SHORT. Run infra/systemd/install.sh"
  fi
}
check_go decision-engine 8081
check_go scoring-engine  8082
check_go market-data     8083
check_go signer          8085

echo
echo "=== Node services report the commit they were built from ==="
check_node() {
  local name="$1" dir="$2" port="$3"
  local stamp
  if ! curl -s -o /dev/null --max-time 6 "http://127.0.0.1:${port}/healthz"; then
    no "$name is answering" "no response on :$port"
    return
  fi
  # A STAMP, not a timestamp.
  #
  # This compared mtimes at first, and that cannot work: any git operation
  # that rewrites a file bumps its mtime whether or not the content changed,
  # so `git checkout -- .` alone made a correct build look stale. A check that
  # cries wolf is worse than no check — the next real staleness reads as more
  # of the same.
  stamp="$(cat "$dir/dist/.build-commit" 2>/dev/null)"
  if [ -z "$stamp" ]; then
    no "$name reports a build commit" "$dir/dist/.build-commit missing — built before stamping, or not built"
  elif [ "$stamp" = "$HEAD" ]; then
    ok "$name built from ${stamp:0:12} — matches HEAD"
  else
    no "$name built from HEAD" "built from ${stamp:0:12}, checked out $SHORT. Run infra/systemd/install.sh"
  fi
}
check_node agent-service       services/agent-service       3001
check_node marketplace-service services/marketplace         3002
check_node arca-service        services/arca-service        3004
echo
echo "=== The working tree is what was committed ==="
if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
  ok "no uncommitted changes on the host"
else
  no "the host working tree is clean" "uncommitted changes — what runs may never have been reviewed"
  git status --short | head -5 | sed 's/^/        /'
fi

echo
echo "deployed-version-verify: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ] || exit 1
echo "deployed-version-verify: what is running is what is checked out."
