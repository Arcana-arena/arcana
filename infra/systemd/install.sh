#!/usr/bin/env bash
# Installs ARCANA systemd units on the VPS.
#
# Usage (run on the VPS from the repo root):
#   bash infra/systemd/install.sh
#
# What it does:
#   1. copies *.service / *.timer into /etc/systemd/system/
#   2. builds the scheduler binary into ~/arcana/scheduler-bin/
#   3. daemon-reload, enables and starts the long-running services
#      (agent, market-data, decision, scoring, marketplace, arca) and EVERY
#      timer in infra/systemd/ — the list is derived from the files rather than
#      written out here, because a hand-kept copy of it had already drifted and
#      left the backup, the restore proof and the tick watchdog disabled.
#
# NOTE: arca-service reads its ARCA_* config (incl. secrets) from
# services/arca-service/.env — create it from .env.example before starting,
# otherwise the service boots healthy but deposits/listener/payouts stay
# disabled by design.
set -euo pipefail

REPO=/home/ubuntu/arcana
UNIT_DIR=/etc/systemd/system
BIN_DIR="$REPO/scheduler-bin"

echo "==> making job wrapper executable"
chmod +x "$REPO/infra/systemd/arca-job.sh"

# Every binary is stamped with the commit it was built from, and reports it on
# /healthz. Restarting a service no longer rebuilds it, so a stale deploy would
# otherwise be invisible — which is exactly how a signer change went missing
# once already.
COMMIT="$(cd "$REPO" && git rev-parse HEAD)"
LDFLAGS="-X main.buildCommit=$COMMIT"
echo "==> building at $COMMIT"

echo "==> building service binaries"
for svc in decision-engine scoring-engine market-data; do
  (cd "$REPO/services/$svc" && /usr/local/go/bin/go build -ldflags "$LDFLAGS" -o "$BIN_DIR/$svc" ./cmd/server)
  echo "    $svc"
done

echo "==> building scheduler binary"
mkdir -p "$BIN_DIR"
(cd "$REPO/services/decision-engine" && /usr/local/go/bin/go build -o "$BIN_DIR/scheduler" ./cmd/scheduler)

# Operator tool, not a scheduled job: it loads historical sessions into
# market_snapshots so /previous and Agent DNA have depth from day one. Built
# here so it is on hand rather than rebuilt from memory at the moment it is
# needed. Everything it writes is marked ingest_mode='backfill' and can never
# carry a scored decision — see docs/market-data.md.
echo "==> building market-data backfill tool"
(cd "$REPO/services/market-data" && /usr/local/go/bin/go build -o "$BIN_DIR/backfill" ./cmd/backfill)

# The vendor API key lives here at mode 600 and is never committed. Created
# empty if absent so the path exists and the permissions are right before anyone
# pastes a key into it.
if [ ! -f "$REPO/services/market-data/.env" ]; then
  echo "==> creating empty services/market-data/.env (mode 600) — add MARKET_VENDOR_API_KEY"
  install -m 600 /dev/null "$REPO/services/market-data/.env"
  printf '# See .env.example. Without a key no snapshot is fetched and no tick opens.\nMARKET_VENDOR_API_KEY=\n' \
    >> "$REPO/services/market-data/.env"
fi
chmod 600 "$REPO/services/market-data/.env"

# The LLM provider key lives here at mode 600 and is never committed. Created
# empty if absent so the path exists and the permissions are right before
# anyone pastes a key into it — the same pattern as the vendor key above.
if [ ! -f "$REPO/.env.llm" ]; then
  echo "==> creating empty .env.llm (mode 600) — add LLM_API_KEY"
  install -m 600 /dev/null "$REPO/.env.llm"
  {
    echo "# Provider key for the LLM decider. See .env.example for the rest."
    echo "# Without it, agents whose strategy_type is llm record a HOLD with"
    echo "# reason llm_unavailable. There is NO fallback to a deterministic"
    echo "# strategy: an agent must not quietly become something it is not."
    echo "LLM_API_KEY="
  } >> "$REPO/.env.llm"
fi
chmod 600 "$REPO/.env.llm"

# The signer is the only component that gets its own Linux identity.
#
# Every other ARCANA service runs as `ubuntu` and can read `ubuntu`s files. The
# signer will hold the keys to wallets containing other peoples money, so its
# seed must not be readable by a process that answers HTTP from the internet.
# If it ran as `ubuntu`, a bug in any of the six public-facing services would be
# a bug that can read the keys.
#
# The seed itself is NOT created here. Creating key material is a deliberate
# act, and doing it as a side effect of running an installer is how a seed ends
# up in a backup nobody meant to take. The service boots without one and refuses
# every signing request, loudly, until somebody puts one there on purpose.
echo "==> signer identity and key directory"
if ! id arcana-signer >/dev/null 2>&1; then
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin arcana-signer
  echo "    created system user arcana-signer (nologin)"
