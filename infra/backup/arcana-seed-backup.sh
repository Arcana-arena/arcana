#!/usr/bin/env bash
# arcana-seed-backup.sh — an ENCRYPTED copy of the master seed, for storage
# away from the host.
#
# The database can be rebuilt from a backup and verified by counting rows. The
# SEED cannot be rebuilt from anything: lose it and every agent wallet is
# unrecoverable, permanently, with no support path (docs/signer.md). Until the
# custody moves to KMS (option B), the seed exists exactly once, on one host,
# in one file.
#
# WHAT THIS PRODUCES: one file, ciphertext only, from openssl enc
# (AES-256-CBC, PBKDF2, 600,000 iterations, salted). The passphrase is NEVER
# written by this script and must not live next to the backup — a backup and
# its key in the same place is the failure mode this file exists to prevent.
#
# TWO PLACES, PHYSICALLY SEPARATE. This script makes the artifact; putting the
# two copies somewhere that does not share power, disk or account with the
# host is an owner action, stated in docs/signer.md and tracked in
# docs/waiting-on-owner.md. A backup on the machine it protects is not a backup.
#
# IF CUSTODY HAS MOVED TO KMS: the sealed blob (/etc/arcana/signer/master.key.kms)
# is already ciphertext, so backing it up is `cp` to two places — no passphrase,
# and a stolen copy is useless without KMS access. This script refuses to run in
# kms mode on purpose.
#
# Usage: arcana-seed-backup.sh [--seed FILE] [--out FILE] [--passphrase-file FILE]
#   passphrase: --passphrase-file, or SEED_BACKUP_PASSPHRASE in the environment
# Exit codes: 0 backup written and verified · 1 something broke or a safety check refused

set -uo pipefail

SEED="${SIGNER_MASTER_SEED_FILE:-/etc/arcana/signer/master.key}"
OUT=""
PASS_FILE=""
MIN_PASSPHRASE_LEN="${MIN_PASSPHRASE_LEN:-16}"

log() { echo "seed-backup: $*"; }
die() { echo "seed-backup: ERROR: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --seed)            SEED="${2:?--seed needs a path}"; shift 2 ;;
    --out)             OUT="${2:?--out needs a path}"; shift 2 ;;
    --passphrase-file) PASS_FILE="${2:?--passphrase-file needs a path}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

# Refuse the KMS world explicitly: there the right backup is a copy of the
# sealed blob, and passphrase-encrypting a decryptable-by-KMS file would add a
# second secret where none is needed.
if [ "${SIGNER_SEED_SOURCE:-file}" = "kms" ]; then
  die "SIGNER_SEED_SOURCE=kms: back up the sealed blob (cp /etc/arcana/signer/master.key.kms) instead — it is already ciphertext, and a stolen copy is useless without KMS access"
fi

[ -r "$SEED" ] || die "cannot read seed $SEED (run as root: the seed is 0400 and its directory is 0700)"
[ -s "$SEED" ] || die "seed $SEED is empty"

[ -n "$OUT" ] || OUT="./master.key.$(date -u +%Y%m%dT%H%M%SZ).enc"
[ ! -e "$OUT" ] || die "$OUT already exists; refusing to overwrite a backup (choose another --out)"

if [ -n "$PASS_FILE" ]; then
  [ -r "$PASS_FILE" ] || die "cannot read passphrase file $PASS_FILE"
  SEED_BACKUP_PASSPHRASE="$(cat "$PASS_FILE")"
fi
[ -n "${SEED_BACKUP_PASSPHRASE:-}" ] || die "no passphrase: pass --passphrase-file, or set SEED_BACKUP_PASSPHRASE"
[ "${#SEED_BACKUP_PASSPHRASE}" -ge "$MIN_PASSPHRASE_LEN" ] || die "passphrase is ${#SEED_BACKUP_PASSPHRASE} characters; at least $MIN_PASSPHRASE_LEN are required. This passphrase is the only thing standing between a backup copy and every wallet"

umask 077
export SEED_BACKUP_PASSPHRASE
openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
  -in "$SEED" -out "$OUT" -pass env:SEED_BACKUP_PASSPHRASE || die "openssl enc failed"
[ -s "$OUT" ] || die "output $OUT is empty"

# Prove the file decrypts back to the seed before calling it a backup — the
# restore-test principle (arcana-restore-test.sh) applied here, cheaply.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
    -in "$OUT" -out "$WORK/seed.plain" -pass env:SEED_BACKUP_PASSPHRASE 2>"$WORK/err"; then
  rm -f "$OUT"
  die "the file just written does not decrypt ($(cat "$WORK/err")); removed it — not a backup"
fi
if ! cmp -s "$SEED" "$WORK/seed.plain"; then
  rm -f "$OUT"
  die "the decrypted copy differs from the seed; removed the output — not a backup"
fi
shred -u "$WORK/seed.plain" 2>/dev/null || rm -f "$WORK/seed.plain"
log "verified: the encrypted file decrypts back to the seed, byte for byte"

SUM="$(sha256sum "$OUT" | awk '{print $1}')"
log "wrote $OUT"
log "sha256 $SUM"
log "size   $(wc -c < "$OUT") bytes"
cat <<EOF

NEXT STEPS (owner actions — see docs/signer.md):
  1. Copy the file to TWO places that do not share a disk, an account or a
     power supply with this host. If both copies can burn together, there is
     one copy.
  2. Keep the passphrase somewhere that is not either copy.
  3. Drill the backup before trusting it:
       arcana-seed-restore-test.sh --from-encrypted $OUT
     and run it again whenever the seed is replaced.

The seed this protects: $SEED
EOF
