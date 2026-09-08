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