fi
sudo install -d -o arcana-signer -g arcana-signer -m 0700 /etc/arcana/signer
# Nothing the signer needs may live under /home/ubuntu: it cannot traverse the
# application users home, and that is the point rather than an obstacle.
echo "==> building and installing the signer to system paths"
(cd "$REPO/services/signer" && /usr/local/go/bin/go build -ldflags "$LDFLAGS" -o /tmp/arcana-signer ./cmd/server)
sudo install -o root -g root -m 0755 /tmp/arcana-signer /usr/local/bin/arcana-signer
rm -f /tmp/arcana-signer
sudo install -o root -g root -m 0644 "$REPO/services/signer/allowlist/robinhood-mainnet.json" /etc/arcana/signer/allowlist.json

# The shared internal API key, copied where the signer can read it and cannot
# write it. The same secret in two places, each at the permissions its reader
# needs — the alternative is letting a key-holding process read the home
# directory of the user that answers HTTP.
if [ -f "$REPO/.env.auth" ]; then
  sudo install -o root -g arcana-signer -m 0640 /dev/null /etc/arcana/signer/signer.env
  grep -m1 "^INTERNAL_API_KEY=" "$REPO/.env.auth" | sudo tee /etc/arcana/signer/signer.env >/dev/null
  sudo chmod 0640 /etc/arcana/signer/signer.env
  sudo chgrp arcana-signer /etc/arcana/signer/signer.env
fi

