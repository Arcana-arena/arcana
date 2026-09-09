# Backup & Recovery

**Status:** daily backups live since 2026-09-10. Restore verified — see
[Proof](#proof-that-this-works). **Off-site destination not yet chosen**, which
means the current backups survive a bad migration but *not* the loss of this
VPS. See [Choosing a destination](#choosing-a-destination).

---

## Why this exists

The code is in git and can be rebuilt from nothing. The **record** cannot:
score history, NAV history, every decision, and the market snapshots those
decisions were priced against. That record is the entire product — a platform
built to prove a track record has nothing to prove without it.

Before this, the only backups on this host were manual dumps taken by hand
before risky changes, and they were **partial**: `--data-only`, two tables. None
of them could rebuild a database from nothing, and all of them lived on the
machine they were meant to protect.

The whole dataset is **13 MB**. A compressed full archive is **~130 KB**.

---

## What is captured

`infra/backup/arcana-backup.sh` produces one `tar.gz` containing:

| File | What |
|---|---|
| `arcana.dump` | `pg_dump -Fc` of the **whole** database — schema, data, extensions, indexes. Not `--data-only`, not a table subset. |
| `globals.sql` | `pg_dumpall --globals-only` — roles and grants, which live outside any single database. |
| `minio/` | Every object in the `arcana-market` bucket. A decision without the prices it was made against is an assertion, not evidence (architecture.md §12), so the database alone is not a complete backup. |
| `manifest.txt` | Row counts and object count **at dump time**, plus the TimescaleDB version. |

The manifest is what makes verification meaningful. A restore is checked against
the counts captured *in that archive*, not against today's production — which
has moved on, and would make the check either pass by luck or fail for the
wrong reason.

### TimescaleDB — the part that quietly goes wrong

`decisions`, `score_snapshots` and `portfolio_snapshots` are hypertables
(TimescaleDB 2.29.2), and `agent_dna` uses pgvector. Restoring hypertables with
a plain `pg_dump | psql` is the classic way to end up with a database that
reports success and is silently missing its chunk structure.

The restore path below wraps the load in
`timescaledb_pre_restore()` / `timescaledb_post_restore()`. This is not
optional, and it is why the verification counts **chunks** as well as rows.

---

## Schedule and retention

| | |
|---|---|
| Backup | `arcana-backup.timer` — daily **04:30 UTC** (±5 min) |
| Verify | `arcana-backup-verify.timer` — **Sundays 05:30 UTC** |
| Retention | **7 daily + 4 weekly**, rolling. Sunday's archive is hard-linked into the weekly set, so it costs nothing until the daily copy is pruned. |
| Location | `/home/ubuntu/arcana-backups/automated/{daily,weekly}/`, mode 700, archives mode 600 |

04:30 UTC sits clear of everything that writes: the tick (23:00), score batch
(23:30), DNA batch (23:45), the scheduler's idempotent retries (01:00, 03:00),
the reminder (09:00) and the payout (10:00). Nothing takes a database lock, so a
collision would not corrupt anything — it would just capture a moment that is
harder to reason about.

The weekly verification runs an hour after Sunday's backup, so the copy kept
longest is the copy proven most recently.

### Exit codes

Following `arca-job.sh`:

- **0** — the backup completed.
- **non-zero** — it genuinely broke: the dump was implausibly small, the MinIO
  mirror returned nothing, or the off-site upload failed. The archive cannot be
  trusted.

A backup that completed but could **not leave the host** still exits 0 and logs
an unmissable `WARN` block. That is a deliberate choice: it is a real backup
against database-level accidents, and failing the unit daily would train
everyone to ignore a red timer. The warning is loud instead, and it disappears
the moment a destination is configured.

---

## Choosing a destination

**This is the open decision.** Until it is made, `BACKUP_REMOTE` is empty and
every run prints:

```
OFF-SITE COPY SKIPPED: BACKUP_REMOTE is not configured.
This backup exists ONLY on the machine it is meant to protect.
```

Nothing here needs more than a free tier — the daily archive is ~130 KB, so a
full year of daily-plus-weekly retention is well under 50 MB.

| Option | Cost at this size | Blast radius | Notes |
|---|---|---|---|
| **Cloudflare R2** *(recommended)* | **$0** — 10 GB free, no egress fees | **Separate from the VPS provider** | S3-compatible, works with rclone. Needs a Cloudflare account and an R2 API token. |
| **Backblaze B2** | **$0** — 10 GB free | Separate from the VPS provider | Equivalent to R2 in every way that matters here. Pick on preference. |
| Tencent COS | ~$0.01/month | **Shared** — same account as the VPS | Most convenient (same provider, `cos.ap-singapore` is reachable), but an account-level suspension or compromise takes the backup with the server. That is the exact scenario this protects against. |
| Pull to your own machine | $0 | Fully separate | No new account, but the VPS cannot push to a machine behind NAT, so it needs a scheduled pull from your side and only runs when that machine is on. **Good as a second copy, not as the only one.** |
| Private git repo | $0 | Separate | Not recommended: binary blobs bloat history forever and git has no rotation. |

**Recommendation: Cloudflare R2 or Backblaze B2**, because the point of an
off-site copy is that the failure taking out the VPS does not take out the
backup — and "same cloud account, different service" does not fully deliver
that. Tencent COS is a reasonable second-best if convenience wins.

### Wiring it up once chosen

```bash
sudo apt-get install -y rclone

# interactive; creates the remote (choose "s3" -> the provider)
rclone config --config /home/ubuntu/arcana/.rclone.conf
chmod 600 /home/ubuntu/arcana/.rclone.conf     # secrets live HERE, never in the unit

# point the unit at the remote
sudo systemctl edit arcana-backup.service
#   [Service]
#   Environment=BACKUP_REMOTE=arcana-offsite:arcana-backups

sudo systemctl daemon-reload
sudo systemctl start arcana-backup.service
sudo journalctl -u arcana-backup -n 30 --no-pager   # expect "off-site copy ok"
```

`.rclone.conf` is covered by the `.env`-style secret rules: **mode 600, never
committed, never inline in a unit file.**

### If the archives are encrypted, store the passphrase elsewhere

Archives are currently **not** encrypted, because they hold no credentials —
`auth_sessions` stores only SHA-256 hashes of refresh tokens, and no private
keys of any kind exist in this database. If encryption is added later (`gpg` is
installed), the passphrase **must** be kept somewhere other than this VPS — a
password manager. A passphrase that only exists on the machine you just lost
turns every backup into noise.

---

## Recovery

> Read this when something is already wrong. It assumes nothing about what you
> remember.

### A. Recover one table, or undo a bad migration (VPS is alive)

```bash
cd /home/ubuntu/arcana
ls -lt ~/arcana-backups/automated/daily/          # pick an archive from before the damage

# Restore it into a THROWAWAY database first and look at it.
./infra/backup/arcana-restore-test.sh ~/arcana-backups/automated/daily/arcana-<TS>.tar.gz
```

That script drops `arcana_restore_test` at the end. To keep it and inspect it,
run the steps in section B against `arcana_restore_test`, then copy what you
need across with `INSERT ... SELECT` from `dblink` or a table-scoped
`pg_dump -t`.

**Do not restore the whole archive over production to fix one table.** You would
roll back every other table to the same moment.

### B. Rebuild from nothing (the VPS is gone)

1. **Provision a host and get the code back.**
   ```bash
   git clone <your remote> arcana && cd arcana
   npm install && npm run build
   docker compose -f infra/docker/docker-compose.yml up -d
   ```
   Secrets are *not* in git and must be recreated: `.env.auth`
   (`AUTH_JWT_SIGNING_KEY`, `INTERNAL_API_KEY`), `infra/docker/.env` (MinIO),
   `services/market-data/.env` (vendor key, S3 keys). See docs/auth.md §7.

2. **Fetch the newest archive from the off-site destination** and extract it.
   ```bash
   rclone copy arcana-offsite:arcana-backups/daily/arcana-<TS>.tar.gz . \
     --config .rclone.conf
   mkdir restore && tar -xzf arcana-<TS>.tar.gz -C restore
   cat restore/manifest.txt        # what you should end up with
   ```

3. **Restore the database.** The order matters — TimescaleDB must be installed
   and put into restore mode *before* the data lands.
   ```bash
   docker exec -i arcana-postgres psql -U arcana -d postgres \
     -c "DROP DATABASE IF EXISTS arcana;" -c "CREATE DATABASE arcana;"

   docker exec -i arcana-postgres psql -U arcana -d arcana \
     -c "CREATE EXTENSION IF NOT EXISTS timescaledb;" \
     -c "SELECT timescaledb_pre_restore();"

   docker cp restore/arcana.dump arcana-postgres:/tmp/arcana.dump
   docker exec arcana-postgres pg_restore -U arcana -d arcana \
     --no-owner --no-privileges /tmp/arcana.dump

   docker exec -i arcana-postgres psql -U arcana -d arcana \
     -c "SELECT timescaledb_post_restore();"
   ```
   `pg_restore` may exit non-zero over the extension already existing. That is
   expected. **The row counts are the verdict, not the exit code.**

4. **Restore the snapshot objects.**
   ```bash
   docker cp restore/minio arcana-minio:/tmp/restore-minio
   docker exec -e MC_HOST_bk="http://<MINIO_USER>:<MINIO_PASS>@127.0.0.1:9000" \
     arcana-minio mc mb --ignore-existing bk/arcana-market
   docker exec -e MC_HOST_bk="http://<MINIO_USER>:<MINIO_PASS>@127.0.0.1:9000" \
     arcana-minio mc mirror --overwrite /tmp/restore-minio bk/arcana-market
   ```

5. **Verify against the manifest, then start the services.**
   ```bash
   grep '^rows\.' restore/manifest.txt
   docker exec arcana-postgres psql -U arcana -d arcana \
     -c "SELECT count(*) FROM decisions;" -c "SELECT count(*) FROM score_snapshots;"
   docker exec arcana-postgres psql -U arcana -d arcana \
     -c "SELECT hypertable_name, num_chunks FROM timescaledb_information.hypertables;"

   sudo cp infra/systemd/arcana-*.service infra/systemd/arcana-*.timer /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now arcana-*.timer
   ```

**Recovery time**, once a host exists: minutes. The archive is ~130 KB and the
database is 13 MB. The realistic cost is not the restore — it is provisioning
and recreating the secrets, so keep those in a password manager.

**Data loss window:** up to 24 hours (one daily cycle). With one tick per
trading day, that is at most one trading day of record.

---

## Proof that this works

Not "it should work" — this ran:

```
restore-test: table                     captured   restored   verdict
restore-test: -------------------------------------------------------
restore-test: agents                          9          9   ok
restore-test: creators                        2          2   ok
restore-test: seasons                         4          4   ok
restore-test: competitions                    3          3   ok
restore-test: competition_ticks             260        260   ok
restore-test: decisions                    1040       1040   ok
restore-test: score_snapshots              1162       1162   ok
restore-test: portfolio_snapshots          1066       1066   ok
restore-test: portfolios                      7          7   ok
restore-test: market_snapshots              260        260   ok
restore-test: marketplace_listings            1          1   ok
restore-test: subscriptions                   0          0   ok
restore-test: agent_dna                       6          6   ok
restore-test: auth_sessions                   0          0   ok
restore-test:
restore-test: hypertable chunk structure:
restore-test:   decisions -> 7 chunks
restore-test:   portfolio_snapshots -> 1 chunks
restore-test:   score_snapshots -> 1 chunks
restore-test:
restore-test: RESTORE VERIFIED: 14 tables matched, 3 hypertables rebuilt, 470 MinIO objects present
```

Production was untouched throughout: the restore lands in
`arcana_restore_test`, which is dropped at the end, and the script refuses to
run if that name equals the production database.

---

## Known limits

- **No off-site copy yet.** The one that matters. See above. This now compounds
  with a second gap: alerting cannot report a dead host either (see
  docs/alerting.md, "What is deliberately NOT monitored"), so losing this VPS
  today would be both silent and unrecoverable.
- **24-hour loss window.** Point-in-time recovery would need WAL archiving;
  overkill at one tick per trading day, worth revisiting if the cadence
  increases.
- **Archives are unencrypted.** Acceptable while they contain no credentials
  (see above), and it must be re-examined the moment that changes.
- **Restore is verified, failover is not.** There is no standby host. Recovery
  means provisioning, which is minutes-to-hours of human time, not seconds.
