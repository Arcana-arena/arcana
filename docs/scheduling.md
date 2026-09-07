# ARCANA Scheduling (VPS)

How the competition scheduler and the score batch run automatically on the VPS.

## Mechanism: systemd timers + service units

Chosen because the ARCANA services run as **plain processes on the VPS**
(no Kubernetes yet — infra/k8s is unused). systemd gives us, compared to plain
cron:

- logging via `journalctl`
- overlap protection (`Type=oneshot` + `flock`)
- restart policy for the long-running services
- easy status & timing introspection

The data stack (Postgres/Redis/Kafka/MinIO) keeps running via Docker Compose
(`docker compose up -d`); systemd units only manage the ARCANA application
services and jobs.

Units live in [`infra/systemd/`](../infra/systemd/):

| Unit | Kind | Schedule | Purpose |
|---|---|---|---|
| `arcana-agent.service` | long-running | always | agent/creator/season/competition API (port 3001) |
| `arcana-marketdata.service` | long-running | always | market snapshots + simulator (port 8083) |
| `arcana-decision.service` | long-running | always | decision engine (port 8081) |
| `arcana-scoring.service` | long-running | always | score API + batch endpoint (port 8082) |
| `arcana-marketplace.service` | long-running | always | marketplace API (port 3002) |
| `arcana-scheduler.timer` → `arcana-scheduler.service` | oneshot | **every 1 min** | advance the competition one tick |
| `arcana-scoring-job.timer` → `arcana-scoring-job.service` | oneshot | **every 5 min** | run the ARCANA Score batch |

## Schedules (demo cadence — change for production)

- **Scheduler: every 1 minute** (`OnCalendar=*-*-* *:*:00`). Short on purpose for
  demo/testing. Human window per tick is 4 minutes
  (`HUMAN_WINDOW=4m` in `arcana-scheduler.service`), so a tick opened at T stays
  open across four 1-minute invocations (which no-op while inside the window)
  and is closed at T+4m.
- **Scoring: every 5 minutes** (`OnCalendar=*-*-* *:00/5:00`). Frequent enough to
  reflect new ticks, sparse enough to avoid recomputing unchanged portfolios.

For a realistic production cadence (e.g. hourly ticks, daily post-market score),
edit the `[Timer] OnCalendar=` lines and the `HUMAN_WINDOW` in the service file,
then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart arcana-scheduler.timer arcana-scoring-job.timer
```

## Which competition is scheduled?

`arcana-scheduler.service` hardcodes `COMPETITION_ID` (currently the running
`human_vs_ai` competition). To add another competition, copy the unit, change
the id and the lock path (`/tmp/arcana-scheduler.lock` → unique per unit), and
re-run the installer. The scheduler itself no-ops safely on completed
competitions.

## Overlap protection

Both job units are `Type=oneshot` and guard with a non-blocking lock in
`ExecStartPre`:

```
ExecStartPre=/usr/bin/flock -n /tmp/arcana-scheduler.lock true
```

If a previous invocation is still running when the timer fires, the new one
fails immediately (exit 1, visible in the journal) instead of stacking. No
double-open ticks / no concurrent score batches.

## Install / update

```bash
bash infra/systemd/install.sh   # on the VPS, from ~/arcana
```

Copies the units into `/etc/systemd/system`, builds the scheduler binary into
`~/arcana/scheduler-bin/scheduler`, enables the five long-running services and
the two timers.

## Monitoring

```bash
# timers & next runs
systemctl list-timers arcana-scheduler.timer arcana-scoring-job.timer

# last scheduler invocations (tick opened/closed/no-op, AI runs)
journalctl -u arcana-scheduler.service -n 50

# last score batch runs
journalctl -u arcana-scoring-job.service -n 20

# failures (any arcana unit)
systemctl list-units --failed | grep arcana

# follow live
journalctl -u arcana-scheduler.service -f
```

A healthy scheduler log shows a repeating cycle like:

```
tick 5 opened for 3f444e70-...          # phase 1
tick 5 left open for human submissions  # humans can submit
tick 5 closed for 3f444e70-...          # after the 4m window
```

A healthy scoring log shows `{"processed":3,"skipped":0}` every five minutes.

## Known VPS state

- `systemctl is-system-running` reports `degraded` because of an unrelated
  failing unit (`orvix-treasury-health.service`); no ARCANA unit fails.
- Marketplace discovery reads `score_snapshots` live (DISTINCT ON latest per
  agent), so its displayed score advances with every scoring run with no manual
  trigger.
