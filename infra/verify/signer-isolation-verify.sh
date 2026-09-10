#!/usr/bin/env bash
# signer-isolation-verify.sh — prove the separation is a fact, not a diagram.
#
# The signer runs as its own Linux user because it will hold the keys to wallets
# containing other people's money. Every other ARCANA service runs as `ubuntu`.
# If the seed were readable by `ubuntu`, a bug in any of the six public-facing
# services would be a bug that can read the keys — and this whole component
# would be theatre.
#
# So the claim is checked by TRYING: read the seed as the user the other
# services actually run as, and require the attempt to fail.
#
# Read-only. It reads file modes and attempts one read that must be denied.
#
# Usage:  bash infra/verify/signer-isolation-verify.sh
# Exits non-zero if any part of the isolation is not real.

set -uo pipefail

SEED="${SIGNER_MASTER_SEED_FILE:-/etc/arcana/signer/master.key}"
SIGNER_USER="${SIGNER_USER:-arcana-signer}"
OTHER_USER="${OTHER_USER:-ubuntu}"
UNIT=arcana-signer.service

pass=0; fail=0
ok()  { printf '  PASS  %s\n' "$1"; pass=$((pass+1)); }
no()  { printf '  FAIL  %s — %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

echo "signer-isolation-verify: seed=$SEED signer=$SIGNER_USER others=$OTHER_USER"
echo

echo "=== 1. The signer has its own identity ==="
if id "$SIGNER_USER" >/dev/null 2>&1; then
  ok "user $SIGNER_USER exists"
else
  no "user $SIGNER_USER exists" "not found"
fi
shell="$(getent passwd "$SIGNER_USER" | cut -d: -f7)"
case "$shell" in
  */nologin|*/false) ok "it cannot log in (shell=$shell)" ;;
  "")                no "it cannot log in" "no passwd entry" ;;
  *)                 no "it cannot log in" "shell=$shell — a login shell on a key-holding account" ;;
esac
if [ "$(id -u "$SIGNER_USER" 2>/dev/null)" != "0" ]; then
  ok "it is not root"
else
  no "it is not root" "uid 0"
fi

echo
echo "=== 2. The seed belongs to the signer and to nobody else ==="
if [ -e "$SEED" ]; then
  ok "the seed exists"
  mode="$(stat -c '%a' "$SEED")"
  owner="$(stat -c '%U' "$SEED")"
  if [ "$mode" = "400" ] || [ "$mode" = "600" ]; then
    ok "its mode is $mode — no group, no others"
  else
    no "its mode is 0400 or 0600" "mode is $mode"
  fi
  if [ "$owner" = "$SIGNER_USER" ]; then
    ok "it is owned by $SIGNER_USER"
  else
    no "it is owned by $SIGNER_USER" "owned by $owner"
  fi
  dirmode="$(stat -c '%a' "$(dirname "$SEED")")"
  if [ "${dirmode:2:1}" = "0" ]; then
    ok "its directory is not world-accessible (mode $dirmode)"
  else
    no "its directory is not world-accessible" "mode $dirmode"
  fi
else
  no "the seed exists" "$SEED not found — the signer is inactive and holds nothing"
fi

echo
echo "=== 3. The user every OTHER service runs as cannot read it ==="
echo "    (this is the claim; everything above is only the setup for it)"
if [ -e "$SEED" ]; then
  if sudo -n -u "$OTHER_USER" cat "$SEED" >/dev/null 2>&1; then
    no "$OTHER_USER is DENIED read access to the seed" \
       "it read the file — every ARCANA service could read the keys"
  else
    ok "$OTHER_USER is denied read access to the seed"
  fi
  # And the directory, so a future file dropped beside it inherits the answer.
  if sudo -n -u "$OTHER_USER" ls "$(dirname "$SEED")" >/dev/null 2>&1; then
    no "$OTHER_USER cannot even list the directory" "it listed $(dirname "$SEED")"
  else
    ok "$OTHER_USER cannot even list the directory"
  fi
fi

echo
echo "=== 4. The unit runs as the signer, not as ubuntu ==="
u="$(systemctl show "$UNIT" -p User --value 2>/dev/null)"
if [ "$u" = "$SIGNER_USER" ]; then
  ok "$UNIT runs as $SIGNER_USER"
else
  no "$UNIT runs as $SIGNER_USER" "User=$u"
fi
for setting in NoNewPrivileges ProtectSystem PrivateTmp MemoryDenyWriteExecute; do
  v="$(systemctl show "$UNIT" -p "$setting" --value 2>/dev/null)"
  case "$v" in
    yes|strict|full) ok "$setting=$v" ;;
    *)               no "$setting is set" "$setting=$v" ;;
  esac
done

echo
echo "=== 5. It listens only on loopback ==="
if systemctl is-active --quiet "$UNIT"; then
  if ss -tlnp 2>/dev/null | grep -q '127\.0\.0\.1:8085'; then
    ok "bound to 127.0.0.1:8085"
  else
    no "bound to 127.0.0.1 only" "$(ss -tln 2>/dev/null | grep 8085 || echo 'not listening')"
  fi
else
  echo "  SKIP  $UNIT is not running"
fi

echo
echo "signer-isolation-verify: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ] || exit 1
echo "signer-isolation-verify: the separation holds — the key user's files are not readable by the service user."
