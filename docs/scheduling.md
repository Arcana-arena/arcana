# ARCANA Scheduling (VPS)

How the recurring ARCANA jobs run automatically on the VPS: the competition
scheduler, the score batch, the two $ARCA payment jobs (subscription reminders
and creator payouts), and the Agent DNA fingerprint batch.

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
| `arcana-arca.service` | long-running | always | $ARCA entitlements, deposits, payments (port **3004** — 3003 is taken on this host) |
| `arcana-scheduler.timer` → `arcana-scheduler.service` | oneshot | **every 1 min** | advance the competition one tick |
| `arcana-scoring-job.timer` → `arcana-scoring-job.service` | oneshot | **every 5 min** | run the ARCANA Score batch |
| `arcana-arca-reminder.timer` → `arcana-arca-reminder.service` | oneshot | **daily 09:00 UTC** | $ARCA renewal pushes + `active→grace→expired` |
| `arcana-arca-payout.timer` → `arcana-arca-payout.service` | oneshot | **daily 10:00 UTC** | $ARCA creator payout batch (80/20 split) |
| `arcana-agent-dna.timer` → `arcana-agent-dna.service` | oneshot | **daily 11:00 UTC** | recompute Agent DNA fingerprints ([agent-dna.md](./agent-dna.md)) |

The $ARCA **deposit audit** (stranded-payment detection + retiring unfunded
deposit addresses) has **no timer**: it runs inside `arcana-arca.service` on its
own interval (`ARCA_AUDIT_INTERVAL_MS`, default 5 min). Do not add one — it
would duplicate work already scheduled in-process.

## Schedules (demo cadence — change for production)

- **Scheduler: every 1 minute** (`OnCalendar=*-*-* *:*:00`). Short on purpose for
  demo/testing. Human window per tick is 4 minutes
  (`HUMAN_WINDOW=4m` in `arcana-scheduler.service`), so a tick opened at T stays
  open across four 1-minute invocations (which no-op while inside the window)
  and is closed at T+4m.
- **Scoring: every 5 minutes** (`OnCalendar=*-*-* *:00/5:00`). Frequent enough to
  reflect new ticks, sparse enough to avoid recomputing unchanged portfolios.
- **$ARCA reminder: daily 09:00 UTC** (16:00 WIB). Once a day matches the
  granularity of the stages themselves — H-3 / H-1 / H-0, each sent at most once
  per subscription — so a tighter interval would only re-scan rows already
  marked. The hour is an operations choice: it lands in the WIB afternoon, so a
  failed run is seen the same working day.
- **$ARCA payout: daily 10:00 UTC** (17:00 WIB). §10.3 permits daily or weekly.
  Daily wins because the gas-saving batching is *per creator per run*: a creator
  with twenty sales gets one transfer either way. Weekly would cut an already
  small gas bill by at most 6/7 while making creators wait up to a week for
  money already sitting in the treasury. To switch:
  `OnCalendar=Mon *-*-* 10:00:00 UTC`. The hour is deliberate too — this moves
  real funds, and a failure needs a person awake to see it.
- **Agent DNA: daily 11:00 UTC** (18:00 WIB). The fingerprint averages an
  agent's whole recorded history, so one more tick barely moves it; running more
  often would re-read every market snapshot to produce nearly the same vector.
  An hour after the payout batch so the daily jobs never overlap. See
  [agent-dna.md](./agent-dna.md).

Both $ARCA timers use `Persistent=true`, so a run missed while the VPS was down
fires at the next boot. A late reminder still helps a user renew, and the payout
batch is idempotent per `payment_event`.

### These two jobs are no-ops until the $ARCA token launches

Production `.env` deliberately leaves `ARCA_TOKEN_ADDRESS`, `ARCA_RPC_URL`,
`ARCA_MASTER_PRIVATE_KEY`, `ARCA_TREASURY_PRIVATE_KEY` and `ARCA_CHAIN_ID`
empty, so anything touching funds refuses to run. Expect this in the journal
every day, and read it as healthy:

```
payout: SKIPPED (feature disabled by configuration, expected until the $ARCA
token launches): {"processed":0,"paid_out":0,"skipped":["payout disabled: ..."]}
```

The unit exits **0** for this. A deliberate stand-down is not a failure, and a
unit that showed `failed` daily for a year would train everyone to ignore it.
A real fault — arca-service down, HTTP 5xx, unparseable reply — exits non-zero
and logs to stderr. `infra/systemd/arca-job.sh` is what tells the two apart;
plain `curl -fsS` cannot, because both cases return 2xx and the difference is
inside the JSON body.

The **reminder** job is different and worth not confusing: it touches only the
database — no chain, no keys — so it genuinely runs today. It simply reports
`{"reminded":0,"grace":0,"expired":0}` while there are no subscriptions.

When the token does launch, follow [arca-go-live.md](./arca-go-live.md) — which
variables to fill, from where, and what to verify before real users can
subscribe.

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

Every job unit is `Type=oneshot`, and overlap is guarded by **two independent
layers**. They cover different things, and it is worth knowing which is which:

| Layer | Covers | Does not cover |
|---|---|---|
| **systemd** | A timer firing while the previous run of the *same unit* is still going — systemd refuses to start a second instance. | Anything that does not go through systemd. |
| **flock** | Any concurrent run at all, including a manual invocation or another script — the lock is held for the entire command. | Nothing, provided every caller goes through the unit or takes the same lock. |

All five job units wrap the command in a non-blocking lock, so the lock is held
for the whole run:

```
ExecStart=/usr/bin/flock -n /tmp/arcana-arca-payout.lock /home/ubuntu/arcana/infra/systemd/arca-job.sh payout ...
ExecStart=/usr/bin/flock -n /tmp/arcana-scheduler.lock /home/ubuntu/arcana/scheduler-bin/scheduler -competition ... 
```

If a run is already in progress the new one fails immediately (exit 1, visible
in the journal) instead of stacking. That matters most for payout, which sends
money; per-`payment_event` idempotency is the second line of defence, not the
first.

> **Do not move the lock into `ExecStartPre`.** It used to live there as
> `flock -n LOCK true`, which takes the lock, runs `true`, and releases it —
> all before `ExecStart` begins. It guarded nothing, and systemd alone was
> holding the line. No overlap ever slipped through, but the config claimed a
> protection it did not have, which is its own hazard: the next person to
> change the unit type, or to call a job from outside systemd, would have been
> reasoning from a guarantee that was not there.

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
