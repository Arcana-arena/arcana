#!/usr/bin/env bash
# arcana-seed-restore-test.sh — prove a seed REPRODUCES the wallets, instead of
# assuming it does.
#
# A backup that has never been restored is not a backup, and a seed that has
# never been re-loaded is a seed nobody has proven still derives the wallets it
# is supposed to derive (docs/signer.md makes the same argument for
# arcana-restore-test.sh, which counts rows rather than claiming success).
#
# HOW IT PROVES IT, and why that is the honest way: it starts a SECOND signer
# instance in a sandbox, pointed at a COPY of the seed, and asks that instance
# for the address of a real agent id. It then asks the LIVE signer (or, if that
# is down, reads the address agent-service recorded) for the same agent's
# address. Equal addresses mean the seed material reproduces the wallets — and
# nothing is touched on the way: the live signer is only read, the copy is
# shredded on exit, and the sandbox instance is pointed at a dead RPC so it
# cannot learn anything from the chain it does not need.
#
# WHAT THIS DOES NOT PROVE: that a backup copy survived being stored somewhere
# else. That is a human act — copy the artifact, then run this against a
# restored copy.
#
# Usage: arcana-seed-restore-test.sh [--seed FILE | --from-encrypted FILE]
#                                    [--agent UUID] [--port N] [--passphrase-file FILE]
#   --seed            a plaintext seed file (default: the live seed path)
#   --from-encrypted  an openssl artifact produced by arcana-seed-backup.sh;
#                     the passphrase comes from SEED_BACKUP_PASSPHRASE or
#                     --passphrase-file, and is never written to disk
#   --agent           which agent id to derive for (default: the first agent
#                     with a wallet address in the database)
# Exit codes: 0 the seed reproduces the wallets · 1 it does not, or a safety check refused

set -uo pipefail

SEED_FILE="${SIGNER_MASTER_SEED_FILE:-/etc/arcana/signer/master.key}"
ENCRYPTED=""
PASS_FILE=""
AGENT=""
PORT="${DRILL_PORT:-8099}"
BIN="${SIGNER_BIN:-/usr/local/bin/arcana-signer}"
ALLOWLIST="${SIGNER_ALLOWLIST_FILE:-/etc/arcana/signer/allowlist.json}"
LIVE_SIGNER="${LIVE_SIGNER_URL:-http://127.0.0.1:8085}"
ENV_AUTH="${ENV_AUTH_FILE:-/home/ubuntu/arcana/.env.auth}"
PG_URL="${DATABASE_URL:-postgres://arcana:arcana@localhost:5432/arcana}"

log() { echo "seed-restore-test: $*"; }
die() { echo "seed-restore-test: ERROR: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --seed)             SEED_FILE="${2:?}"; shift 2 ;;
    --from-encrypted)   ENCRYPTED="${2:?}"; shift 2 ;;
    --passphrase-file)  PASS_FILE="${2:?}"; shift 2 ;;
    --agent)            AGENT="${2:?}"; shift 2 ;;
    --port)             PORT="${2:?}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" = "0" ] || die "must run as root: the seed is 0400 and its directory is 0700"
[ -x "$BIN" ] || die "signer binary $BIN is not executable"
[ -r "$ALLOWLIST" ] || die "allowlist $ALLOWLIST is not readable"

