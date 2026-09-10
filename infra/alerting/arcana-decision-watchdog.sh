#!/usr/bin/env bash
# arcana-decision-watchdog.sh — has anything decided anything lately?
#
# WHAT CHANGED, AND WHY THE QUESTION HAD TO CHANGE WITH IT
#
# The watchdog this replaces asked: "was there a tick on a day the market was
# open?" That was the right question while prices came from a vendor describing
# US sessions, and it was careful about it — it never kept its own calendar,
# because a second calendar eventually disagrees with the thing it watches.
#
# There is no calendar any more. Stock Tokens trade against a pool that never
# closes: no open, no close, no weekend, no holiday. "A day the market was
# open" is every day, and asking whether the market opened is asking a question
# with no answer.
#
# So the question becomes the one that was always underneath it: HAS A DECISION
# BEEN RECORDED IN THE LAST N HOURS? That is measurable without a calendar,
# means the same thing on a Sunday as on a Tuesday, and — unlike the old
# question — it catches a scheduler that runs, exits 0, and produces nothing.
#
# THE CASE THIS EXISTS FOR, unchanged. On 2026-09-09 the scheduler stopped
# producing ticks at 18:58 and nobody knew until 23:33, found by hand. Season 2
# sat at zero ticks and the system said nothing. OnFailure= cannot see that: a
# unit that runs and exits 0 having done nothing is not a failed unit.
#
# THRESHOLD. Default 3x the cadence. Not 1x: a cadence of four hours means a
# tick lands somewhere in each four-hour window, not on the hour, and a timer
# that fires slightly late is normal operation rather than a fault. Three
# missed intervals is unambiguous — nothing plausible except a stopped system
# explains it — and an alarm that fires on normal jitter is an alarm people
# learn to close without reading.
#
# READ-ONLY. It never opens a tick and never reads the pool: a monitor must not
# mutate what it observes, and taking a tick to check whether ticks are being
# taken would make the watchdog the thing keeping the record alive.
#
# Exit codes: 0 = checked (healthy, muted, or alerted). 1 = the check itself
# could not be performed, which OnFailure= turns into its own alert.

set -uo pipefail

ARCANA_DIR="${ARCANA_DIR:-/home/ubuntu/arcana}"
NOTIFY="${ARCANA_DIR}/infra/alerting/arcana-notify.sh"
PG_CONTAINER="${PG_CONTAINER:-arcana-postgres}"
PG_USER="${PG_USER:-arcana}"
WATCHDOG_DB="${WATCHDOG_DB:-arcana}"

# The cadence being watched, in hours, and how many missed intervals count as a
# fault. Both settable so a competition running at a different cadence can be
# watched by the same script with the same reasoning.
CADENCE_HOURS="${CADENCE_HOURS:-4}"
MISSED_INTERVALS="${MISSED_INTERVALS:-3}"
CADENCE_UNIT="${CADENCE_UNIT:-arcana-cadence.service}"

MAX_AGE_HOURS=$(( CADENCE_HOURS * MISSED_INTERVALS ))

psql() {
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$WATCHDOG_DB" -tAc "$1" 2>/dev/null
}

# alert <title> <body>
#
# The body goes on STDIN and the title is an argument: that is arcana-notify's
# interface (`alert <priority> <title>`, body piped), not a guess. The first
# version of this script called it as `notify "$title" "$body"` and got a usage
# error — the alarm path was broken from the moment it was written, and it
# would have stayed broken until the day it was needed. Found by firing it on
# purpose, which is the only way this class of bug is ever found.
alert() {
  if [ ! -x "$NOTIFY" ]; then
    echo "decision-watchdog: NOTIFY MISSING at $NOTIFY" >&2
    echo "decision-watchdog: $1 — $2" >&2
    return
  fi
  printf '%s\n' "$2" | "$NOTIFY" alert high "$1" || true
}

