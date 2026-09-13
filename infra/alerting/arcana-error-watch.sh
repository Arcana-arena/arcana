#!/usr/bin/env bash
# arcana-error-watch.sh — has any service answered a request with a 500?
#
# THE CASE THIS EXISTS FOR. From 2026-09-13 every creator's earnings read failed
# with "could not determine data type of parameter $1". arca-service logged it
# twenty times; nothing read that log. agent-service turned the 500 into a
# tolerated "could not be read", the page rendered, every unit stayed active,
# and OnFailure= — which fires when a UNIT fails — had nothing to see. A service
# that answers requests with errors is not a failed unit.
#
# So this reads the journal of every request-serving unit since the last line
# it read, and alerts once for each batch of new server errors, grouped by
# message. The cursor is what makes it once: an error that has been reported is
# not reported again on the next run.
#
# READ-ONLY. It reads journals and sends an alert. It restarts nothing.
#
# Exit codes: 0 = checked (clean or alerted). 1 = a journal could not be read,
# which OnFailure= turns into its own alert — a watcher that cannot see is not
# a watcher reporting that everything is fine.

set -uo pipefail

ARCANA_DIR="${ARCANA_DIR:-/home/ubuntu/arcana}"
NOTIFY="${ARCANA_DIR}/infra/alerting/arcana-notify.sh"
STATE_DIR="${ERROR_WATCH_STATE_DIR:-/home/ubuntu/.arcana-error-watch}"
UNITS="${ERROR_WATCH_UNITS:-arcana-agent arcana-arca arcana-marketplace arcana-web}"
# What a server error looks like in these logs. NestJS logs every unhandled
# exception through ExceptionsHandler; a query that Postgres refused arrives as
# QueryFailedError; a caller that swallowed a 500 logs the status it received.
PATTERN="${ERROR_WATCH_PATTERN:-ExceptionsHandler|QueryFailedError|Internal server error|UnhandledPromiseRejection}"

mkdir -p "$STATE_DIR"
status=0

for unit in $UNITS; do
  cursor_file="$STATE_DIR/${unit}.cursor"
  args=(--no-pager -o cat -u "$unit" --show-cursor)
  if [ -s "$cursor_file" ]; then
    args+=(--after-cursor "$(cat "$cursor_file")")
  else
    # First run: look back one interval rather than at the whole history, which
    # was already read by a person when this watch was written.
    args+=(--since "-15min")
  fi

  if ! out="$(journalctl "${args[@]}" 2>&1)"; then
    echo "error-watch: cannot read the journal of $unit: $out" >&2
    status=1
    continue
  fi

  new_cursor="$(printf '%s\n' "$out" | sed -n 's/^-- cursor: //p' | tail -1)"
  [ -n "$new_cursor" ] && printf '%s' "$new_cursor" > "$cursor_file"

  hits="$(printf '%s\n' "$out" | grep -v '^-- cursor:' | sed -E 's/\x1b\[[0-9;]*m//g' | grep -E "$PATTERN" || true)"
  [ -z "$hits" ] && continue

  # Grouped by message with ids and timestamps folded, so twenty requests that
  # hit one bug read as one bug seen twenty times.
  summary="$(printf '%s\n' "$hits" \
    | sed -E 's/^.*(ERROR|WARN)[^]]*\] *//; s/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<uuid>/g; s/[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9:.+]+/<ts>/g' \
    | cut -c1-200 | sort | uniq -c | sort -rn | head -8)"
  count="$(printf '%s\n' "$hits" | wc -l | tr -d ' ')"

  echo "error-watch: $unit logged $count server error line(s)"
  if [ -x "$NOTIFY" ]; then
    printf '%s\n\n%s\n' "$summary" "journalctl -u $unit --since '-30min' --no-pager | grep -E '$PATTERN'" \
      | "$NOTIFY" alert high "ARCANA: $unit answered requests with server errors ($count)" || true
  else
    echo "error-watch: NOTIFY MISSING at $NOTIFY — the errors above were not sent" >&2
    status=1
  fi
done

exit "$status"
