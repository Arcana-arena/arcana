#!/usr/bin/env bash
# deployed-version-verify.sh — is the code that is RUNNING the code that is
# CHECKED OUT?
#
# THE TRAP THIS CLOSES. The Go services used to run under `go run`, which
# recompiled on every start, so restarting a service was the same as deploying
# it. They now run built binaries — faster, one process instead of two, and
# systemd supervising the service rather than the compiler — but that breaks the
# equivalence: `git pull && systemctl restart` keeps running the old code, and
# says nothing about it.
#
# That is not hypothetical. It happened in this repo the day the signer was
# installed: a preflight change simply did not take effect, and the only symptom
# was a log line that never appeared. Nothing failed. Nothing was reported. The
# service was healthy and wrong.
#
# So every Go binary is stamped at link time with the commit it was built from
# and reports it on /healthz, and this compares that against the repository.
#
# The Node services carry the same stamp, written into dist/.build-commit by
# the installer. They cannot report it over HTTP without a code change in each
# service, so it is read from disk instead — weaker in that a stamp could in
# principle outlive the build it names, and stated rather than glossed.
#
# ---------------------------------------------------------------------------
# WHY THIS NO LONGER COMPARES AGAINST HEAD
#
# It did, and that was wrong in a way worth spelling out, because the failure
# mode is one this project keeps meeting.
#
# A commit that touches only documentation moves HEAD. Every stamp then
# disagrees with HEAD, so all seven checks fail and demand a full rebuild of
# every service — while the binaries are, in fact, exactly correct. The rebuild
# is the trivial cost. The real cost is that an operator learns the failure is
# usually noise, and the next time it is real they skip past it. This repo has
# already produced a false WIB alarm, a suite that failed on a healthy system,
# and an `^|` regex that matched every line; each one trained somebody to look
# away.
#
# So the question is asked properly: **has any commit touched THIS service's
# code since the binary was built?** Concretely, the last commit touching the
# service's own source paths must be an ancestor of (or equal to) the stamp,
# and the stamp must itself be reachable from HEAD. A docs commit changes no
# service's source paths, so nothing goes stale and nothing is rebuilt.
#
# Markdown is excluded from every service's paths on purpose: a README living
# inside services/signer/ is documentation wherever it sits.
#
# The two failure modes stay distinct, because they call for different actions:
#   - STALE      the code moved and the binary did not  -> run install.sh
#   - UNRELATED  the stamp is not in this history at all -> a build from a
#                branch, a reset, or a hand-copied binary. install.sh will
#                paper over it; find out why first.
#
# Read-only.
#
# Usage:  bash infra/verify/deployed-version-verify.sh
# Exits non-zero if anything running is not what is checked out.

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

HEAD="$(git rev-parse HEAD 2>/dev/null)"
SHORT="${HEAD:0:12}"
pass=0; fail=0

ok() { printf '  PASS  %s\n' "$1"; pass=$((pass+1)); }
no() { printf '  FAIL  %s — %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

if [ -z "$HEAD" ]; then
  echo "deployed-version-verify: not a git repository — nothing can be compared." >&2
  exit 1
fi

# A shallow clone cannot answer an ancestry question, and answering it wrongly
# would be worse than refusing. Say so rather than passing everything.
if [ -f .git/shallow ]; then
  echo "deployed-version-verify: SHALLOW CLONE — ancestry is unknowable here." >&2
  echo "  Run 'git fetch --unshallow' before trusting this suite." >&2
  exit 1
fi

# The source paths that actually go into each artifact. Shared packages are
# listed with the services that link them: a change in packages/auth is a
# change in all three Node services, and go-internalauth in all four Go ones.
paths_for() {
  case "$1" in
    decision-engine)   echo "services/decision-engine packages/go-internalauth go.work" ;;
    scoring-engine)    echo "services/scoring-engine packages/go-internalauth go.work" ;;
    market-data)       echo "services/market-data packages/go-internalauth go.work" ;;
    signer)            echo "services/signer packages/go-internalauth go.work" ;;
    # The position guard is built from the decision-engine module, so any change
    # there is a change to it. Listed explicitly rather than folded into
    # decision-engine: they are two binaries, deployed together and restarted
    # separately, and a check that cannot name one of them cannot report on it.
    arcana-guard)      echo "services/decision-engine packages/go-internalauth go.work" ;;
    agent-service)     echo "services/agent-service packages/auth" ;;
    marketplace-service) echo "services/marketplace packages/auth" ;;
    arca-service)      echo "services/arca-service packages/auth" ;;
    web)               echo "services/web" ;;
    *)                 echo "" ;;
  esac
}

