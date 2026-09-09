#!/usr/bin/env bash
# arcana-notify.sh — send one actionable alert to ntfy.
#
# Invoked two ways:
#   arcana-notify.sh unit-failed <unit>        (from OnFailure= on a unit)
#   arcana-notify.sh alert <priority> <title> <<< "body"
#
# WHAT AN ALERT MUST CONTAIN. Unit, when, exit code, and the last lines of its
# log. An alert that only says "something failed" forces whoever reads it to log
# into the VPS before they know whether it matters — which delays the response
# at exactly the moment response time counts.
#
# WHAT IS DELIBERATELY NOT ALERTED is in docs/alerting.md. The short version:
# a job that skipped on purpose is not a failure, and a false alarm is more
# dangerous than no alarm, because somebody woken every Saturday will silence
# the thing permanently.

set -uo pipefail

ARCANA_DIR="${ARCANA_DIR:-/home/ubuntu/arcana}"
LOG_LINES="${ALERT_LOG_LINES:-12}"
HOSTNAME_SHORT="$(hostname -s 2>/dev/null || echo arcana)"

log() { echo "arcana-notify: $*"; }

# --- transport -------------------------------------------------------------

# NTFY_TOPIC is a secret: on ntfy.sh the topic name IS the credential, so it
# lives in .env.alerts at mode 600 and never in a unit file.
send() {
  local priority="$1" title="$2" tags="$3" body="$4"

  if [ -z "${NTFY_TOPIC:-}" ]; then
    # The alerting layer itself is unconfigured. Nothing can be sent, so say so
    # loudly in the journal and fail — a silent notifier is the failure mode
    # this whole task exists to remove.
    log "ERROR: NTFY_TOPIC is not set; cannot deliver alert: ${title}"
    return 1
  fi

  local url="${NTFY_SERVER:-https://ntfy.sh}/${NTFY_TOPIC}"
  local code
  code=$(curl -sS --max-time 20 -o /tmp/arcana-notify-resp.$$ -w '%{http_code}' \
    -H "Title: ${title}" \
    -H "Priority: ${priority}" \
    -H "Tags: ${tags}" \
    -d "${body}" \
    "$url" 2>/tmp/arcana-notify-err.$$)
  local rc=$?
  local resp; resp=$(cat /tmp/arcana-notify-resp.$$ 2>/dev/null | head -c 200)
  local err;  err=$(cat /tmp/arcana-notify-err.$$ 2>/dev/null | head -c 200)
  rm -f /tmp/arcana-notify-resp.$$ /tmp/arcana-notify-err.$$

  if [ "$rc" -ne 0 ] || [ "${code:-000}" -ge 400 ]; then
    log "ERROR: delivery failed (curl=$rc http=${code:-none}) ${err} ${resp}"
    return 1
  fi
  log "delivered: ${title} (http ${code})"
  return 0
}

# --- reality checks used for muting ----------------------------------------

# Is the market vendor actually configured?
#
# This is read from the real environment file, NOT from a separate "mute
# alerts" switch. A manual flag is a switch someone forgets to turn off, and an
# alarm silenced by a forgotten flag is the same class of failure as the silent
# failure being fixed here. Fill in MARKET_VENDOR_API_KEY and this mute lifts by
# itself, with nothing to remember.
vendor_key_present() {
  local f="${ARCANA_DIR}/services/market-data/.env"
  [ -r "$f" ] || return 1
  local v
  v=$(grep -m1 '^MARKET_VENDOR_API_KEY=' "$f" 2>/dev/null | cut -d= -f2-)
  [ -n "$v" ]
}

# --- unit failure ----------------------------------------------------------

unit_failed() {
  local unit="$1"
  [ -n "$unit" ] || { log "ERROR: no unit given"; return 1; }

  local result exit_code exit_status when
  result=$(systemctl show "$unit" -p Result --value 2>/dev/null)
  exit_code=$(systemctl show "$unit" -p ExecMainStatus --value 2>/dev/null)
  exit_status=$(systemctl show "$unit" -p ExecMainCode --value 2>/dev/null)
  when=$(systemctl show "$unit" -p ExecMainExitTimestamp --value 2>/dev/null)
  [ -n "$when" ] || when="$(date -u +'%a %Y-%m-%d %H:%M:%S UTC')"

  local logs
  logs=$(journalctl -u "$unit" -n "$LOG_LINES" --no-pager -o cat 2>/dev/null \
         | grep -v '^$' | tail -n "$LOG_LINES")
  [ -n "$logs" ] || logs="(no log lines captured)"

  # --- mute: the vendor is genuinely not configured yet -------------------
  #
  # Narrow on purpose. It requires BOTH that the key is really absent AND that
  # the failure really is the vendor-not-configured one. A scheduler that dies
  # for any other reason still alerts, even while the key is missing.
  if ! vendor_key_present && printf '%s' "$logs" | grep -q 'vendor_not_configured'; then
    log "MUTED: ${unit} failed because MARKET_VENDOR_API_KEY is not set."
    log "MUTED: this is a known, expected state — no alert sent. It will alert"
    log "MUTED: again automatically once the key is present; nothing to un-mute."
    return 0
  fi

  local body
  body=$(cat <<EOF
host: ${HOSTNAME_SHORT}
unit: ${unit}
when: ${when}
exit: code=${exit_code:-?} (${exit_status:-?}), result=${result:-?}

last ${LOG_LINES} log lines:
${logs}

next: journalctl -u ${unit} -n 50 --no-pager
EOF
)
  send "high" "🔴 ARCANA: ${unit} failed" "rotating_light" "$body"
}

# --- generic alert ---------------------------------------------------------

generic_alert() {
  local priority="$1" title="$2"
  local body; body=$(cat)
  send "$priority" "$title" "warning" "$(printf 'host: %s\n\n%s' "$HOSTNAME_SHORT" "$body")"
}

# --- main ------------------------------------------------------------------

MODE="${1:-}"
case "$MODE" in
  unit-failed) unit_failed "${2:-}" ;;
  alert)       generic_alert "${2:-high}" "${3:-ARCANA alert}" ;;
  test)        send "default" "✅ ARCANA: notification test" "white_check_mark" \
                 "$(printf 'host: %s\nsent: %s\n\nIf you can read this, alerts reach you.' \
                    "$HOSTNAME_SHORT" "$(date -u +'%Y-%m-%dT%H:%M:%SZ')")" ;;
  *)           echo "usage: $0 {unit-failed <unit>|alert <priority> <title>|test}" >&2; exit 2 ;;
esac
