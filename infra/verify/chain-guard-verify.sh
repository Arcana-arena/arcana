#!/usr/bin/env bash
# chain-guard-verify.sh — prove the chain guard actually alarms.
#
# A monitor that has never fired has not been tested. This project has already
# shipped a nonce gate that never rejected a single replay, because what was
# checked was that the gate existed rather than that it refused. The same
# mistake in a monitor is worse: a gate that does not refuse lets one bad thing
# through, while a monitor that does not fire lets everything through, silently,
# for as long as it takes somebody to notice by hand.
#
# So each branch is exercised against the LIVE chain, with the drift injected
# through the guard's test hooks. Nothing is mocked: the RPC calls, the token
# addresses and the baseline are all real. Only the value being compared is
# forced.
#
# The exit-code contract is what is under test, because systemd reads it:
#   0 = the check ran   (healthy, or drift found and alerted)
#   1 = the check could not run — OnFailure= raises its own alert
# Blurring those two is how an outage comes to look like a quiet day.
#
# Usage:  bash infra/verify/chain-guard-verify.sh
# Exits non-zero if any case behaves differently from the contract.

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

GUARD="infra/alerting/arcana-chain-guard.mjs"
pass=0; fail=0

check() {
  local desc="$1" want="$2"; shift 2
  local out got
  out=$(env "$@" CHAIN_GUARD_DRY_RUN=1 node "$GUARD" 2>&1); got=$?
  if [ "$got" = "$want" ]; then
    printf '  PASS  exit=%s  %s\n' "$got" "$desc"
    pass=$((pass + 1))
  else
    printf '  FAIL  exit=%s want=%s  %s\n' "$got" "$want" "$desc"
    printf '%s\n' "$out" | tail -5 | sed 's/^/        /'
    fail=$((fail + 1))
  fi
}

# Additionally assert the alert BODY names the right thing — an alarm that
# fires with an unusable message is only marginally better than none.
check_body() {
  local desc="$1" needle="$2"; shift 2
  local out
  out=$(env "$@" CHAIN_GUARD_DRY_RUN=1 node "$GUARD" 2>&1)
  if printf '%s' "$out" | grep -qF "$needle"; then
    printf '  PASS  body names %-38s %s\n' "\"${needle:0:36}\"" "$desc"
    pass=$((pass + 1))
  else
    printf '  FAIL  body missing %-36s %s\n' "\"${needle:0:36}\"" "$desc"
    fail=$((fail + 1))
  fi
}

echo "chain-guard-verify: exercising every branch against the live chain"
echo
echo "-- the check RAN (exit 0), whether or not it found something --"
check "healthy: baseline matches the chain"       0 VERIFY=1
check "drift:   implementation changed"           0 CHAIN_GUARD_FORCE_IMPL=0xdeadbeef00000000000000000000000000000001
check "drift:   token paused by the issuer"       0 CHAIN_GUARD_FORCE_PAUSED=NVDA

echo
echo "-- the check COULD NOT RUN (exit 1) — never reported as healthy --"
check "fault:   every RPC endpoint unreachable"   1 CHAIN_RPC_URLS=https://nonexistent.invalid CHAIN_GUARD_TIMEOUT_MS=3000
check "fault:   connected to the wrong chain"     1 CHAIN_RPC_URLS=https://ethereum-rpc.publicnode.com
check "fault:   baseline file missing"            1 CHAIN_BASELINE=/nonexistent/chain-baseline.json

echo
echo "-- the alert says something a person can act on --"
check_body "implementation drift" "IMPLEMENTATION CHANGED" CHAIN_GUARD_FORCE_IMPL=0xdeadbeef00000000000000000000000000000001
check_body "implementation drift" "STOP funding new agent wallets" CHAIN_GUARD_FORCE_IMPL=0xdeadbeef00000000000000000000000000000001
check_body "issuer pause"         "PAUSED by the issuer" CHAIN_GUARD_FORCE_PAUSED=NVDA

echo
echo "-- one forced change alarms on ALL tokens, because they share one beacon --"
# Count the journal lines only. Each finding also appears in the alert body, so
# an unanchored grep double-counts and the check would pass for the wrong reason.
n=$(env CHAIN_GUARD_DRY_RUN=1 CHAIN_GUARD_FORCE_IMPL=0xdeadbeef00000000000000000000000000000001 \
      node "$GUARD" 2>&1 | grep -c '^chain-guard: CRITICAL .*IMPLEMENTATION CHANGED')
total=$(node -e "console.log(require('./infra/alerting/chain-baseline.json').tokens.length)")
if [ "$n" = "$total" ]; then
  printf '  PASS  %s of %s tokens alarmed from a single injected change\n' "$n" "$total"
  pass=$((pass + 1))
else
  printf '  FAIL  %s of %s tokens alarmed — expected all of them\n' "$n" "$total"
  fail=$((fail + 1))
fi

echo
echo "chain-guard-verify: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ] || exit 1
echo "chain-guard-verify: the guard fires. It has refused something, so it has been tested."
