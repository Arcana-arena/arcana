#!/usr/bin/env bash
# Runs one arca-service batch job over HTTP and translates the result into an
# exit status systemd can act on.
#
# Usage: arca-job.sh <job-name> <url>
#
# The distinction this script exists to make:
#
#   deliberately disabled  -> exit 0, logged as a skip. The $ARCA token has not
#                             launched, the env is intentionally empty, and the
#                             job refusing to move money is correct behaviour.
#                             A daily "failed" unit for a year would train
#                             everyone to ignore this timer.
#   genuinely broken       -> exit non-zero, logged to stderr. Service down,
#                             HTTP 5xx, malformed reply.
#
# Plain `curl -fsS` cannot make that call: both cases return 2xx, and the
# difference is inside the JSON body.
set -uo pipefail

JOB="${1:?job name required}"
URL="${2:?url required}"

# Every /internal/ endpoint is machine-tier and requires this header. A missing
# key is reported here rather than left to surface as an opaque 503 body: the
# services answer 503 auth_unavailable without it, which is deliberately NOT a
# permission error, and the operator needs to read it as configuration.
if [ -z "${INTERNAL_API_KEY:-}" ]; then
  echo "$JOB: INTERNAL_API_KEY is not set — the machine tier cannot be called. Set it in /home/ubuntu/arcana/.env.auth (mode 600)." >&2
  exit 1
fi

response=$(curl -sS --max-time 120 -X POST -H "X-Internal-Key: $INTERNAL_API_KEY" -w $'\n%{http_code}' "$URL" 2>&1)
curl_status=$?

http_code=$(printf '%s' "$response" | tail -n 1)
body=$(printf '%s' "$response" | sed '$d')

if [ "$curl_status" -ne 0 ] || ! printf '%s' "$http_code" | grep -qE '^[0-9]{3}$'; then
  echo "$JOB: arca-service unreachable (curl exit $curl_status): $response" >&2
  exit 1
fi

if [ "$http_code" -ge 400 ]; then
  echo "$JOB: HTTP $http_code from $URL: $body" >&2
  exit 1
fi

# A job reports a deliberate stand-down in its `skipped` array rather than by
# failing, e.g. {"reminded":0,"skipped":["... disabled: ... not configured"]}.
#
# The payout batch used to be the example here. It was retired on 2026-09-10
# with the rest of the treasury/split model: the marketplace is P2P with no fee,
# so ARCANA never holds or splits a payment and has nothing to pay out. The
# remaining callers are the scoring batch, the DNA batch and the $ARCA
# reminder, all of which touch only the database.
if printf '%s' "$body" | grep -q 'disabled'; then
  echo "$JOB: SKIPPED (feature disabled by configuration, expected until the \$ARCA token launches): $body"
  exit 0
fi

echo "$JOB: ok $body"
exit 0
