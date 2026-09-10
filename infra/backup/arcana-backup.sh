#!/usr/bin/env bash
# arcana-backup.sh — one full backup of everything that cannot be rebuilt.
#
# The code is in git. The RECORD is not: score history, NAV history, every
# decision, and the market snapshots those decisions were made against. Lose
# that and the platform has nothing left to verify, which is the whole product.
# It is 13 MB. There is no excuse for it existing in one place.
#
# WHAT IS CAPTURED
#   1. globals.sql   — pg_dumpall --globals-only (roles, grants; not per-db data)
#   2. arcana.dump   — pg_dump -Fc of the whole database. NOT --data-only and
#                      NOT a table subset: the manual dumps that existed before
#                      this script were both, and neither could rebuild a
#                      database from nothing.
#   3. minio/        — every object in the snapshot bucket. A decision without
#                      the prices it was made against is an assertion, not
#                      evidence (architecture.md §12), so the database alone is
#                      not a complete backup.
#   4. manifest.txt  — row counts and object counts AT DUMP TIME, so a restore
#                      can be checked against what was actually captured rather
#                      than against today's production, which has moved on.
#
# TIMESCALEDB. decisions, score_snapshots and portfolio_snapshots are
# hypertables (TimescaleDB 2.29). A plain `pg_dump | psql` restore of those is
# the classic way to end up with a database that restores "successfully" and is
# quietly wrong. The restore path in docs/backup-restore.md wraps the load in
# timescaledb_pre_restore()/post_restore() for exactly that reason, and
# arcana-restore-test.sh proves it against a throwaway database.
#
# EXIT CODES — the distinction arca-job.sh established:
#   0  backup completed (see the off-site warning below)
#   1  something genuinely broke; the backup cannot be trusted
#
# OFF-SITE. A backup living on the machine it protects is not a backup. When
# BACKUP_REMOTE is unset this script still runs — a daily local dump does
# protect against a bad migration or a dropped table — but it says loudly that
# the copy never left the host, because that is the failure mode nobody notices.

set -uo pipefail

# --- configuration ---------------------------------------------------------
BACKUP_ROOT="${BACKUP_ROOT:-/home/ubuntu/arcana-backups/automated}"
PG_CONTAINER="${PG_CONTAINER:-arcana-postgres}"
MINIO_CONTAINER="${MINIO_CONTAINER:-arcana-minio}"
PG_USER="${PG_USER:-arcana}"
PG_DB="${PG_DB:-arcana}"
MINIO_BUCKET="${MINIO_BUCKET:-arcana-market}"

# Retention: rolling, never unbounded.
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"

# Off-site: an rclone remote such as "arcana-offsite:arcana-backups".
BACKUP_REMOTE="${BACKUP_REMOTE:-}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
DOW="$(date -u +%u)"          # 7 = Sunday, promoted to the weekly set
STAGE="${BACKUP_ROOT}/.staging-${TS}"
ARCHIVE="${BACKUP_ROOT}/daily/arcana-${TS}.tar.gz"

log()  { echo "arcana-backup: $*"; }
warn() { echo "arcana-backup: WARN: $*" >&2; }
die()  { echo "arcana-backup: ERROR: $*" >&2; rm -rf "$STAGE"; exit 1; }

mkdir -p "${BACKUP_ROOT}/daily" "${BACKUP_ROOT}/weekly" "$STAGE" || die "cannot create $BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"

# --- 1. postgres -----------------------------------------------------------
log "dumping globals"
docker exec "$PG_CONTAINER" pg_dumpall -U "$PG_USER" --globals-only > "${STAGE}/globals.sql" \
  || die "pg_dumpall --globals-only failed"

log "dumping database ${PG_DB} (custom format, whole database)"
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc > "${STAGE}/arcana.dump" \
  || die "pg_dump failed"

# A dump that is empty or absurdly small is a failure that returned 0.
DUMP_BYTES=$(stat -c %s "${STAGE}/arcana.dump" 2>/dev/null || echo 0)
[ "$DUMP_BYTES" -gt 100000 ] || die "arcana.dump is only ${DUMP_BYTES} bytes — refusing to call that a backup"
log "database dump: ${DUMP_BYTES} bytes"

