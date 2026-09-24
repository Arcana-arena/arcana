#!/usr/bin/env bash
# arcana-capital-watchdog.sh — is any borrowing position close to liquidation?
#
# THE PAGE SHOWS IT; THIS SAYS IT. /me/capital colours a health factor near
# the floor, which helps only somebody looking at it. A position that drifts
# toward liquidation at night is the one nobody is looking at, so this reads
# the latest capital_positions row of every position with debt and alerts on
# three things:
#
#   UNDER THE FLOOR       worst-case health factor under the mandate's floor
#                         (1.5 with no mandate). With an ACTIVE mandate the
#                         guard is already deleveraging, and the alert says so;
#                         with a stopped or absent one nothing will act unless
#                         somebody does.
#   NEAR LIQUIDATION      worst-case health factor under 1.2, whatever the
#                         mandate. Morpho liquidates at 1.0 with a ~12.7% bonus
#                         taken from the owner.
#   NOT BEING READ        the latest reading is more than ten minutes old: the
#                         reader has stopped, so the figures above describe the
#                         past, and a position that cannot be seen cannot be
#                         protected.
#
# NOT EVERY FIVE MINUTES FOR THE SAME THING. The set of findings is compared
# with the last run's, and an unchanged set is not sent again — an alert that
# repeats every five minutes is an alert people mute. A finding that clears and
# comes back is new, and is sent.
#
# READ-ONLY. Exit 1 means the check could not be performed, never "nothing
# found"; OnFailure= turns that into its own alert.

set -uo pipefail

ARCANA_DIR="${ARCANA_DIR:-/home/ubuntu/arcana}"
NOTIFY="${ARCANA_NOTIFY:-${ARCANA_DIR}/infra/alerting/arcana-notify.sh}"
PG_CONTAINER="${PG_CONTAINER:-arcana-postgres}"
PG_USER="${PG_USER:-arcana}"
PG_DB="${PG_DB:-arcana}"
STATE_FILE="${CAPITAL_WATCHDOG_STATE:-/var/tmp/arcana-capital-watchdog.last}"
NEAR_LIQUIDATION="${CAPITAL_NEAR_LIQUIDATION:-1.2}"
OWNER_FLOOR="${CAPITAL_OWNER_FLOOR:-1.5}"
STALE_MINUTES="${CAPITAL_STALE_MINUTES:-10}"
DRY_RUN="${WATCHDOG_DRY_RUN:-0}"

psql() {
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc "$1" 2>/dev/null
}

alert() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "capital-watchdog: WOULD ALERT: $1"
    printf '%s\n' "$2" | sed 's/^/    /'
    return
  fi
  if [ ! -x "$NOTIFY" ]; then
    echo "capital-watchdog: NOTIFY MISSING at $NOTIFY" >&2
    echo "capital-watchdog: $1 — $2" >&2
    return
  fi
  printf '%s\n' "$2" | "$NOTIFY" alert high "$1" || true
}

verdict() { echo "capital-watchdog: VERDICT=$1 REASON=$2"; }

# The latest reading of every position that owes something, with its floor and
# who, if anyone, is acting on it.
ROWS=$(psql "
  WITH latest AS (
    SELECT DISTINCT ON (agent_id, market_id)
           agent_id, market_id, ts, debt_usdg, health_factor_worst, liquidation_price_usdg
      FROM capital_positions
     ORDER BY agent_id, market_id, ts DESC)
  SELECT a.name || '|' || l.agent_id || '|' || l.debt_usdg || '|' ||
         coalesce(l.health_factor_worst::text, '') || '|' ||
         coalesce(l.liquidation_price_usdg::text, '') || '|' ||
         coalesce(m.min_health_factor::text, '${OWNER_FLOOR}') || '|' ||
         coalesce(m.status, 'none') || '|' ||
         round(extract(epoch FROM now() - l.ts) / 60)
    FROM latest l
    JOIN agents a ON a.id = l.agent_id
    LEFT JOIN capital_mandates m ON m.agent_id = l.agent_id AND m.market_id = l.market_id
   WHERE l.debt_usdg > 0
   ORDER BY a.name")
RC=$?
if [ $RC -ne 0 ]; then
  echo "capital-watchdog: cannot reach the database; the check was NOT performed" >&2
  exit 1
fi
if [ -n "${WATCHDOG_FORCE_ROWS:-}" ]; then
  ROWS="$WATCHDOG_FORCE_ROWS"   # test hook: pretend these readings
fi

FINDINGS=""
KEYS=""
add() { FINDINGS="${FINDINGS}$1
"; KEYS="${KEYS}$2
"; }

while IFS='|' read -r name agent debt hf liq floor mstatus age; do
  [ -z "$agent" ] && continue
  if [ -n "$age" ] && [ "$age" -gt "$STALE_MINUTES" ]; then
    add "[NOT BEING READ] ${name}: owes ${debt} USDG and its position was last read ${age} min ago.
     The capital reader in the position guard has stopped, so nothing below describes the position now.
     Check: systemctl status arcana-guard; journalctl -u arcana-guard -n 50" "stale|${agent}"
  fi
  [ -z "$hf" ] && continue
  if awk "BEGIN{exit !(${hf} < ${NEAR_LIQUIDATION})}"; then
    add "[NEAR LIQUIDATION] ${name}: worst-case health factor ${hf}, owes ${debt} USDG, liquidated at ${liq} per share.
     Morpho liquidates at 1.0 and takes a bonus of about 12.7% from the owner. Repay or post collateral now:
     /me/capital" "liq|${agent}"
  elif awk "BEGIN{exit !(${hf} < ${floor})}"; then
    if [ "$mstatus" = "active" ]; then
      add "[UNDER THE FLOOR] ${name}: worst-case health factor ${hf}, under the mandate's floor ${floor}.
     The mandate is active, so the position guard is deleveraging one step a minute; its steps are listed
     under Capital decisions. This alert repeats only if the set of findings changes." "floor|${agent}"
    else
      add "[UNDER THE FLOOR] ${name}: worst-case health factor ${hf}, under the floor ${floor}, and the mandate is ${mstatus}.
     Nothing will act on this position unless its owner does: repay or post collateral at /me/capital." "floor|${agent}"
    fi
  fi
done <<< "$ROWS"

if [ -z "$KEYS" ]; then
  rm -f "$STATE_FILE" 2>/dev/null
  verdict healthy "no position with debt is under its floor, near liquidation, or unread"
  exit 0
fi

COUNT=$(printf '%s' "$KEYS" | grep -c .)
SIG=$(printf '%s' "$KEYS" | sort | sha256sum | cut -c1-16)
if [ -f "$STATE_FILE" ] && [ "$(cat "$STATE_FILE" 2>/dev/null)" = "$SIG" ]; then
  verdict alarm "${COUNT} finding(s), unchanged since the last run, not sent again"
  exit 0
fi
alert "ARCANA: ${COUNT} borrowing position(s) need attention" "$FINDINGS"
[ "$DRY_RUN" = "1" ] || echo "$SIG" > "$STATE_FILE"
verdict alarm "${COUNT} finding(s)"
exit 0