# Last commit that touched this service's code. Markdown excluded — see above.
last_code_commit() {
  local name="$1"
  local p; p="$(paths_for "$name")"
  [ -z "$p" ] && return 1
  # shellcheck disable=SC2086
  git log -1 --format=%H -- $p ':(exclude)*.md' 2>/dev/null
}

# The whole judgement, in one place, so the self-test below exercises the same
# code the real checks do rather than a re-implementation of it.
#   0 current   1 stale   2 unrelated-history   3 cannot determine
judge() {
  local stamp="$1" name="$2" code
  code="$(last_code_commit "$name")" || return 3
  [ -z "$code" ] && return 3
  git cat-file -e "${stamp}^{commit}" 2>/dev/null || return 2
  git merge-base --is-ancestor "$stamp" "$HEAD" 2>/dev/null || return 2
  git merge-base --is-ancestor "$code" "$stamp" 2>/dev/null || return 1
  return 0
}

report() {
  local name="$1" stamp="$2" what="$3"
  local code short_code
  code="$(last_code_commit "$name")"
  short_code="${code:0:12}"
  judge "$stamp" "$name"
  case $? in
    0) if [ "$stamp" = "$HEAD" ]; then
         ok "$name $what ${stamp:0:12} — matches HEAD"
       else
         ok "$name $what ${stamp:0:12} — no code change since (last touched by $short_code)"
       fi ;;
    1) no "$name is current" \
          "$what ${stamp:0:12}, but its code was changed by $short_code. STALE — run infra/systemd/install.sh" ;;
    2) no "$name is current" \
          "$what ${stamp:0:12}, which is not an ancestor of HEAD ($SHORT). UNRELATED HISTORY — find out why before rebuilding" ;;
    *) no "$name is current" "cannot determine the last code commit for $name" ;;
  esac
}

echo "deployed-version-verify: HEAD is $SHORT"
echo

echo "=== Go services report the commit they were built from ==="
check_go() {
  local name="$1" port="$2"
  local body commit
  body="$(curl -s --max-time 6 "http://127.0.0.1:${port}/healthz" 2>/dev/null)"
  if [ -z "$body" ]; then
    no "$name is answering" "no response on :$port"
    return
  fi
  commit="$(printf '%s' "$body" | sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p')"
  if [ -z "$commit" ]; then
    no "$name reports a commit" "healthz has no commit field — an old binary, from before stamping"
    return
  fi
  report "$name" "$commit" "runs"
}
check_go decision-engine 8081
check_go scoring-engine  8082
check_go market-data     8083
check_go signer          8085

# THE POSITION GUARD HAS NO /healthz, so its heartbeat is checked instead.
#
# It is a long-running process that serves no HTTP: the row it writes on every
# scan is the only thing it publishes, and it is exactly what /healthz is for
# everything else. Checking it any less strictly would leave the one process
# that never stops as the one process whose staleness cannot be seen.
#
# A stale heartbeat is arcana-guard-watchdog's problem, not this file's. This
# asks the other question: is the binary that wrote it the one in the tree.
check_guard() {
  local name="arcana-guard" commit
  commit="$(docker exec "${PG_CONTAINER:-arcana-postgres}" psql -U arcana -d arcana -tAc \
    "SELECT coalesce(version,'') FROM guard_heartbeat WHERE id = 1" 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$commit" ]; then
    no "$name reports a build commit" \
      "guard_heartbeat has no version — the guard has never scanned, or is a binary from before stamping"
    return
  fi
  if [ "$commit" = "unknown" ]; then
    no "$name reports a build commit" \
      "the guard reports 'unknown': it was built without -X main.buildCommit"
    return
  fi
  report "$name" "$commit" "runs"
}
check_guard