# --- 2. minio --------------------------------------------------------------
log "mirroring MinIO bucket ${MINIO_BUCKET}"
MINIO_ENV="/home/ubuntu/arcana/infra/docker/.env"
if [ -r "$MINIO_ENV" ]; then
  MINIO_USER=$(grep '^MINIO_ROOT_USER=' "$MINIO_ENV" | cut -d= -f2-)
  MINIO_PASS=$(grep '^MINIO_ROOT_PASSWORD=' "$MINIO_ENV" | cut -d= -f2-)
else
  die "cannot read $MINIO_ENV — MinIO credentials unavailable"
fi

docker exec "$MINIO_CONTAINER" rm -rf /tmp/backup-mirror >/dev/null 2>&1
docker exec -e MC_HOST_bk="http://${MINIO_USER}:${MINIO_PASS}@127.0.0.1:9000" \
  "$MINIO_CONTAINER" mc mirror --quiet --overwrite "bk/${MINIO_BUCKET}" /tmp/backup-mirror \
  >/dev/null 2>&1 || die "mc mirror failed"

docker cp "${MINIO_CONTAINER}:/tmp/backup-mirror" "${STAGE}/minio" >/dev/null 2>&1 \
  || die "docker cp of the MinIO mirror failed"
docker exec "$MINIO_CONTAINER" rm -rf /tmp/backup-mirror >/dev/null 2>&1

MINIO_OBJECTS=$(find "${STAGE}/minio" -type f | wc -l)
[ "$MINIO_OBJECTS" -gt 0 ] || die "mirrored 0 objects from ${MINIO_BUCKET} — refusing to call that a backup"
log "minio objects: ${MINIO_OBJECTS}"

# --- 3. manifest -----------------------------------------------------------
# Counts recorded at dump time. A restore is verified against THESE, not against
# production — production keeps moving, and comparing to it would either pass by
# luck or fail for the wrong reason.
log "recording manifest"
{
  echo "# arcana backup manifest"
  echo "taken_at_utc=${TS}"
  echo "pg_database=${PG_DB}"
  echo "dump_bytes=${DUMP_BYTES}"
  echo "minio_objects=${MINIO_OBJECTS}"
  echo "timescaledb_version=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc "SELECT extversion FROM pg_extension WHERE extname='timescaledb'" 2>/dev/null | tr -d '\r')"
  echo "# row counts at dump time"
} > "${STAGE}/manifest.txt"

for t in agents creators seasons competitions competition_ticks decisions \
         score_snapshots portfolio_snapshots portfolios market_snapshots \
         marketplace_listings subscriptions agent_dna auth_sessions; do
  n=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc \
        "SELECT count(*) FROM ${t}" 2>/dev/null | tr -d '\r')
  echo "rows.${t}=${n:-ERROR}" >> "${STAGE}/manifest.txt"
done

# --- 4. archive ------------------------------------------------------------
log "archiving"
tar -czf "$ARCHIVE" -C "$STAGE" . || die "tar failed"
chmod 600 "$ARCHIVE"
rm -rf "$STAGE"

ARCHIVE_BYTES=$(stat -c %s "$ARCHIVE")
log "archive: $ARCHIVE (${ARCHIVE_BYTES} bytes)"

# Sunday's archive is also promoted into the weekly set, by hard link so it
# costs nothing until the daily copy is pruned.
if [ "$DOW" = "7" ]; then
  ln -f "$ARCHIVE" "${BACKUP_ROOT}/weekly/arcana-${TS}.tar.gz" && log "promoted to weekly"
fi