# --- is there anything to watch? --------------------------------------------
#
# A system with no running competition is not a broken system, and alerting on
# one would be the false alarm that teaches everyone to ignore this script.
# Checked first, so the healthy-but-idle case exits quietly.
RUNNING=$(psql "SELECT count(*) FROM competitions WHERE status <> 'completed'")
if [ -z "$RUNNING" ]; then
  echo "decision-watchdog: cannot reach the database; the check was NOT performed" >&2
  exit 1
fi
if [ "$RUNNING" = "0" ]; then
  echo "decision-watchdog: no running competition. Nothing is expected to decide; healthy."
  exit 0
fi

# --- the measurement --------------------------------------------------------
#
# DECISIONS, not ticks. A tick that opens and closes with every agent failing
# is exactly the silent fault this exists to catch, and it would look healthy
# to anything counting ticks.
AGE_SECONDS=$(psql "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - max(ts)))::bigint, -1) FROM decisions")
if [ -z "$AGE_SECONDS" ]; then
  echo "decision-watchdog: could not read the decision record; the check was NOT performed" >&2
  exit 1
fi

if [ "$AGE_SECONDS" = "-1" ]; then
  # No decision has EVER been recorded. Distinguished from a stale one on
  # purpose: "it never started" and "it stopped" call for different first
  # questions, and one message covering both sends people to the wrong place.
  alert "ARCANA: no decision has ever been recorded" \
"There are ${RUNNING} running competition(s) and the decisions table is EMPTY.

This is not a stopped system — it is one that has not started. Check that
${CADENCE_UNIT} is enabled and has fired at least once:

  systemctl list-timers arcana-cadence.timer
  journalctl -u ${CADENCE_UNIT} -n 50 --no-pager"
  echo "decision-watchdog: ALERTED — no decisions at all"
  exit 0
fi

AGE_HOURS=$(( AGE_SECONDS / 3600 ))
MAX_AGE_SECONDS=$(( MAX_AGE_HOURS * 3600 ))

if [ "$AGE_SECONDS" -le "$MAX_AGE_SECONDS" ]; then
  echo "decision-watchdog: last decision ${AGE_HOURS}h ago (limit ${MAX_AGE_HOURS}h). Healthy."
  exit 0
fi

# --- something stopped ------------------------------------------------------
#
# The alert carries the evidence a person needs to act, not just the fact.
# Whether the unit is failing, and when it last ran, are the two things anybody
# looks up first, so they are gathered here rather than left as an exercise.
LAST_TS=$(psql "SELECT max(ts)::text FROM decisions")
UNIT_STATE=$(systemctl is-active "$CADENCE_UNIT" 2>/dev/null || echo unknown)
UNIT_RESULT=$(systemctl show -p Result --value "$CADENCE_UNIT" 2>/dev/null || echo unknown)
LAST_RUN=$(systemctl show -p ExecMainExitTimestamp --value "$CADENCE_UNIT" 2>/dev/null || echo unknown)
TICK_AGE=$(psql "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - max(window_start)))::bigint / 3600, -1) FROM competition_ticks")

alert "ARCANA: no decision in ${AGE_HOURS}h" \
"The last recorded decision was ${AGE_HOURS} hours ago (${LAST_TS}).
The cadence is ${CADENCE_HOURS}h, so ${MISSED_INTERVALS} intervals have passed
with nothing decided. ${RUNNING} competition(s) are running.

  last tick opened:  ${TICK_AGE}h ago
  ${CADENCE_UNIT}:  ${UNIT_STATE} (result: ${UNIT_RESULT}, last exit: ${LAST_RUN})

If the tick age is much SMALLER than the decision age, ticks are opening and
every agent is failing inside them — look at the decision engine, not the
timer. If both are stale, the cadence is not running.

  journalctl -u ${CADENCE_UNIT} -n 80 --no-pager
  journalctl -u arcana-decision.service -n 80 --no-pager

This matters more than a missed day used to. Under a continuous cadence there
is no market-closed excuse for a gap, and the backfill rule still forbids
filling a scored season backwards — so a silent stop is a permanent hole in
the record."

echo "decision-watchdog: ALERTED — last decision ${AGE_HOURS}h ago (limit ${MAX_AGE_HOURS}h)"
exit 0
