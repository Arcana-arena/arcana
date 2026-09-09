#!/usr/bin/env bash
# arcana-restore-test.sh — restore a backup into a THROWAWAY database and prove
# the row counts match what was captured.
#
# A backup that has never been restored is not a backup, it is an assumption.
# Same principle as the auth work: a gate that has never refused anyone has not
# been tested.
#
# This matters more than usual here because of TimescaleDB. decisions,
# score_snapshots and portfolio_snapshots are hypertables, and restoring those
# without timescaledb_pre_restore()/post_restore() is the classic way to get a
# restore that reports success and is quietly missing its chunk structure. This
# script performs the documented sequence and then counts rows, so "it worked"
# is a measurement rather than an absence of error messages.
#
# SAFETY: it only ever creates and drops ${TEST_DB}, which must not be the
# production database. It refuses to run if they are the same name.
#
# Usage: arcana-restore-test.sh [/path/to/arcana-<ts>.tar.gz]
#        (defaults to the newest daily archive)

set -uo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/home/ubuntu/arcana-backups/automated}"
PG_CONTAINER="${PG_CONTAINER:-arcana-postgres}"
PG_USER="${PG_USER:-arcana}"
PROD_DB="${PROD_DB:-arcana}"
TEST_DB="${TEST_DB:-arcana_restore_test}"

log()  { echo "restore-test: $*"; }
die()  { echo "restore-test: ERROR: $*" >&2; exit 1; }

[ "$TEST_DB" != "$PROD_DB" ] || die "TEST_DB must not be the production database"

ARCHIVE="${1:-$(ls -1t "${BACKUP_ROOT}"/daily/arcana-*.tar.gz 2>/dev/null | head -1)}"
[ -n "$ARCHIVE" ] && [ -r "$ARCHIVE" ] || die "no archive found (looked in ${BACKUP_ROOT}/daily)"
log "archive: $ARCHIVE"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

tar -xzf "$ARCHIVE" -C "$WORK" || die "cannot extract archive"
[ -r "${WORK}/arcana.dump" ]   || die "archive has no arcana.dump"
[ -r "${WORK}/manifest.txt" ]  || die "archive has no manifest.txt"

MINIO_IN_ARCHIVE=$(find "${WORK}/minio" -type f 2>/dev/null | wc -l)
log "archive contains ${MINIO_IN_ARCHIVE} MinIO objects"

# --- restore into the throwaway database -----------------------------------
log "dropping and recreating ${TEST_DB}"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -q \
  -c "DROP DATABASE IF EXISTS ${TEST_DB};" -c "CREATE DATABASE ${TEST_DB};" \
  || die "cannot create ${TEST_DB}"

# TimescaleDB must exist BEFORE the restore, and the restore must run between
# pre_restore and post_restore.
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$TEST_DB" -q \
  -c "CREATE EXTENSION IF NOT EXISTS timescaledb;" || die "cannot create timescaledb extension"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$TEST_DB" -tAq \
  -c "SELECT timescaledb_pre_restore();" >/dev/null || die "timescaledb_pre_restore() failed"

log "restoring"
docker cp "${WORK}/arcana.dump" "${PG_CONTAINER}:/tmp/restore-test.dump" >/dev/null || die "docker cp failed"
docker exec "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$TEST_DB" \
  --no-owner --no-privileges /tmp/restore-test.dump > "${WORK}/restore.log" 2>&1
RESTORE_RC=$?
docker exec "$PG_CONTAINER" rm -f /tmp/restore-test.dump

# pg_restore returns non-zero for benign complaints too (the extension already
# exists, ownership it may not set). The verdict is the row counts below; the
# log is surfaced either way rather than swallowed.
if [ "$RESTORE_RC" -ne 0 ]; then
  log "pg_restore exited ${RESTORE_RC}; diagnostics follow (row counts decide)"
  grep -iE "error|warning" "${WORK}/restore.log" | head -10 | sed 's/^/  /'
fi

docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$TEST_DB" -tAq \
  -c "SELECT timescaledb_post_restore();" >/dev/null || die "timescaledb_post_restore() failed"

# --- verify ----------------------------------------------------------------
log ""
log "table                     captured   restored   verdict"
log "-------------------------------------------------------"
MISMATCH=0
CHECKED=0
while IFS='=' read -r key expected; do
  case "$key" in rows.*) ;; *) continue ;; esac
  table="${key#rows.}"
  [ "$expected" = "ERROR" ] && continue
  actual=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$TEST_DB" -tAc \
             "SELECT count(*) FROM ${table}" 2>/dev/null | tr -d '\r')
  actual="${actual:-MISSING}"
  CHECKED=$((CHECKED + 1))
  if [ "$actual" = "$expected" ]; then
    printf 'restore-test: %-24s %8s   %8s   ok\n' "$table" "$expected" "$actual"
  else
    printf 'restore-test: %-24s %8s   %8s   MISMATCH\n' "$table" "$expected" "$actual"
    MISMATCH=$((MISMATCH + 1))
  fi
done < "${WORK}/manifest.txt"

# Hypertables specifically: a restore can carry the rows and lose the chunk
# structure, which is the failure this whole procedure exists to prevent.
log ""
log "hypertable chunk structure:"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$TEST_DB" -tAc \
  "SELECT hypertable_name || ' -> ' || num_chunks || ' chunks' FROM timescaledb_information.hypertables ORDER BY hypertable_name" \
  2>/dev/null | sed 's/^/restore-test:   /'

HT=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$TEST_DB" -tAc \
  "SELECT count(*) FROM timescaledb_information.hypertables" 2>/dev/null | tr -d '\r')

log ""
log "dropping ${TEST_DB}"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -q \
  -c "DROP DATABASE IF EXISTS ${TEST_DB};" || log "WARN: could not drop ${TEST_DB}"

log ""
if [ "$MISMATCH" -eq 0 ] && [ "${HT:-0}" -ge 3 ] && [ "$CHECKED" -gt 0 ]; then
  log "RESTORE VERIFIED: ${CHECKED} tables matched, ${HT} hypertables rebuilt, ${MINIO_IN_ARCHIVE} MinIO objects present"
  exit 0
fi
log "RESTORE FAILED: ${MISMATCH} mismatched table(s) of ${CHECKED}, ${HT:-0} hypertables"
exit 1