WORK="$(mktemp -d)"
SANDBOX_PID=""
cleanup() {
  [ -n "$SANDBOX_PID" ] && kill "$SANDBOX_PID" 2>/dev/null
  [ -f "$WORK/seed.key" ] && { shred -u "$WORK/seed.key" 2>/dev/null || rm -f "$WORK/seed.key"; }
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- 1. materialise the seed under test --------------------------------------
if [ -n "$ENCRYPTED" ]; then
  [ -r "$ENCRYPTED" ] || die "cannot read $ENCRYPTED"
  if [ -n "$PASS_FILE" ]; then
    [ -r "$PASS_FILE" ] || die "cannot read passphrase file $PASS_FILE"
    SEED_BACKUP_PASSPHRASE="$(cat "$PASS_FILE")"
  fi
  [ -n "${SEED_BACKUP_PASSPHRASE:-}" ] || die "no passphrase: set SEED_BACKUP_PASSPHRASE or pass --passphrase-file"
  export SEED_BACKUP_PASSPHRASE
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
    -in "$ENCRYPTED" -out "$WORK/seed.key" -pass env:SEED_BACKUP_PASSPHRASE \
    || die "cannot decrypt $ENCRYPTED (wrong passphrase, or not an arcana-seed-backup.sh artifact)"
  log "seed under test: decrypted copy of $ENCRYPTED"
else
  [ -r "$SEED_FILE" ] || die "cannot read seed $SEED_FILE"
  cp "$SEED_FILE" "$WORK/seed.key" || die "cannot copy seed"
  log "seed under test: copy of $SEED_FILE"
fi
chmod 0400 "$WORK/seed.key"

# --- 2. decide the agent and the reference address ---------------------------
if [ -z "$AGENT" ]; then
  AGENT="$(psql "$PG_URL" -Atc "SELECT agent_id FROM agent_wallets WHERE address <> '' ORDER BY agent_id LIMIT 1")"
  [ -n "$AGENT" ] || die "no agent with a wallet address in the database; pass --agent"
fi
log "agent: $AGENT"

REF=""
REF_SRC=""
LIVE_KEY=""
if [ -r "$ENV_AUTH" ]; then
  LIVE_KEY="$(grep -o 'INTERNAL_API_KEY=.*' "$ENV_AUTH" | head -1 | cut -d= -f2-)"
fi
if [ -n "$LIVE_KEY" ]; then
  LIVE_ADDR="$(curl -s -m 5 -H "X-Internal-Key: $LIVE_KEY" "$LIVE_SIGNER/internal/v1/signer/wallets/$AGENT" \
    | grep -o '"address":"[^"]*"' | cut -d'"' -f4)"
  if [ -n "$LIVE_ADDR" ]; then
    REF="$LIVE_ADDR"; REF_SRC="live signer"
  fi
fi
if [ -z "$REF" ]; then
  REF="$(psql "$PG_URL" -Atc "SELECT address FROM agent_wallets WHERE agent_id = '$AGENT'")"
  [ -n "$REF" ] || die "no reference address: the live signer did not answer and the database has no row for $AGENT"
  REF_SRC="agent_wallets row (a record, not a live derivation — the live signer was unreachable)"
fi
log "reference address: $REF"
log "reference source:  $REF_SRC"

# --- 3. a sandbox signer loaded with the seed under test ---------------------
DRILL_KEY="seed-drill-$$"
env \
  SIGNER_MASTER_SEED_FILE="$WORK/seed.key" \
  SIGNER_ALLOWLIST_FILE="$ALLOWLIST" \
  SIGNER_SIGNATURE_COUNT_FILE="$WORK/signatures.json" \
  SIGNER_RPC_URLS="http://127.0.0.1:1" \
  INTERNAL_API_KEY="$DRILL_KEY" \
  PORT="$PORT" \
  "$BIN" > "$WORK/signer.log" 2>&1 &
SANDBOX_PID=$!

for _ in $(seq 1 40); do
  if curl -s -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  kill -0 "$SANDBOX_PID" 2>/dev/null || { cat "$WORK/signer.log" >&2; die "sandbox signer exited"; }
  sleep 0.5
done
grep -q '"status":"ok"' <(curl -s -m 2 "http://127.0.0.1:$PORT/healthz") || { cat "$WORK/signer.log" >&2; die "sandbox signer did not come up on port $PORT"; }

ACTIVE_LINE="$(grep -m1 'signer ACTIVE' "$WORK/signer.log" || true)"
[ -n "$ACTIVE_LINE" ] || { cat "$WORK/signer.log" >&2; die "sandbox signer came up without a keyring"; }
log "sandbox: $(echo "$ACTIVE_LINE" | sed 's/^[0-9\/: ]*//')"

GOT="$(curl -s -m 5 -H "X-Internal-Key: $DRILL_KEY" "http://127.0.0.1:$PORT/internal/v1/signer/wallets/$AGENT" \
  | grep -o '"address":"[^"]*"' | cut -d'"' -f4)"
[ -n "$GOT" ] || { cat "$WORK/signer.log" >&2; die "sandbox signer did not return an address for $AGENT"; }
log "derived address:   $GOT"

# --- 4. verdict ---------------------------------------------------------------
echo
if [ "$GOT" = "$REF" ]; then
  echo "seed-restore-test: PASS — the seed under test reproduces the wallet."
  echo "seed-restore-test: $AGENT derives $GOT, matching the $REF_SRC."
  exit 0
fi
echo "seed-restore-test: FAIL — addresses differ." >&2
echo "seed-restore-test:   seed under test → $GOT" >&2
echo "seed-restore-test:   $REF_SRC → $REF" >&2
echo "seed-restore-test: DO NOT replace or delete the seed this backup came from; the backup is not of that seed." >&2
exit 1
