#!/usr/bin/env bash
# arcana-tick-watchdog.sh — catch the failure that OnFailure= cannot see.
#
# THE CASE THIS EXISTS FOR. On 2026-09-09 the scheduler stopped producing ticks
# at 18:58 and nobody knew until 23:33, found by hand. Season 2 sat at zero
# ticks and the system said nothing. With one tick per trading day a missed day
# cannot be patched later — the backfill-vs-replay rule forbids filling a scored
# season backwards — so a silent day is a permanent hole in the record, and a
# hole in the record damages exactly what this platform sells.
#
# OnFailure= would not have caught it in general: a scheduler that runs, exits
# 0 and produces nothing is not a failed unit. The real symptom is "no tick on a
# day the market was open", so that is what this measures.
#
# WHO DECIDES WHAT A TRADING DAY IS. Not this script.
#   * WHICH DATE to ask about comes from market-data's
#     GET /v1/market/session/expected — the same session.LastCompleted the daily
#     fetch uses. Weekends are handled there, structurally.
#   * WHETHER THE MARKET OPENED is the vendor's answer, and its permanent trace
#     is a stored snapshot carrying that trading_date. No snapshot, no session.
# A second calendar here would eventually disagree with the thing it watches,
# which is worse than no watchdog.
#
# READ-ONLY. It never calls POST /internal/v1/market/sessions/daily: that
# endpoint fetches from the vendor and creates a snapshot, and a monitor must
# not mutate what it observes.
#
# Exit codes: 0 = checked (healthy, muted, or alerted). 1 = the check itself
# could not be performed, which OnFailure= turns into its own alert.

set -uo pipefail

ARCANA_DIR="${ARCANA_DIR:-/home/ubuntu/arcana}"
NOTIFY="${ARCANA_DIR}/infra/alerting/arcana-notify.sh"
PG_CONTAINER="${PG_CONTAINER:-arcana-postgres}"
PG_USER="${PG_USER:-arcana}"
WATCHDOG_DB="${WATCHDOG_DB:-arcana}"
MARKET_DATA_URL="${MARKET_DATA_URL:-http://127.0.0.1:8083}"
SCHEDULER_UNIT="${SCHEDULER_UNIT:-arcana-scheduler.service}"

# Test hooks. Used by the verification rig to exercise each branch against a
# throwaway database; never set in the installed unit.
FORCE_DATE="${WATCHDOG_FORCE_DATE:-}"
FORCE_SCHED_RESULT="${WATCHDOG_FORCE_SCHED_RESULT:-}"
FORCE_SCHED_TS="${WATCHDOG_FORCE_SCHED_TS:-}"
DRY_RUN="${WATCHDOG_DRY_RUN:-0}"

log()     { echo "tick-watchdog: $*"; }
verdict() { echo "tick-watchdog: VERDICT=$1 REASON=$2"; }

psql_q() {
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$WATCHDOG_DB" -tAc "$1" 2>/dev/null | tr -d '\r'
}

raise() {
  local title="$1" body="$2"
  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] WOULD ALERT: ${title}"
    printf '%s\n' "$body" | sed 's/^/  /'
    return 0
  fi
  printf '%s\n' "$body" | "$NOTIFY" alert high "$title"
}

# --- 1. which session should exist? ----------------------------------------

if [ -n "$FORCE_DATE" ]; then
  D="$FORCE_DATE"
  log "expected trading date: ${D} (forced, test rig)"
else
  RESP=$(curl -sS --max-time 15 "${MARKET_DATA_URL}/v1/market/session/expected" 2>/dev/null)
  D=$(printf '%s' "$RESP" | sed -n 's/.*"trading_date":"\([0-9-]*\)".*/\1/p')
  if [ -z "$D" ]; then
    log "ERROR: market-data did not return an expected trading date"
    log "ERROR: response was: ${RESP:0:200}"
    exit 1   # the check could not run; OnFailure= alerts on this
  fi
  log "expected trading date: ${D} (from market-data)"
fi

# --- 2. which competition? --------------------------------------------------
#
# Read from the scheduler's own unit so there is ONE declaration of the active
# competition. Changing it there moves the watchdog with it, with no second
# place to forget.
COMP_ID=$(systemctl show "$SCHEDULER_UNIT" -p Environment --value 2>/dev/null \
          | tr ' ' '\n' | sed -n 's/^COMPETITION_ID=//p' | head -1)
if [ -z "$COMP_ID" ]; then
  log "ERROR: no COMPETITION_ID in ${SCHEDULER_UNIT}"
  exit 1
fi
log "competition: ${COMP_ID}"

COMP_STATUS=$(psql_q "SELECT status FROM competitions WHERE id='${COMP_ID}'")
if [ -z "$COMP_STATUS" ]; then
  log "ERROR: competition ${COMP_ID} not found in ${WATCHDOG_DB}"
  exit 1
fi
if [ "$COMP_STATUS" = "completed" ]; then
  verdict "healthy" "competition is completed; the scheduler is meant to no-op"
  exit 0
fi

