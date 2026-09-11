#!/usr/bin/env bash
# arcana-guard-watchdog.sh — is the position guard actually watching?
#
# THE FAILURE THIS EXISTS FOR IS SILENCE THAT LOOKS LIKE CALM.
#
# A stop loss is protection an owner stops thinking about. That is its value and
# its danger: the moment it stops working, nothing changes visibly. No error, no
# missing row, no alert — just a level that will never fire. The agent keeps
# trading, the portfolio keeps updating, and the first sign is a loss that
# should have been cut.
#
# So this asks one question that a dead watcher cannot answer for itself:
# IS THE HEARTBEAT FRESH?
#
# WHY NOT `pgrep`, AND WHY NOT `systemctl is-active` ALONE
#
# `pgrep -f cycle-watch.sh` once matched the pgrep command's own argv and
# reported a watcher alive that had been dead for hours. A check that can be
# satisfied by the act of checking proves its own existence and nothing else.
#
# `systemctl is-active` is better — the state is maintained by something other
# than this script — but it answers "is the process running", not "is it doing
# its job". A guard wedged on an RPC call that never returns is active and is
# not watching.
#
# The heartbeat is a fact the guard has to PRODUCE, on every scan, including
# scans that find nothing. Nothing else can produce it. That makes staleness
# unambiguous, and it is the reason the heartbeat is written even when there is
# nothing to report: otherwise "no recent row" would mean either "dead" or
# "quiet", and an alarm that has to guess is an alarm that gets muted.
#
# Both checks run anyway, because they fail differently and the difference is
# the diagnosis:
#
#   unit inactive + stale heartbeat  -> it is not running
#   unit active   + stale heartbeat  -> it is running and stuck
#   unit active   + fresh heartbeat + errors -> it is scanning and failing
#
# Exit codes: 0 = the check ran (healthy, or alerted). 1 = the check could NOT
# be performed. Never 0 for "I could not tell".

set -uo pipefail

ARCANA_DIR="${ARCANA_DIR:-/home/ubuntu/arcana}"
NOTIFY="${ARCANA_NOTIFY:-${ARCANA_DIR}/infra/alerting/arcana-notify.sh}"
PG_CONTAINER="${PG_CONTAINER:-arcana-postgres}"
PG_USER="${PG_USER:-arcana}"
PG_DB="${PG_DB:-arcana}"
UNIT="${GUARD_UNIT:-arcana-guard.service}"

# STALENESS IS DERIVED FROM THE SCAN INTERVAL, not chosen.
#
# The guard scans every GUARD_SCAN_INTERVAL and writes a heartbeat each time. A
# heartbeat older than several intervals means scans have stopped. Four
# intervals plus a minute: long enough that one slow chain read never wakes
# anyone, short enough that a wedged watcher is found inside two minutes rather
# than after the move it was supposed to catch.
SCAN_INTERVAL_SEC="${GUARD_SCAN_INTERVAL_SEC:-15}"
STALE_AFTER_SEC="${GUARD_STALE_AFTER_SEC:-$(( SCAN_INTERVAL_SEC * 4 + 60 ))}"

# Test hooks, used by the verification rig to fire each branch on purpose.
# Never set in the installed unit.
FORCE_AGE="${WATCHDOG_FORCE_AGE:-}"        # pretend the heartbeat is this many seconds old
FORCE_UNIT="${WATCHDOG_FORCE_UNIT:-}"      # pretend is-active said this
FORCE_ERROR="${WATCHDOG_FORCE_ERROR:-}"    # pretend the heartbeat carries this error
DRY_RUN="${WATCHDOG_DRY_RUN:-0}"

psql() {
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc "$1" 2>/dev/null
}

# alert <title> <body>. Body on STDIN, title as an argument — arcana-notify's
# interface, written the way the execution watchdog writes it, because the
# decision watchdog's alarm was broken from its first line for guessing this.
alert() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "guard-watchdog: WOULD ALERT: $1"
    printf '%s\n' "$2" | sed 's/^/    /'
    return
  fi
  if [ ! -x "$NOTIFY" ]; then
    echo "guard-watchdog: NOTIFY MISSING at $NOTIFY" >&2
    echo "guard-watchdog: $1 — $2" >&2
    return
  fi
  printf '%s\n' "$2" | "$NOTIFY" alert high "$1" || true
}