echo
echo "=== Node services report the commit they were built from ==="
check_node() {
  local name="$1" dir="$2" port="$3" out="${4:-dist}"
  local stamp
  if ! curl -s -o /dev/null --max-time 6 "http://127.0.0.1:${port}/healthz"; then
    no "$name is answering" "no response on :$port"
    return
  fi
  # A STAMP, not a timestamp.
  #
  # This compared mtimes at first, and that cannot work: any git operation
  # that rewrites a file bumps its mtime whether or not the content changed,
  # so `git checkout -- .` alone made a correct build look stale. A check that
  # cries wolf is worse than no check — the next real staleness reads as more
  # of the same.
  stamp="$(cat "$dir/$out/.build-commit" 2>/dev/null)"
  if [ -z "$stamp" ]; then
    no "$name reports a build commit" "$dir/$out/.build-commit missing — built before stamping, or not built"
    return
  fi
  report "$name" "$stamp" "built from"

  # AND IS THE RUNNING PROCESS THAT BUILD?
  #
  # THE GAP THIS CLOSES, found the hard way. A stamp says what was BUILT. A
  # Node service reads its build once, at boot — `next start` serves whatever
  # .next held when it started. So a deploy that built, stamped, and did not
  # restart passed every check here while the public surface served a build
  # from hours earlier, and the installer's hand-maintained restart list had
  # quietly omitted arcana-web for exactly that long.
  #
  # Comparing the SERVICE START against the STAMP FILE's mtime catches it: a
  # process that started before its own build cannot be running it. This is not
  # the mtime comparison the block above rejects — that one compared source
  # files, which git rewrites for its own reasons. A stamp file is written by
  # the installer and by nothing else.
  local unit="${5:-}"
  [ -z "$unit" ] && return
  local started built
  started="$(systemctl show "$unit" -p ActiveEnterTimestamp --value 2>/dev/null)"
  built="$(stat -c %y "$dir/$out/.build-commit" 2>/dev/null)"
  if [ -z "$started" ] || [ -z "$built" ]; then
    no "$name is running the build it was stamped with" \
       "could not compare: started='${started:-unknown}' built='${built:-unknown}'"
    return
  fi
  local started_s built_s
  started_s="$(date -d "$started" +%s 2>/dev/null)"
  built_s="$(date -d "$built" +%s 2>/dev/null)"
  if [ -z "$started_s" ] || [ -z "$built_s" ]; then
    no "$name is running the build it was stamped with" "could not parse the timestamps"
  elif [ "$started_s" -lt "$built_s" ]; then
    no "$name is running the build it was stamped with" \
       "the build is newer than the process: built $built, started $started. It is serving the PREVIOUS build — restart $unit"
  else
    ok "$name started after its build — it is running what it was stamped with"
  fi
}
check_node agent-service       services/agent-service       3001 dist  arcana-agent
check_node marketplace-service services/marketplace         3002 dist  arcana-marketplace
check_node arca-service        services/arca-service        3004 dist  arcana-arca
# THE WEB SURFACE HAS THE SAME TRAP AND WAS NOT WATCHED FOR IT. `next start`
# serves whatever .next holds, so a pull plus a restart serves the old code
# while every configuration file says the new thing. That happened: the sign-in
# page kept refusing a domain that had already been corrected, and nothing
# anywhere said the build was behind.
check_node web                 services/web                 3000 .next arcana-web

echo
echo "=== The page a visitor gets is the build that was deployed ==="
#
# THE CHECK THAT WOULD HAVE CAUGHT IT, and the reason every other check here is
# not enough.
#
# Everything above compares artefacts on DISK. A stamp says what was built; a
# start time says a process began after its build. Neither asks the question a
# visitor's browser asks, and there are at least four ways to pass all of them
# and still serve something else:
#
#   * a process that rebuilt its manifests under itself and kept serving the
#     pages it had already loaded
#   * a reverse proxy answering from its own cache
#   * a second process on another port that the public listener actually points
#     at
#   * a build whose stamp was written while the bundle failed to update
#
# All of those are invisible from the filesystem. So this asks the ORIGIN — the
# address a person types — and compares what comes back against the commit that
# is supposed to be running. The identity is compiled into the bundle by
# next.config.mjs, so a stale process can only report the stale commit; a value
# read from disk at request time would have let it report the new one.
#
# It is checked at BOTH the public origin and the loopback, because the two
# failures are different and need different fixes: loopback stale means the
# process was never restarted, loopback fresh + origin stale means something in
# front of it is serving its own copy.
served_build() {
  # Header first — it survives a page that fails to render, which is exactly
  # when knowing which build answered matters most. Falls back to the JSON.
  local url="$1" hdr
  hdr="$(curl -s -I --max-time 12 "$url/" 2>/dev/null | tr -d '\r' \
        | awk -F': ' 'tolower($1)=="x-arcana-build"{print $2}' | head -1)"
  if [ -n "$hdr" ]; then printf '%s' "$hdr"; return 0; fi
  curl -s --max-time 12 "$url/api/build" 2>/dev/null \
    | sed -n 's/.*"build_commit":"\([^"]*\)".*/\1/p' | head -1
}

