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
# The internal API key is shared, so the signer must be able to READ it without
# being able to write it, and without it being world-readable.
if [ -f "$REPO/.env.auth" ]; then
  sudo chgrp arcana-signer "$REPO/.env.auth" 2>/dev/null || true
  sudo chmod 640 "$REPO/.env.auth"
fi

echo "==> building signer binary"
(cd "$REPO/services/signer" && /usr/local/go/bin/go build -o "$BIN_DIR/signer" ./cmd/server)

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

echo "==> enabling long-running services"
for u in arcana-agent arcana-marketdata arcana-decision arcana-scoring arcana-marketplace arcana-arca arcana-signer; do
  sudo systemctl enable --now "$u.service"
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
  sudo systemctl enable --now "$t"
done

echo "==> done"
echo
echo "installed timers (expect one line per .timer file in infra/systemd/):"
systemctl list-timers --all --no-legend | grep arcana || true
echo
echo "any arcana unit in a failed state:"
systemctl list-units --failed --no-legend | grep arcana || echo "  none"
