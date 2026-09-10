# ARCANA Scheduling (VPS)

How the recurring ARCANA jobs run automatically on the VPS: the competition
scheduler, the score batch, the two $ARCA payment jobs (subscription reminders
and — until 2026-09-10 — creator payouts), the chain guard, and the Agent DNA
fingerprint batch.

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
| `arcana-marketdata.service` | long-running | always | market snapshots read from the vendor (port 8083) |
| `arcana-decision.service` | long-running | always | decision engine (port 8081) |
| `arcana-scoring.service` | long-running | always | score API + batch endpoint (port 8082) |
| `arcana-marketplace.service` | long-running | always | marketplace API (port 3002) |
| `arcana-arca.service` | long-running | always | $ARCA entitlements, subscriptions, marketplace payment claims (port **3004** — 3003 is taken on this host) |
| ~~`arcana-scheduler.timer`~~ | — | **RETIRED 2026-09-11** | One tick per US trading day, 23:00 UTC with retries at 01:00 and 03:00. Stock Tokens trade against a pool that never closes, so "trading day" stopped naming anything and a calendar-driven tick stood still through two thirds of every week. |
| `arcana-cadence.timer` → `arcana-cadence.service` | oneshot | **hourly** | advance the competition on a CONTINUOUS clock. The timer decides how often the system looks; the binary measures the age of the last tick and acts only once the four-hour cadence has elapsed. Prices come from the Uniswap pool, refereed by Chainlink ([cadence.md](./cadence.md)) |
| `arcana-decision-watchdog.timer` → `arcana-decision-watchdog.service` | oneshot | **00,06,12,18:15 UTC** | shouts if no DECISION has been recorded in twelve hours. Measures decisions rather than ticks: a tick that opened and closed with every agent failing looks healthy to anything counting ticks |
| `arcana-scoring-job.timer` → `arcana-scoring-job.service` | oneshot | **daily 23:30 UTC** | run the ARCANA Score batch, after the tick |
| `arcana-arca-reminder.timer` → `arcana-arca-reminder.service` | oneshot | **daily 09:00 UTC** | $ARCA renewal pushes + `active→grace→expired` |
| ~~`arcana-arca-payout.timer`~~ | — | **RETIRED 2026-09-10** | The 80/20 split and treasury payout are gone: the marketplace is P2P with no fee, so ARCANA never holds or splits a payment and has nothing to pay out. Unit and service removed. |
| `arcana-chain-guard.timer` → `arcana-chain-guard.service` | oneshot | **every 4 hours** | watch the Stock Token beacon, pause state and pool liquidity for issuer-side drift ([alerting.md](./alerting.md#layer-3--the-chain-guard)) |
| `arcana-agent-dna.timer` → `arcana-agent-dna.service` | oneshot | **daily 23:45 UTC** | recompute Agent DNA fingerprints ([agent-dna.md](./agent-dna.md)) |
| `arcana-signer.service` | long-running | always | the only component that holds key material; runs as its own Linux user `arcana-signer` (port 8085 — [signer.md](./signer.md)) |
| `arcana-backup.timer` → `arcana-backup.service` | oneshot | **daily 02:00 UTC** | full backup, database + MinIO, with an off-site copy to Google Drive. **Fails loudly if the upload fails** — a backup that never left the machine is a failed backup ([backup-restore.md](./backup-restore.md)) |
| `arcana-backup-verify.timer` → `arcana-backup-verify.service` | oneshot | **weekly** | restores the newest archive into a scratch database and counts rows. A backup nobody has restored is a hypothesis |
| ~~`arcana-tick-watchdog.timer`~~ | — | **RETIRED 2026-09-11** | Asked whether a trading day passed with no tick. There are no trading days: the pool never closes. Replaced by `arcana-decision-watchdog`. |
| `arcana-alert@.service` | template | on failure | `OnFailure=` target for every unit above; instantiated per failing unit ([alerting.md](./alerting.md)) |

> **These last five were missing from this table until 2026-09-11**, when
> `docs-verify.mjs` first compared it against `infra/systemd/`. Four of them
> are the units that protect the record — the backups, their proof, and the
> watchdog — and one is the service that holds every private key. Exactly the
> drift `alerting.md` had, in a different document, invisible for the same
> reason: a hand-maintained list of things has no way to notice what it left
> out. Both directions are now checked on every deploy.

The $ARCA **deposit audit** — stranded-payment detection and retiring unfunded
deposit addresses, on an in-process `setInterval` rather than a timer — was
**removed on 2026-09-11** with `PaymentListenerService`. There is nothing left
to audit: ARCANA issues no deposit address, so no payment can arrive somewhere
it fails to notice. A buyer who pays and is not granted access now submits the
transaction hash themselves and gets a reasoned answer synchronously.

**No background timer or interval remains in the payment path at all.** Payment
verification is entirely request-driven.

## Schedules

- **Scheduler: 23:00 UTC, retried at 01:00 and 03:00 UTC.** One tick per US
  trading day. 23:00 is after the close in both DST regimes (21:00 UTC under
  EDT, 22:00 under EST), leaving the vendor's end-of-day aggregation time to
  settle. The two later runs are **idempotent retries**, not extra ticks: all
  three resolve to the same trading session, the snapshot ref is derived from
  the session date, and the scheduler checks whether that ref already carries a
  tick — so after a successful 23:00 run they cost one no-op each. They exist
  because a missed session is a day of the competition that cannot be recovered
  later; a scored season only runs forward.

  Human window per tick is **1 hour** (`HUMAN_WINDOW=1h`), so a tick opened at
  23:00 is closed by the 01:00 run. Four minutes made sense against a 1-minute
  timer; against a daily tick it would have shut the window before any human in
  any timezone saw it.

  `Persistent=false` is deliberate: a run missed because the host was down is a
  session that has *passed*, and firing it late would open a tick against a
  snapshot taken well after the fact — the replay this design refuses
  ([market-data.md](./market-data.md#backfill-vs-replay--the-line)).

  **Market closed → no tick at all**, and the unit exits 0. A day with no trading
  is not a failure. A vendor fault is different: exit non-zero, no tick, and the
  season stays paused until someone looks.

  The previous cadence was **every 1 minute**, which produced 252 ticks in 17
  hours and, against a real market, would have had agents "trading" at 03:00 on
  a Sunday at prices that were not moving because nothing was moving them.

- **Scoring: daily 23:30 UTC**, half an hour after the tick. It ran every 5
  minutes while ticks arrived every minute; with one tick per trading day that
  would be 288 runs a day recomputing identical inputs, each appending a score
  row per agent and making a chart's density a function of the cron interval
  rather than of the market.
- **$ARCA reminder: daily 09:00 UTC** (16:00 WIB). Once a day matches the
  granularity of the stages themselves — H-3 / H-1 / H-0, each sent at most once
  per subscription — so a tighter interval would only re-scan rows already
  marked. The hour is an operations choice: it lands in the WIB afternoon, so a
  failed run is seen the same working day.
- **$ARCA payout: RETIRED 2026-09-10.** It ran daily at 10:00 UTC and always
  reported the same deliberate stand-down, because the token has not launched.
  It is gone now for a different reason: the marketplace is P2P with no fee, so
  a payment never reaches ARCANA and there is nothing to split or pay out. The
  service and timer files were removed, not merely disabled.
- **Chain guard: every 4 hours.** Four hours because it is the minimum agent
  cadence, so the guard runs at least once between any two decisions an agent
  can make. Unlike the tick watchdog it has nothing to wait for — the chain does
  not close and no later retry can make a finding go away.
- **Agent DNA: daily 23:45 UTC**, after the tick (23:00) and the score batch
  (23:30). The fingerprint averages an agent's recorded history in its current
  season, so one more tick barely moves it; running more often would re-read
  every market snapshot to produce nearly the same vector. It ran at 11:00 UTC
  when ticks arrived every minute and any hour was as good as any other; with one
  tick per trading day there is exactly one moment when new conduct exists to
  fingerprint. See [agent-dna.md](./agent-dna.md).

The $ARCA reminder timer uses `Persistent=true`, so a run missed while the VPS
was down fires at the next boot. A late reminder still helps a user renew.

### The reminder job runs for real; the payout job is gone

This section used to describe **two** $ARCA jobs standing down until the token
launched. Only one is left.

The **payout** job was retired on 2026-09-10, and not because it was still
waiting: the marketplace is now P2P with no fee, so a payment never reaches
ARCANA and there is nothing to split or pay out. Its service and timer files
were deleted rather than disabled.

The **reminder** job is the one that was always different, and it is worth not
confusing the two: it touches only the database — no chain, no keys — so it
genuinely runs today. It reports `{"reminded":0,"grace":0,"expired":0}` while
there are no subscriptions, and it is what writes the
`active → grace → expired` transitions that `GET /v1/arca/access` reads.
**That makes it load-bearing, not dormant.**

A job that stands down deliberately still exits **0**. A deliberate stand-down
is not a failure, and a unit showing `failed` daily for a year would train
everyone to ignore it. A real fault — arca-service down, HTTP 5xx, unparseable
reply — exits non-zero and logs to stderr. `infra/systemd/arca-job.sh` is what
tells the two apart; plain `curl -fsS` cannot, because both return 2xx and the
difference is inside the JSON body.

Entitlement **gating** still waits on the token: `ARCA_TOKEN_ADDRESS` and
`ARCA_RPC_URL` are empty, so every check passes and says so. See
[arca-go-live.md](./arca-go-live.md) — but read its banner first: sections 1-4
of that checklist are superseded and must not be followed.

To change the cadence, edit the `[Timer] OnCalendar=` lines and the
`HUMAN_WINDOW` in the service file, then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart arcana-cadence.timer arcana-scoring-job.timer
```

## Which competition is scheduled?

`arcana-cadence.service` hardcodes `COMPETITION_ID`. To add another
competition, copy the unit, change the id and the lock path
(`/tmp/arcana-cadence.lock` → unique per unit), and re-run the installer. The
cadence no-ops safely on a completed competition, and on one whose interval
has not elapsed.

It also carries `CADENCE_INTERVAL`. Setting it below **4h** is refused at
startup rather than clamped — see [cadence.md](./cadence.md) for why that is
arithmetic rather than policy.

## Overlap protection

Every job unit is `Type=oneshot`, and overlap is guarded by **two independent
layers**. They cover different things, and it is worth knowing which is which:

| Layer | Covers | Does not cover |
|---|---|---|
| **systemd** | A timer firing while the previous run of the *same unit* is still going — systemd refuses to start a second instance. | Anything that does not go through systemd. |
| **flock** | Any concurrent run at all, including a manual invocation or another script — the lock is held for the entire command. | Nothing, provided every caller goes through the unit or takes the same lock. |

Every job unit wraps the command in a non-blocking lock, so the lock is held
for the whole run:

```
ExecStart=/usr/bin/flock -n /tmp/arcana-arca-reminder.lock /home/ubuntu/arcana/infra/systemd/arca-job.sh reminder ...
ExecStart=/usr/bin/flock -n /tmp/arcana-cadence.lock /home/ubuntu/arcana/scheduler-bin/cadence -competition ... 
```

If a run is already in progress the new one fails immediately (exit 1, visible
in the journal) instead of stacking. It mattered most for the payout job, which
sent money; that job is now retired, and the reasoning is kept because it
applies to any job that moves funds — the signer, when it arrives.

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

A healthy scheduler log shows one cycle per trading day:

```
session 2026-09-08: snapshot-20260908-eod (polygon, 50 symbols, live)
tick 12 opened for d0653071-...
AI agent ... executed
tick 12 left open for human submissions (window 1h)
tick 12 closed for d0653071-...          # by the 01:00 run
```

On a weekend or a market holiday, the same run says so and stops:

```
market closed today; no session, no tick for d0653071-...
```

That exits **0**. A day with no trading is not a failure. What is a failure looks
like this, exits non-zero, and opens no tick:

```
ERROR: could not obtain today.s market snapshot: ... - no tick opened, competition paused
```

A healthy scoring log shows `{"processed":N,"skipped":0}` once a day at 23:30.

## Known VPS state

- Orvix is decommissioned (2026-09-09): its units are stopped and disabled and
  its PM2 process removed, so the host no longer reports `degraded` from
  `orvix-treasury-health.service`. `/opt/orvix` is deliberately retained — see
  the shutdown notes in that task's report; it holds live treasury wallet
  addresses and Supabase credentials for a ledger that may still owe third
  parties.
- Marketplace discovery reads `score_snapshots` live (DISTINCT ON latest per
  agent), so its displayed score advances with every scoring run with no manual
  trigger.