check_served() {
  local label="$1" url="$2" served
  served="$(served_build "$url")"
  if [ -z "$served" ]; then
    no "$label says which build it is" \
       "no x-arcana-build header and no /api/build at $url — a surface that cannot identify itself cannot be checked"
    return
  fi
  if [ "$served" = "unknown" ]; then
    no "$label says which build it is" \
       "it reports 'unknown': built outside a git checkout, so nothing can tell whether it is current"
    return
  fi
  # The same judgement the disk checks use, against the same rules: current if
  # nothing in services/web has changed since the served commit.
  judge "$served" "web"
  case $? in
    0) ok "$label serves ${served:0:12} — current" ;;
    1) no "$label serves the wrong build" \
          "it is serving ${served:0:12}, and services/web has changed since. A VISITOR IS LOOKING AT OLD CODE — restart arcana-web" ;;
    2) no "$label serves an unrelated build" "${served:0:12} is not an ancestor of HEAD" ;;
    *) no "$label could be judged" "no commit touches services/web, so there is nothing to compare against" ;;
  esac
}

check_served "the loopback surface" "http://127.0.0.1:3000"

# WHERE A PERSON ACTUALLY GOES, derived from the unit that configures the
# service rather than from whatever happens to be exported into this shell. A
# check that silently skips because a variable was not set is the shape of
# failure this file exists against, and requiring an operator to remember an
# export is how that happens.
ORIGIN="${PUBLIC_ORIGIN:-}"
if [ -z "$ORIGIN" ] && [ -f infra/systemd/arcana-web.service ]; then
  ORIGIN="$(sed -n 's/^Environment=PUBLIC_ORIGIN=//p' infra/systemd/arcana-web.service | head -1)"
fi
# PUBLIC_ORIGIN is where a person actually goes. Absent, this is skipped LOUDLY
# rather than silently — a check that quietly does not run is the shape of
# failure this whole file exists against.
if [ -n "$ORIGIN" ]; then
  check_served "the public origin" "$ORIGIN"
else
  no "the public origin was checked" \
     "no PUBLIC_ORIGIN in the environment or in infra/systemd/arcana-web.service, so the address a visitor uses was never asked. Every check above reads this machine's disk; none of them can see a proxy serving its own copy."
fi

echo
echo "=== The check can still refuse ==="
# A relaxed check that never refuses anyone is the thing this repo has been
# bitten by three times. Loosening HEAD to "no code change since" is exactly
# the kind of relaxation that can quietly become "always passes", so it is
# proved here against the real judge(), not asserted in a comment.
selftest() {
  local label="$1" stamp="$2" name="$3" want="$4"
  judge "$stamp" "$name"; local got=$?
  if [ "$got" = "$want" ]; then
    ok "$label"
  else
    no "$label" "judge() returned $got, expected $want"
  fi
}
# The commit that introduced the signer is, by construction, older than the
# last commit to touch services/signer. A binary stamped with it must read as
# stale, or this suite is decorative.
signer_first="$(git log --format=%H --reverse -- services/signer 2>/dev/null | head -1)"
signer_last="$(last_code_commit signer)"
if [ -n "$signer_first" ] && [ -n "$signer_last" ] && [ "$signer_first" != "$signer_last" ]; then
  selftest "a binary stamped before its own code changed reads STALE" "$signer_first" signer 1
else
  ok "signer has exactly one code commit — nothing older to test against (not a failure)"
fi
selftest "a stamp that is not a commit at all reads UNRELATED" \
  "0000000000000000000000000000000000000000" signer 2
selftest "HEAD itself always reads current" "$HEAD" signer 0

echo
echo "=== The working tree is what was committed ==="
if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
  ok "no uncommitted changes on the host"
else
  no "the host working tree is clean" "uncommitted changes — what runs may never have been reviewed"
  git status --short | head -5 | sed 's/^/        /'
fi

echo
echo "deployed-version-verify: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ] || exit 1
echo "deployed-version-verify: what is running is what is checked out."