verdict() { echo "guard-watchdog: VERDICT=$1 REASON=$2"; }

# --- is there anything to watch? --------------------------------------------
#
# No armed guard and no guard ever armed means this feature is simply not in
# use. That is not a broken system, and alarming on it would train whoever
# reads these to ignore them.
EVER=$(psql "SELECT count(*) FROM position_guards")
if [ -z "$EVER" ]; then
  echo "guard-watchdog: cannot reach the database; the check was NOT performed" >&2
  exit 1
fi

ARMED=$(psql "SELECT count(*) FROM position_guards WHERE status = 'armed'")
[ -z "$ARMED" ] && ARMED=0

# --- the two readings -------------------------------------------------------

if [ -n "$FORCE_UNIT" ]; then
  UNIT_STATE="$FORCE_UNIT"
else
  UNIT_STATE=$(systemctl is-active "$UNIT" 2>/dev/null || true)
  [ -z "$UNIT_STATE" ] && UNIT_STATE=unknown
fi

HB=$(psql "SELECT COALESCE(extract(epoch FROM now() - last_scan_at)::bigint::text, '') || '|' ||
                  COALESCE(scans::text,'0') || '|' ||
                  COALESCE(armed_guards::text,'0') || '|' ||
                  COALESCE(triggers::text,'0') || '|' ||
                  COALESCE(last_error,'') || '|' ||
                  COALESCE(version,'')
             FROM guard_heartbeat WHERE id = 1")

if [ -z "$HB" ]; then
  # NO ROW AT ALL. Distinct from a stale one: the guard has never completed a
  # single scan since this table existed.
  if [ "$ARMED" = "0" ] && [ "$EVER" = "0" ]; then
    verdict healthy "no guard has ever been armed and the watcher has never scanned; the feature is unused"
    exit 0
  fi
  alert "ARCANA: position guard has never reported" \
"$ARMED protective level(s) are armed and the guard has never written a heartbeat.

unit $UNIT is: $UNIT_STATE

Nothing is watching those levels. An armed stop loss that nobody is checking is
worse than no stop loss, because its owner believes it is there.

  journalctl -u $UNIT -n 50
  systemctl status $UNIT"
  verdict alerted "no heartbeat has ever been written while $ARMED guards are armed"
  exit 0
fi

AGE=$(echo "$HB" | cut -d'|' -f1)
SCANS=$(echo "$HB" | cut -d'|' -f2)
HB_ARMED=$(echo "$HB" | cut -d'|' -f3)
TRIGGERS=$(echo "$HB" | cut -d'|' -f4)
LAST_ERR=$(echo "$HB" | cut -d'|' -f5)
VERSION=$(echo "$HB" | cut -d'|' -f6)

[ -n "$FORCE_AGE" ] && AGE="$FORCE_AGE"
[ -n "$FORCE_ERROR" ] && LAST_ERR="$FORCE_ERROR"

echo "guard-watchdog: heartbeat ${AGE}s old, ${SCANS} scans, ${HB_ARMED} armed, ${TRIGGERS} triggers, unit=$UNIT_STATE, version=${VERSION:-unknown}"

# --- 1. STALE: the watcher is not scanning ----------------------------------
if [ "$AGE" -gt "$STALE_AFTER_SEC" ]; then
  # The unit state turns "it stopped" into a diagnosis rather than a mystery.
  if [ "$UNIT_STATE" = "active" ]; then
    DIAGNOSIS="The unit is ACTIVE, so the process is running and is NOT completing scans.
That points at a wedged chain call or a database it cannot write to — not at a crash."
  else
    DIAGNOSIS="The unit is $UNIT_STATE. The process is not running."
  fi
  alert "ARCANA: position guard has stopped watching" \
"Last scan was ${AGE}s ago; anything over ${STALE_AFTER_SEC}s means scans have stopped.

$ARMED protective level(s) are armed right now.
Scans so far: ${SCANS}. Triggers so far: ${TRIGGERS}. Version: ${VERSION:-unknown}.

$DIAGNOSIS

Every armed stop loss and take profit is currently unwatched.

  systemctl status $UNIT
  journalctl -u $UNIT -n 50"
  verdict alerted "heartbeat is ${AGE}s old with $ARMED guards armed"
  exit 0
fi

# --- 2. ALIVE AND FAILING ---------------------------------------------------
#
# A guard that scans on time and fails every scan is the subtlest of the three:
# the heartbeat is fresh, the unit is active, and nothing is being watched.
if [ -n "$LAST_ERR" ]; then
  alert "ARCANA: position guard is scanning and failing" \
"The guard is alive (last scan ${AGE}s ago, ${SCANS} scans) and its most recent scan
reported an error:

  $LAST_ERR

$ARMED protective level(s) are armed. Depending on the error, some or all of them
may not have been priced at all this scan.

  journalctl -u $UNIT -n 50"
  verdict alerted "the guard is alive and its last scan errored: $LAST_ERR"
  exit 0
fi

# --- 3. the unit is down but the heartbeat is somehow fresh ------------------
#
# Should be impossible and is checked anyway: it would mean something other than
# this unit is writing heartbeats, which is worth knowing immediately.
if [ "$UNIT_STATE" != "active" ]; then
  alert "ARCANA: position guard heartbeat without a running guard" \
"The heartbeat is fresh (${AGE}s) but $UNIT is $UNIT_STATE.

Something other than the supervised guard is writing heartbeats, so the freshness
of that row no longer means what this watchdog assumes it means.

  systemctl status $UNIT"
  verdict alerted "fresh heartbeat while the unit is $UNIT_STATE"
  exit 0
fi

# --- 4. a level was crossed and the exit was NOT taken -----------------------
#
# The quietest failure this feature has. The watcher is alive, scanning, and
# reporting no error, because refusing is not an error: the owner's own cost
# budget stopped the exit, or something else did. From the outside it is
# indistinguishable from a level that has simply not been reached — and the
# difference is a position the owner believes is protected and is not.
#
# One row per stuck guard, however many times it has been refused: the refusal
# is recorded once and remembered on the guard, which is what makes this
# checkable at all rather than drowned in 240 identical decisions an hour.
REFUSED=$(psql "
  SELECT count(*) || '|' || COALESCE(string_agg(
           g.symbol || ' ' || COALESCE(g.last_refusal_reason,'?') ||
           ' (' || round(extract(epoch FROM now() - g.last_refusal_at)/60) || 'm ago)', ', '), '')
    FROM position_guards g
   WHERE g.status = 'armed'
     AND g.last_refusal_at IS NOT NULL
     AND g.last_refusal_at > now() - interval '1 hour'")

if [ -n "$REFUSED" ]; then
  N=${REFUSED%%|*}
  WHICH=${REFUSED#*|}
  if [ "${N:-0}" != "0" ]; then
    alert "ARCANA: a protective level fired and the exit was refused" "$N armed guard(s) had a level CROSSED in the last hour and the exit was not taken:

  $WHICH

The watcher is working — it saw the crossing and refused to act on it. The
commonest cause is the owner's own cost budget (risk_profile.cost_budget_monthly_pct);
a signature cap or a chain refusal will look the same from here.

The level stays ARMED and will be acted on as soon as the agent can transact.
Until then the position is unprotected in practice.

  SELECT * FROM position_guards WHERE status = 'armed' AND last_refusal_at IS NOT NULL;
  journalctl -u $UNIT -n 50"
    verdict alerted "$N guard(s) crossed and refused: $WHICH"
    exit 0
  fi
fi

verdict healthy "last scan ${AGE}s ago, $ARMED armed, $TRIGGERS triggers so far"
exit 0
