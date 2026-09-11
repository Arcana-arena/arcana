#!/usr/bin/env bash
# execution-watchdog-verify.sh — prove the execution alarms actually fire.
#
# AN ALARM THAT HAS NEVER SOUNDED HAS NOT BEEN TESTED. This project has already
# shipped a watchdog whose alert path was broken from the moment it was written
# — it called arcana-notify with two arguments instead of a body on stdin, and
# nobody would have known until the day it was needed. It was found by firing
# it on purpose. So is this.
#
# Every branch below is triggered for real: the healthy path against live data,
# and each alarm through a test hook that changes ONE input and leaves the rest
# of the script exactly as it runs in production.
#
# Exit 0 = every branch behaved. Exit 1 = something did not.
set -uo pipefail

REPO="${REPO:-/home/ubuntu/arcana}"
WATCHDOG="$REPO/infra/alerting/arcana-execution-watchdog.sh"

pass=0; fail=0
run() { env WATCHDOG_DRY_RUN=1 "$@" bash "$WATCHDOG" 2>&1; }

check_verdict() {
  local desc="$1" want="$2"; shift 2
  local out got
  out=$(run "$@"); got=$(printf '%s' "$out" | grep -oE 'VERDICT=[a-z]+' | head -1 | cut -d= -f2)
  if [ "$got" = "$want" ]; then
    printf '  PASS  verdict=%-8s %s\n' "$got" "$desc"; pass=$((pass + 1))
  else
    printf '  FAIL  verdict=%-8s want=%-8s %s\n' "${got:-none}" "$want" "$desc"
    printf '%s\n' "$out" | tail -4 | sed 's/^/        /'
    fail=$((fail + 1))
  fi
}

check_body() {
  local desc="$1" needle="$2"; shift 2
  local out
  out=$(run "$@")
  if printf '%s' "$out" | grep -qF "$needle"; then
    printf '  PASS  says %-42s %s\n' "\"${needle:0:40}\"" "$desc"; pass=$((pass + 1))
  else
    printf '  FAIL  missing %-39s %s\n' "\"${needle:0:40}\"" "$desc"; fail=$((fail + 1))
  fi
}

check_exit() {
  local desc="$1" want="$2"; shift 2
  local out got
  out=$(run "$@"); got=$?
  if [ "$got" = "$want" ]; then
    printf '  PASS  exit=%s  %s\n' "$got" "$desc"; pass=$((pass + 1))
  else
    printf '  FAIL  exit=%s want=%s  %s\n' "$got" "$want" "$desc"; fail=$((fail + 1))
  fi
}

echo "=== The healthy path, against live data ==="
check_verdict "nothing failing and gas above the floor" healthy
check_exit    "a healthy check exits 0" 0

echo
echo "=== Repeated failures alarm ==="
# One failure must NOT wake anyone. This is the check that stops the alarm
# becoming noise, and it is as important as the ones that fire.
check_verdict "a single failure does not alarm" healthy WATCHDOG_FORCE_FAILS=1
check_verdict "two failures still do not alarm" healthy WATCHDOG_FORCE_FAILS=2
check_verdict "three failures DO alarm"          alarm   WATCHDOG_FORCE_FAILS=3
check_body    "the alarm names the pattern" "executions failed in the last" WATCHDOG_FORCE_FAILS=3
check_body    "and says why one is tolerated" "One revert is ordinary" WATCHDOG_FORCE_FAILS=3
check_body    "and points at the evidence" "FROM executions ORDER BY id DESC" WATCHDOG_FORCE_FAILS=3

echo
echo "=== Gas alarms ==="
# The floor is the broker's own precondition: 2 x maxFee x gasLimit = 5e14 wei.
check_verdict "a wallet below the broker's reserve alarms" alarm WATCHDOG_FORCE_BALANCE=100000000000000
check_body    "and says it cannot trade" "CANNOT TRADE" WATCHDOG_FORCE_BALANCE=100000000000000
check_body    "and says why that looks like inaction" "choosing to do nothing" WATCHDOG_FORCE_BALANCE=100000000000000
check_verdict "a wallet under 4x the reserve warns"      alarm WATCHDOG_FORCE_BALANCE=1000000000000000
check_body    "and distinguishes low from empty" "LOW GAS" WATCHDOG_FORCE_BALANCE=1000000000000000
check_verdict "a wallet well above the reserve is quiet" healthy WATCHDOG_FORCE_BALANCE=10000000000000000

echo
echo "=== Unrecorded spend ==="
# The nonce says how many transactions the wallet sent; ARCANA should have a row
# for each. This check would have caught the discarded approval immediately:
# nonce 2, rows 1. It did not exist, so nothing did.
check_verdict "a wallet whose nonce matches its rows is quiet" healthy
check_verdict "one unrecorded transaction is reported" healthy WATCHDOG_FORCE_NONCE_GAP=1
check_body    "and named, because the owner may own the gap" "unrecorded" WATCHDOG_FORCE_NONCE_GAP=1
# On a PLATFORM_ONLY wallet there is no other explanation, so it must alarm.
# Agent 3 is shared-custody today, so without this hook the alarming branch
# would never be exercised -- and a branch that has never fired is untested.
check_verdict "on a platform-only wallet it ALARMS instead" alarm WATCHDOG_FORCE_NONCE_GAP=1 WATCHDOG_FORCE_CUSTODY=platform_only
check_body    "and says nothing else could have signed it" "no other explanation" WATCHDOG_FORCE_NONCE_GAP=1 WATCHDOG_FORCE_CUSTODY=platform_only

echo
echo "=== It refuses rather than guessing ==="
# A check that cannot run must never report health. Exit 1 is what OnFailure=
# turns into its own alert.
check_exit "an unreachable database exits 1, not 0" 1 PG_CONTAINER=no-such-container
check_exit "an unreachable RPC exits 1, not 0" 1 EXECUTION_RPC_URL=https://nonexistent.invalid

echo
echo "execution-watchdog-verify: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ] || exit 1
echo "execution-watchdog-verify: every branch has fired. The alarm has sounded, so it has been tested."