# --- 5. off-site -----------------------------------------------------------
OFFSITE_OK=0
if [ -n "$BACKUP_REMOTE" ]; then
  if ! command -v rclone >/dev/null 2>&1; then
    die "BACKUP_REMOTE is set but rclone is not installed"
  fi
  RC="--config ${RCLONE_CONFIG:-/home/ubuntu/arcana/.rclone.conf}"
  log "uploading to ${BACKUP_REMOTE}"

  # A FAILED UPLOAD IS A FAILED BACKUP, and it dies here rather than warning.
  #
  # The destination is Google Drive, which authenticates with OAuth, and an
  # OAuth refresh token stops working on its own schedule: it expires, or is
  # revoked, or the grant goes stale. Everything else keeps succeeding when
  # that happens — the dump runs, the archive is written, the local retention
  # rotates, the log says "ok" — and the only thing that stopped is the part
  # that made the copy off-site, which is the entire reason the copy exists.
  #
  # So the exit code has to distinguish "the backup ran" from "the backup left
  # this machine", and it does: any upload failure is fatal, and
  # OnFailure=arcana-alert@ in the unit turns that into an alert.
  # shellcheck disable=SC2086
  if ! rclone copy "$ARCHIVE" "${BACKUP_REMOTE}/daily/" $RC 2>&1; then
    die "off-site upload to ${BACKUP_REMOTE} failed — the backup did not leave this host. \
If the remote is Google Drive, check the OAuth token first: \
rclone about ${BACKUP_REMOTE%%:*}: $RC"
  fi

  # rclone exiting 0 says the transfer reported success. It does not say the
  # bytes are readable at the far end, and for the failure being defended
  # against here — a credential that is half-alive — that difference is the
  # whole question. So the remote is ASKED.
  # shellcheck disable=SC2086
  REMOTE_SIZE="$(rclone size "${BACKUP_REMOTE}/daily/$(basename "$ARCHIVE")" --json $RC 2>/dev/null \
                 | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')"
  LOCAL_SIZE="$(stat -c %s "$ARCHIVE" 2>/dev/null)"
  if [ -z "$REMOTE_SIZE" ] || [ "$REMOTE_SIZE" = "0" ]; then
    die "uploaded to ${BACKUP_REMOTE} but the remote does not have the file — \
rclone reported success and the archive is not there"
  elif [ -n "$LOCAL_SIZE" ] && [ "$REMOTE_SIZE" != "$LOCAL_SIZE" ]; then
    die "off-site copy is ${REMOTE_SIZE} bytes, local archive is ${LOCAL_SIZE} — truncated upload"
  fi
  OFFSITE_OK=1
  log "off-site copy ok and verified present (${REMOTE_SIZE} bytes)"

  if [ "$DOW" = "7" ]; then
    # Also fatal. The weekly copy is the one that survives a fault nobody
    # noticed for a week, so a silent weekly failure is the worse of the two.
    # This used to be `&& log ok` with no else, which reported nothing at all.
    # shellcheck disable=SC2086
    if rclone copy "$ARCHIVE" "${BACKUP_REMOTE}/weekly/" $RC 2>&1; then
      log "off-site weekly copy ok"
    else
      die "off-site WEEKLY upload to ${BACKUP_REMOTE} failed — the daily copy went, the weekly did not"
    fi
  fi

  # Remote retention mirrors local retention. NOT fatal, and that asymmetry is
  # deliberate: failing to delete an old backup leaves too many backups, which
  # is not the emergency that failing to make one is. It is still reported.
  # shellcheck disable=SC2086
  rclone delete "${BACKUP_REMOTE}/daily/"  --min-age "${KEEP_DAILY}d"  $RC 2>&1 \
    || warn "remote daily retention failed — old archives may be accumulating off-site"
  # shellcheck disable=SC2086
  rclone delete "${BACKUP_REMOTE}/weekly/" --min-age "$((KEEP_WEEKLY * 7))d" $RC 2>&1 \
    || warn "remote weekly retention failed — old archives may be accumulating off-site"
else
  warn "================================================================"
  warn "OFF-SITE COPY SKIPPED: BACKUP_REMOTE is not configured."
  warn "This backup exists ONLY on the machine it is meant to protect."
  warn "It survives a bad migration or a dropped table. It does NOT"
  warn "survive losing this VPS, which is the risk it was written for."
  warn "See docs/backup-restore.md, 'Choosing a destination'."
  warn "================================================================"
fi

# --- 6. retention ----------------------------------------------------------
prune() {
  local dir="$1" keep="$2"
  local n
  n=$(ls -1 "$dir"/arcana-*.tar.gz 2>/dev/null | wc -l)
  if [ "$n" -gt "$keep" ]; then
    ls -1t "$dir"/arcana-*.tar.gz | tail -n +$((keep + 1)) | while read -r old; do
      rm -f "$old" && log "pruned $(basename "$old")"
    done
  fi
}
prune "${BACKUP_ROOT}/daily"  "$KEEP_DAILY"
prune "${BACKUP_ROOT}/weekly" "$KEEP_WEEKLY"

log "daily kept: $(ls -1 "${BACKUP_ROOT}/daily" 2>/dev/null | wc -l), weekly kept: $(ls -1 "${BACKUP_ROOT}/weekly" 2>/dev/null | wc -l)"

if [ "$OFFSITE_OK" = "1" ]; then
  log "ok (database + minio, off-site copy confirmed)"
else
  log "ok LOCAL ONLY (database + minio; no off-site copy)"
fi
exit 0