# --- 3. did the vendor record a session for D? ------------------------------
#
# A live snapshot carrying trading_date = D IS the evidence that the market was
# open. Backfill snapshots are excluded: they are real prices but must never
# carry a scored decision, so they are not evidence that a tick was due.
SNAP_REF=$(psql_q "SELECT ref FROM market_snapshots
                    WHERE trading_date = DATE '${D}' AND ingest_mode = 'live'
                    ORDER BY tick_time DESC LIMIT 1")

if [ -n "$SNAP_REF" ]; then
  # Session exists. A tick must cite it.
  TICKED=$(psql_q "SELECT count(*) FROM competition_ticks
                    WHERE competition_id = '${COMP_ID}'
                      AND market_snapshot_ref = '${SNAP_REF}'")
  if [ "${TICKED:-0}" -gt 0 ]; then
    verdict "healthy" "session ${D} (${SNAP_REF}) has ${TICKED} tick(s)"
    exit 0
  fi

  LAST_TICK=$(psql_q "SELECT COALESCE(max(created_at)::text,'never')
                        FROM competition_ticks WHERE competition_id='${COMP_ID}'")
  raise "🔴 ARCANA: trading day with no tick" "$(cat <<EOF
The market was OPEN on ${D} and a snapshot was stored, but the competition
opened no tick against it. With one tick per trading day this day cannot be
filled in later — a scored season must not be replayed over a known outcome —
so it is a permanent gap in the record unless fixed before the next run.

trading_date : ${D}
snapshot     : ${SNAP_REF}
competition  : ${COMP_ID}
last tick    : ${LAST_TICK}

next:
  journalctl -u ${SCHEDULER_UNIT} --since '${D}' --no-pager
  sudo systemctl start ${SCHEDULER_UNIT}
EOF
)"
  verdict "alarm" "session ${D} stored but no tick cites ${SNAP_REF}"
  exit 0
fi

# --- 4. no session for D: closed, or did we fail to find out? ---------------

if [ -n "$FORCE_SCHED_RESULT" ]; then
  SCHED_RESULT="$FORCE_SCHED_RESULT"
  SCHED_TS_RAW="$FORCE_SCHED_TS"
else
  SCHED_RESULT=$(systemctl show "$SCHEDULER_UNIT" -p Result --value 2>/dev/null)
  # TZ=UTC is load-bearing. systemd formats this timestamp in the host's local
  # zone using its abbreviation, and GNU date cannot parse most of them — on
  # this host it printed "Thu 2026-09-10 00:57:51 WIB", which `date -d` rejects
  # outright. The parse then yielded 0, the run looked infinitely old, and the
  # watchdog raised "the scheduler did not run" on a day it had run fine.
  # That is a false alarm every single day, which is worse than no watchdog:
  # an alert that is usually wrong gets silenced, and then the real one is
  # silenced too. Forcing UTC makes systemd print "UTC", which parses.
  SCHED_TS_RAW=$(TZ=UTC systemctl show "$SCHEDULER_UNIT" -p ExecMainExitTimestamp --value 2>/dev/null)
fi

if [ -n "$FORCE_SCHED_RESULT" ]; then
  SCHED_EXIT="${WATCHDOG_FORCE_SCHED_EXIT:-0}"
else
  SCHED_EXIT=$(systemctl show "$SCHEDULER_UNIT" -p ExecMainStatus --value 2>/dev/null)
fi

# Both, not either. `systemctl reset-failed` clears Result back to "success"
# while ExecMainStatus keeps the real exit code, so an operator who tidied up a
# red unit would otherwise make a failed run look clean to the watchdog — and
# the watchdog would then judge a day on a run that never worked.
if [ "$SCHED_RESULT" != "success" ] || [ "${SCHED_EXIT:-0}" != "0" ]; then
  # It failed, loudly, and OnFailure= already sent one alert. Sending a second
  # for the same event is how alert fatigue starts.
  verdict "silent" "scheduler last run failed (result='${SCHED_RESULT}', exit=${SCHED_EXIT}) — already alerted by OnFailure="
  exit 0
fi

# The scheduler succeeded. Did it succeed AFTER this session's close? The run
# for session D happens at D 23:00 UTC (with retries at D+1 01:00/03:00), so a
# successful run at or after D 22:00 UTC is the one that saw D.
DEADLINE_EPOCH=$(date -u -d "${D} 22:00:00 UTC" +%s 2>/dev/null)
SCHED_EPOCH=$(date -u -d "${SCHED_TS_RAW}" +%s 2>/dev/null)

if [ -z "$DEADLINE_EPOCH" ]; then
  log "ERROR: could not parse the session deadline for ${D}"
  exit 1
fi

# An unparseable scheduler timestamp means "I could not check", NOT "it never
# ran". Defaulting it to 0 would silently turn a monitor fault into a fake
# report of a missing trading day — the watchdog inventing the very failure it
# exists to detect. Fail the check instead: OnFailure= reports it as what it is.
if [ -z "$SCHED_EPOCH" ]; then
  log "ERROR: could not parse the scheduler's last exit timestamp: '${SCHED_TS_RAW}'"
  log "ERROR: refusing to guess — this is a check failure, not a missing tick"
  exit 1
fi

if [ "${SCHED_EPOCH:-0}" -ge "$DEADLINE_EPOCH" ]; then
  verdict "healthy" "no session for ${D} and the scheduler ran cleanly after its close — market was closed (vendor)"
  exit 0
fi

raise "🔴 ARCANA: scheduler did not run for ${D}" "$(cat <<EOF
No snapshot was stored for trading day ${D}, and the scheduler has not
completed a run since that session closed. That is not a market holiday — on a
holiday the scheduler still RUNS and exits cleanly with no session. This looks
like the timer itself not firing.

trading_date        : ${D}
competition         : ${COMP_ID}
scheduler last exit : ${SCHED_TS_RAW:-never} (result=${SCHED_RESULT})
expected after      : ${D} 22:00 UTC

next:
  systemctl list-timers ${SCHEDULER_UNIT%.service}.timer
  systemctl status ${SCHEDULER_UNIT}
  journalctl -u ${SCHEDULER_UNIT} -n 50 --no-pager
EOF
)"
verdict "alarm" "no session for ${D} and no scheduler run since its close"
exit 0
