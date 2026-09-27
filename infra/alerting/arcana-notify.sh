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

  # --- cooldown: one alert per unit per window -----------------------------
  #
  # THE FLOOD THIS CLOSES. The every-minute timers fail every minute for as
  # long as agent-service is down, and each failure used to send its own alert.
  # A 2.5-hour outage on 2026-09-27 sent enough of them to exhaust the ntfy.sh
  # daily quota — after which every later alert, including a real one about a
  # different unit, was refused with 429. The flood silenced the alarm.
  #
  # The first failure still alerts at once. Repeats inside the window are
  # counted, not dropped: the next alert that does go out says how many were
  # held back, so a unit that kept failing never reads as a one-off.
  local cooldown="${ALERT_COOLDOWN_SEC:-1800}"
  local state_dir="${ALERT_STATE_DIR:-${HOME:-/home/ubuntu}/.local/state/arcana-alerts}"
  local state="${state_dir}/${unit}"
  local now last=0 held=0
  now=$(date +%s)
  mkdir -p "$state_dir" 2>/dev/null
  if [ -r "$state" ]; then
    read -r last held < "$state" || true
  fi
  last=${last:-0}; held=${held:-0}
  if [ $((now - last)) -lt "$cooldown" ]; then
    held=$((held + 1))
    echo "$last $held" > "$state"
    log "HELD: ${unit} failed again within ${cooldown}s of the last alert (${held} held so far)."
    return 0
  fi

  local repeats=""
  if [ "$held" -gt 0 ]; then
    repeats=$'\n'"repeats: ${held} more failure(s) of this unit were held back since the previous alert"
  fi

  local body
  body=$(cat <<EOF
host: ${HOSTNAME_SHORT}
unit: ${unit}
when: ${when}
exit: code=${exit_code:-?} (${exit_status:-?}), result=${result:-?}${repeats}

last ${LOG_LINES} log lines:
${logs}

next: journalctl -u ${unit} -n 50 --no-pager
EOF
)
  # The window starts only once an alert is actually delivered: a failed send
  # must not suppress the retry that might get through.
  send "high" "🔴 ARCANA: ${unit} failed" "rotating_light" "$body" || return 1
  echo "$now 0" > "$state"
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
