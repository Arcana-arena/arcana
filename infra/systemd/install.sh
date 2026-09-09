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
#      (agent, market-data, decision, scoring, marketplace, arca) and the four
#      timers (scheduler, scoring batch, $ARCA reminder, $ARCA payout).
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

echo "==> installing units"
sudo cp "$REPO"/infra/systemd/*.service "$REPO"/infra/systemd/*.timer "$UNIT_DIR/"
sudo systemctl daemon-reload

echo "==> enabling long-running services"
for u in arcana-agent arcana-marketdata arcana-decision arcana-scoring arcana-marketplace arcana-arca; do
  sudo systemctl enable --now "$u.service"
done

echo "==> enabling timers"
for t in arcana-scheduler arcana-scoring-job arcana-arca-reminder arcana-arca-payout arcana-agent-dna; do
  sudo systemctl enable --now "$t.timer"
done

echo "==> done"
systemctl list-timers --no-legend | grep arcana || true
