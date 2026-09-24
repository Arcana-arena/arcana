#!/usr/bin/env bash
# capital-watchdog-verify.sh — prove the capital alarms actually fire.
#
# An alarm that has never sounded has not been tested. Every branch below is
# fired through WATCHDOG_FORCE_ROWS, which replaces only the readings and leaves
# the rest of the script exactly as it runs, in DRY_RUN so nothing is sent.
# Rows are: name|agent|debt|hf_worst|liquidation_price|floor|mandate_status|age_minutes
#
# Exit 0 = every branch behaved. Exit 1 = something did not.
set -uo pipefail
REPO="${REPO:-/home/ubuntu/arcana}"
WATCHDOG="$REPO/infra/alerting/arcana-capital-watchdog.sh"
STATE="$(mktemp -u /tmp/capital-watchdog-verify.XXXXXX)"
pass=0; fail=0
run() { env WATCHDOG_DRY_RUN=1 CAPITAL_WATCHDOG_STATE="$STATE" "$@" bash "$WATCHDOG" 2>&1; }
check() {
  local desc="$1" needle="$2"; shift 2
  local out; out=$(run "$@")
  if printf '%s' "$out" | grep -qF -- "$needle"; then
    printf '  PASS  %s\n' "$desc"; pass=$((pass + 1))
  else
    printf '  FAIL  %s — wanted "%s"\n' "$desc" "$needle"; printf '%s\n' "$out" | tail -4 | sed 's/^/        /'; fail=$((fail + 1))
  fi
}

echo "=== Each finding fires ==="
rm -f "$STATE"
check "nothing owed and nothing read: healthy" "VERDICT=healthy" WATCHDOG_FORCE_ROWS=""
check "a floor breach with an active mandate says the guard is deleveraging" "the position guard is deleveraging" \
  WATCHDOG_FORCE_ROWS="agentA|a1|50|1.8|90|2|active|1"
rm -f "$STATE"
check "a floor breach with a stopped mandate says nothing will act" "Nothing will act on this position" \
  WATCHDOG_FORCE_ROWS="agentA|a1|50|1.8|90|2|stopped|1"
rm -f "$STATE"
check "with no mandate the owner floor of 1.5 applies" "under the floor 1.5, and the mandate is none" \
  WATCHDOG_FORCE_ROWS="agentA|a1|50|1.4|90|1.5|none|1"
rm -f "$STATE"
check "under 1.2 is near liquidation, whatever the mandate" "[NEAR LIQUIDATION] agentA" \
  WATCHDOG_FORCE_ROWS="agentA|a1|50|1.1|90|2|active|1"
rm -f "$STATE"
check "a reading older than ten minutes is reported as unread" "[NOT BEING READ] agentA" \
  WATCHDOG_FORCE_ROWS="agentA|a1|50|3|90|2|active|25"
rm -f "$STATE"
check "a position above its floor is not a finding" "VERDICT=healthy" \
  WATCHDOG_FORCE_ROWS="agentA|a1|50|2.4|90|2|active|1"

echo
echo "=== An unchanged finding is not sent twice, a new one is ==="
rm -f "$STATE"
ROW="agentA|a1|50|1.1|90|2|active|1"
# Not DRY_RUN here: the state file is only written when an alert is really
# sent, so the notifier is pointed at /bin/true.
env CAPITAL_WATCHDOG_STATE="$STATE" ARCANA_NOTIFY=/bin/true WATCHDOG_FORCE_ROWS="$ROW" bash "$WATCHDOG" >/dev/null 2>&1
check "the same finding on the next run is not sent again" "unchanged since the last run" WATCHDOG_FORCE_ROWS="$ROW"
check "a second position joining it is new, and is sent" "WOULD ALERT: ARCANA: 2 borrowing" \
  WATCHDOG_FORCE_ROWS="$ROW
agentB|b1|20|1.3|80|1.5|none|1"
rm -f "$STATE"

echo
echo "=== It refuses rather than guessing ==="
out=$(run PG_CONTAINER=no-such-container WATCHDOG_FORCE_ROWS=""); rc=$?
if [ $rc -eq 1 ]; then printf '  PASS  an unreachable database exits 1, not 0\n'; pass=$((pass + 1))
else printf '  FAIL  an unreachable database exited %s\n' "$rc"; fail=$((fail + 1)); fi

echo
echo "capital-watchdog-verify: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