echo "==> installing units"
sudo cp "$REPO"/infra/systemd/*.service "$REPO"/infra/systemd/*.timer "$UNIT_DIR/"

# Prune units that no longer exist in the repo.
#
# Adding a unit and removing one are the same operation seen from two sides,
# and only one of them used to be handled. A retired unit left enabled keeps
# firing from /etc/systemd/system long after its file is gone from git, and
# after `daemon-reload` it becomes a dangling symlink in timers.target.wants
# that reports as an error every reload. The payout timer, retired 2026-09-10,
# is the first case this covers.
#
# Scoped to arcana-* so this can never touch a unit ARCANA did not install.
echo "==> pruning units no longer in the repo"
for installed in "$UNIT_DIR"/arcana-*.service "$UNIT_DIR"/arcana-*.timer; do
  [ -e "$installed" ] || continue
  name="$(basename "$installed")"
  if [ ! -e "$REPO/infra/systemd/$name" ]; then
    echo "    removing $name (no longer in infra/systemd/)"
    sudo systemctl disable --now "$name" >/dev/null 2>&1 || true
    sudo rm -f "$installed"
  fi
done

sudo systemctl daemon-reload

# Shared packages FIRST, and this was missing entirely.
#
# All three Node services import @arcana/auth, and they resolve it to that
# package's dist/, not its src/. Nothing here built it. So a change to the
# shared auth package — guards, the error envelope, rate limiting — compiled
# into no service at all, while every service rebuilt successfully against the
# previous dist and reported success.
#
# It is the same trap as `go run` and as the un-rebuilt Node services, one
# level further down, and it is worse than either: those at least left the
# stale code visible in a running process. This one made a correct build of a
# service produce a binary containing last week's shared code, and the
# stamped commit would have said the service was current, because the service
# WAS current. Only its dependency was not.
#
# Fatal rather than warned. A service built against a stale shared package is
# not a partial success, and continuing to build the services on top of it
# would bake the staleness in and stamp it as current.
# ONE failure collector for the whole run, declared before the first thing
# that can fail. It used to be declared halfway down, which meant anything
# failing above it either could not be recorded or was wiped by the later
# assignment.
FAILED_UNITS=""

echo "==> building shared packages"
for pkg in auth; do
  if (cd "$REPO/packages/$pkg" && npm run build >/dev/null 2>&1); then
    echo "    @arcana/$pkg"
  else
    echo "    @arcana/$pkg BUILD FAILED — refusing to build services against a stale package"
    (cd "$REPO/packages/$pkg" && npm run build 2>&1 | tail -20 | sed 's/^/        /')
    FAILED_UNITS="$FAILED_UNITS @arcana/$pkg(build)"
    PKG_FAILED=1
  fi
done

# Build the Node services too. They run from dist/, so a pull that changes
# src/ leaves them running the previous build — the same trap as the Go
# binaries, one language over.
echo "==> building Node services"
for svc in agent-service marketplace arca-service; do
  if [ "${PKG_FAILED:-0}" = "1" ]; then
    echo "    $svc SKIPPED — a shared package failed to build"
    continue
  fi
  if (cd "$REPO/services/$svc" && npm run build >/dev/null 2>&1); then
    # Stamp the build with the commit, the same as the Go binaries.
    #
    # An earlier version compared file mtimes instead, and that cannot work:
    # any git operation that rewrites a file bumps its mtime whether or not
    # the content changed, so `git checkout -- .` alone made every build look
    # stale. A stamp compares what was built, not when.
    echo "$COMMIT" > "$REPO/services/$svc/dist/.build-commit"
    echo "    $svc"
  else
    echo "    $svc BUILD FAILED — it will keep running its previous dist/"
    FAILED_UNITS="$FAILED_UNITS $svc(build)"
  fi
done

echo "==> enabling long-running services"
#
# RESTART, NOT JUST ENABLE. `systemctl enable --now` starts a stopped service
# and does NOTHING to one that is already running — so an installer that only
# enabled would copy new binaries into place and leave every service running
# the old ones, reporting success. That is the third time this script has been
# quietly incomplete: it copied nine timers and enabled five, it never pruned
# units removed from the repo, and it installed binaries nobody was told to
# pick up.
# FAILURES ARE COLLECTED, NOT FATAL — the third way this script was quietly
# incomplete.
#
# With `set -e`, one service failing to restart aborted the whole run: the
# services after it were never restarted, no timer was enabled, and the version
# check at the end never ran. The result was a HALF-DEPLOYED host whose only
# symptom was that the installer stopped printing. Every problem is now
# reported at the end and the exit code still says something went wrong.
for u in arcana-agent arcana-marketdata arcana-decision arcana-scoring arcana-marketplace arcana-arca arcana-signer; do
  sudo systemctl enable "$u.service" >/dev/null 2>&1 || FAILED_UNITS="$FAILED_UNITS $u(enable)"
  sudo systemctl restart "$u.service" || FAILED_UNITS="$FAILED_UNITS $u(restart)"
done

# Enable every timer that was installed, derived from the files themselves.
#
# This used to be a hand-maintained list of five, while nine timer files were
# being copied into place. The four it silently left disabled were
# arcana-backup, arcana-backup-verify, arcana-tick-watchdog and
# arcana-chain-guard — that is, the daily backup, the proof that the backup
# restores, the silent-failure detector, and the contract-drift monitor. Every
# one of them exists because its absence already cost something, and a fresh
# install would have had none of them while reporting success.
#
# Deriving the list from the .timer files makes the installer correct by
# construction: a timer that ships is a timer that is enabled, and adding one
# cannot be half-done again.
echo "==> enabling timers"
for f in "$REPO"/infra/systemd/*.timer; do
  t="$(basename "$f")"
  sudo systemctl enable --now "$t" || FAILED_UNITS="$FAILED_UNITS $t"
done

echo "==> done"
echo
echo "installed timers (expect one line per .timer file in infra/systemd/):"
systemctl list-timers --all --no-legend | grep arcana || true
echo

# Does docs/alerting.md still describe the units that actually alert?
#
# The table there lists every unit carrying OnFailure=. It had drifted in both
# directions at once: it named arcana-arca-payout, deleted with the §10
# retirement, and omitted arcana-chain-guard and arcana-signer, both of which
# do alert. A monitoring document that names a unit which cannot fail, and
# omits one that can, is worse than none — it is a list somebody will check
# against and be reassured by.
#
# Derived from the unit files, so it cannot drift again without being said.
echo
echo "alerting doc vs units that actually declare OnFailure:"
ALERT_DRIFT=0
for f in "$REPO"/infra/systemd/*.service; do
  n="$(basename "$f" .service)"
  case "$n" in arcana-alert@) continue ;; esac
  grep -q "^OnFailure=" "$f" || continue
  if ! grep -q "\`$n\`" "$REPO/docs/alerting.md"; then
    echo "    MISSING from docs/alerting.md: $n alerts on failure and is not listed"
    ALERT_DRIFT=1
  fi
done
# TABLE ROWS ONLY — and note the escaped pipe.
#
# An unescaped `^|` is not "start of line, then a pipe". In ERE it is an
# alternation with an empty left branch: start-of-line OR nothing, which
# matches every line in the file. The check went on reporting drift that was
# not there, and looked like it was working.
#
# Matching the name anywhere in the document made the check
# flag its own explanation: the prose describing why arcana-arca-payout was
# removed counts as a mention. A check that fires on the text written to record
# a fix is a check that gets deleted.
for n in $(grep -oE '^\| `arcana-[a-z@-]+`' "$REPO/docs/alerting.md" | grep -oE 'arcana-[a-z@-]+' | sort -u); do
  case "$n" in arcana-alert@) continue ;; esac
  if [ ! -e "$REPO/infra/systemd/$n.service" ]; then
    echo "    STALE in docs/alerting.md: $n has no unit file"
    ALERT_DRIFT=1
  fi
done
[ "$ALERT_DRIFT" = 0 ] && echo "    in step"
sleep 5
echo "deployed version check:"
bash "$REPO/infra/verify/deployed-version-verify.sh" || true
echo
echo "any arcana unit in a failed state:"
systemctl list-units --failed --no-legend | grep arcana || echo "  none"

if [ -n "$FAILED_UNITS" ]; then
  echo
  echo "INSTALL INCOMPLETE — these did not come up:$FAILED_UNITS"
  echo "The rest of the install still ran, so the host is not half-configured;"
  echo "but something above needs looking at before this counts as deployed."
  exit 1
fi
