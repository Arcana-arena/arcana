# Alerting

**Status:** live since 2026-09-10. Every alarm below has actually fired at
least once — see [Proof](#proof-every-alarm-has-rung).

This is notification, not observability. There is no Prometheus, no Grafana, no
exporter, and that is deliberate: what was missing was **somebody being told**.

## The case this exists for

On 2026-09-09 the scheduler stopped producing ticks at 18:58. It was found at
23:33, by hand. Season 2 sat at zero ticks and nothing said a word.

`OnFailure=` alone would not have caught the general form of this. A scheduler
that runs, exits 0 and produces nothing is not a failed unit — systemd has
nothing to report. The symptom that matters is **"no tick on a day the market
was open"**, and with one tick per trading day a missed day cannot be patched
later: the backfill-vs-replay rule forbids filling a scored season backwards
(see `docs/market-data.md`). A silent day is a permanent hole in the record, and
a hole in the record damages precisely what this platform sells.

So there are two layers.

---

## Layer 1 — `OnFailure=` on every job

Seventeen units declare `OnFailure=arcana-alert@%n.service`:

| Unit | What it does |
|---|---|
| ~~`arcana-scheduler`~~ | **RETIRED 2026-09-11.** Opened one tick per US trading day. Stock Tokens trade against a pool that never closes, so a calendar-driven tick stood still through two thirds of every week. Replaced by `arcana-cadence`. |
| `arcana-scoring-job` | ARCANA Score batch |
| `arcana-agent-dna` | DNA fingerprint batch |
| `arcana-marketdata` | the market data service itself |
| `arcana-arca-reminder` | subscription reminders |
| `arcana-chain-guard` | Stock Token issuer-control drift (layer 3 below) |
| `arcana-cadence` | opens and closes a pool-priced tick every four hours: the marked window the leaderboard and standings read. Alerts on a failed run. **It no longer decides for anybody** (2026-09-20), so the old "no agent executed" refusal is gone with the loop — agents are on their own clocks and most are legitimately not due in any given tick. The question that refusal was reaching for is the decision watchdog's, and it asks it better |
| `arcana-pace` | asks every agent whose OWN cadence has elapsed to decide (`agents.cadence_seconds`). The only caller of the decision engine. Alerts on a failed run, and on a run where agents were due and **none** of them decided — one agent failing is that agent's business and is logged as such; all of them failing is the platform's |
| `arcana-cadence-b75adb8d` | the same cadence for the second Season 2 competition; alerts on the same conditions, and opens nothing while nobody has entered |
| `arcana-decision-watchdog` | asks whether a DECISION has been recorded in the last twelve hours. Replaces the tick watchdog's question, which was about a market calendar that no longer exists |
| `arcana-execution-watchdog` | asks whether the money is MOVING or just burning: repeated trade failures, a wallet that can no longer pay for gas, transactions the record has no row for. The decision watchdog cannot see any of these — the agent decides on time, the transaction reverts, and decisions keep being recorded |
| `arcana-capital-watchdog` | asks whether any BORROWING position is close to liquidation: under its floor, under 1.2, or no longer being read. The page colours it; this says it to somebody who is not looking at the page |
| `arcana-guard` | the take-profit / stop-loss watcher itself. It refuses to start without a signer rather than run as a process that can see a level cross and do nothing, so a failure to start is an alert and not a restart loop nobody reads |
| `arcana-guard-watchdog` | asks whether that watcher is still WATCHING, by reading the heartbeat it writes on every scan. A stop loss is protection an owner stops thinking about, so the moment it stops working nothing changes visibly |
| `arcana-signer` | the isolated key-custody service |
| `arcana-backup` | daily full backup |
| `arcana-backup-verify` | weekly restore rehearsal |
| `arcana-error-watch` | reads the journals of agent, arca, marketplace and web every ten minutes and alerts on new server errors (`ExceptionsHandler`, `QueryFailedError`). A service answering requests with 500s is an active unit, so `OnFailure=` alone cannot see it — the earnings read failed for every creator for a day that way |
| `arcana-anchor` | writes the next Merkle root of decision commitments on chain every fifteen minutes. Alerts when anchoring has worked before and cannot now (unfunded wallet, signer refusing, broadcast failing); before the first anchor ever lands, an unfunded wallet is left to `anchor-verify` rather than alerted every run |
| `arcana-anchor-signer` | the anchoring signer: one key, not derived from the agent seed, one transaction shape (a self-send carrying a root) |
| ~~`arcana-tick-watchdog`~~ | **RETIRED 2026-09-11.** Asked "was there a tick on a day the market was open" — a question about a calendar that no longer exists. Replaced by `arcana-decision-watchdog`, which asks whether a DECISION has been recorded in the last twelve hours. |

One template rather than one handler per unit, because a second copy would
drift — and this table has now drifted on its own twice, in both directions. It
named `arcana-arca-payout` after that unit was deleted with the §10 retirement,
and omitted `arcana-chain-guard` and `arcana-signer`, both of which do alert.
Then on 2026-09-11 it fell behind again, omitting `arcana-execution-watchdog`
and the two new guard units — caught by the check below on the deploy that
introduced them, which is the check working rather than the document being
reliable. `install.sh` now derives the comparison from the unit files and says
so, because a monitoring document that names a unit which cannot fail, and
omits one that can, is a list somebody checks against and is reassured by.

### What an alert contains

Enough to act on **without opening the VPS**. An alert that only says
"something failed" forces the reader to log in before they know whether it
matters, which delays the response at the moment response time counts.

```
🔴 ARCANA: arcana-backup-verify.service failed

host: VM-7-119-ubuntu
unit: arcana-backup-verify.service
when: Thu 2026-09-10 00:56:55 WIB
exit: code=1 (1), result=exit-code

last 12 log lines:
  …
  restore-test: ERROR: no archive found (looked in /home/ubuntu/arcana-backups/does-not-exist/daily)
  arcana-backup-verify.service: Main process exited, code=exited, status=1/FAILURE

next: journalctl -u arcana-backup-verify.service -n 50 --no-pager
```

---

## Layer 2 — the decision watchdog

`arcana-decision-watchdog.timer`, every six hours at **:15**. It asks whether a
DECISION has been recorded in the last twelve hours — three missed four-hour
intervals.

It replaced `arcana-tick-watchdog` on 2026-09-11, which asked whether a trading
day had passed with no tick. That question needed a market calendar, and there
is no longer one: Stock Tokens trade against a pool that never closes. Six
hours is chosen against the twelve-hour alarm threshold rather than against the
cadence, so the condition is always seen within half the window it describes.

Measuring **decisions rather than ticks** is the improvement worth naming. A
tick that opened and closed with every agent failing inside it is exactly the
silent fault this exists to catch, and it looks perfectly healthy to anything
counting ticks.

### Who decides what a trading day is — not this watchdog

- **Which date to ask about** comes from market-data's
  `GET /v1/market/session/expected`, which calls the same
  `session.LastCompleted` the daily fetch uses. Weekends are handled there,
  structurally (`PreviousWeekday`).
- **Whether the market actually opened** is the vendor's answer, and its
  permanent trace is a stored snapshot carrying that `trading_date`.

A second calendar here would eventually disagree with the thing it watches,
which is worse than no watchdog.

**Read-only by construction.** It never calls
`POST /internal/v1/market/sessions/daily` — that endpoint fetches from the
vendor and *creates* a snapshot. A monitor must not mutate what it observes.

### Decision tree

```
D = expected trading date (from market-data)

live snapshot with trading_date = D ?
├─ YES → does a competition_tick cite that snapshot?
│        ├─ YES → healthy, silent
│        └─ NO  → 🔴 ALARM "trading day with no tick"   ← the case above
└─ NO  → why is there no snapshot?
         ├─ scheduler ran cleanly (result=success AND exit=0) after D 22:00 UTC
         │  → healthy, silent   (vendor said closed: weekend or holiday)
         ├─ scheduler has not completed a run since D's close
         │  → 🔴 ALARM "scheduler did not run"  (the timer itself is dead)
         └─ scheduler's last run failed
            → silent — OnFailure= already sent that alert; never twice
```

`COMPETITION_ID` is read from the scheduler's own unit
(`systemctl show arcana-cadence.service -p Environment`), so there is **one**
declaration of the active competition and no second place to forget.

Both `Result` **and** `ExecMainStatus` are checked, not either:
`systemctl reset-failed` clears `Result` to `success` while the real exit code
survives, so an operator tidying up a red unit would otherwise make a failed run
look clean to the watchdog.

---

## Layer 3 — the chain guard

`infra/alerting/arcana-chain-guard.mjs`, every four hours via
`arcana-chain-guard.timer`. Added 2026-09-10 with the
[on-chain direction](./on-chain-direction.md).

**The case it exists for.** Every Robinhood Stock Token ARCANA can trade is a
beacon proxy, and all nine point at the **same beacon and the same
implementation** — verified across all nine, not inferred from one. A single
upgrade transaction rewrites the transfer rules for every Stock Token at once.

Today those rules are a **blocklist**: permissive by default, deny named
addresses. That is the only reason a wallet ARCANA creates can trade at all
([go-no-go-stock-tokens.md](./go-no-go-stock-tokens.md)). An upgrade could make
it an **allowlist** — deny by default — and nothing inside ARCANA would show it
until an agent's trade started reverting and its owner asked why.

**What it reads**, per token: the beacon pointer in the token's own storage
slot, `implementation()` on the beacon, `paused()`, and the routed pool's
`liquidity()`. Once wallets exist (phase 8) it also reads `isBlocked()` for each
of them.

### The baseline is in git, not in the database

`infra/alerting/chain-baseline.json`, reviewed and dated by a person.

A monitor that remembers what it last saw will, on its first run after a change,
adopt the new value as normal — and stay silent at the one moment it existed to
speak. A committed baseline means a change requires somebody to look at it, date
it and say so. Same reasoning as the market universe living in git rather than
in `.env`: this is a rule, not a setting.

### Two failures found while building it, both worth keeping in mind

**A fallback that could not serve the workload.** `robinhood.drpc.org` was
listed as a second RPC endpoint. It answers `eth_chainId` and **refuses**
`eth_call` and `eth_getStorageAt` on its free tier — so it satisfied the chain
identity check and then failed every real read. Listed as redundancy it provided
none, and made a single point of failure look like two. The guard now **probes
each endpoint with the methods it actually uses** and drops what cannot serve
them, loudly.

**One transient hiccup read as a monitor fault.** Each run makes around forty
RPC calls against a free public endpoint. Without retries, a single dropped
connection produced exit 1 — "the check could not run" — which on a four-hour
timer would have meant regular alerts that were nobody's fault. That is the
alert-fatigue failure this whole document is built around. Calls now retry with
backoff across the surviving endpoints before anything is declared a fault.

Both were found by running the verification suite repeatedly rather than once.
A monitor that passes its tests on the first attempt and fails on the third is
not passing.

### Proven to fire

`bash infra/verify/chain-guard-verify.sh` exercises every branch against the
**live** chain, injecting drift through test hooks. Nothing is mocked — real
addresses, real RPC, real baseline — only the compared value is forced.

| Case | Expected | Result |
|---|---|---|
| Baseline matches the chain | exit 0, silent | ✅ |
| Implementation changed | exit 0, **alarm** | ✅ all 9 tokens, from one injected change |
| Token paused by the issuer | exit 0, **alarm** | ✅ |
| Every RPC endpoint unreachable | **exit 1** | ✅ never reported as healthy |
| Connected to the wrong chain | **exit 1** | ✅ |
| Baseline file missing | **exit 1** | ✅ |
| Alert body names the action to take | present | ✅ *"STOP funding new agent wallets"* |

The nine-from-one row is the point of the whole layer: it is what a real
upgrade would look like.

---

## What is deliberately silent, and why

A false alarm is more dangerous than no alarm. Somebody woken every Saturday by
a check that is usually wrong will silence it permanently — and then the real
one is silenced too.

| Condition | Why it is not an alert |
|---|---|
| **Weekend / market holiday** | No session is the healthy answer. The vendor is the calendar; the scheduler still runs and exits 0. |
| **Payout no-op** | `$ARCA` has not launched, so the batch stands down on purpose and exits 0. `arca-job.sh` already separates "deliberately disabled" from "broken"; this reuses that, it does not add a second mechanism. |
| **Backup with no off-site copy** | Exits 0 with a loud `WARN`. Failing the unit daily would train everyone to ignore a red timer. See `docs/backup-restore.md`. |
| **Competition `completed`** | The scheduler is meant to no-op. |
| **Scheduler failed** (from the watchdog) | `OnFailure=` already sent it. Two alerts for one event is how alert fatigue starts. |
| **`MARKET_VENDOR_API_KEY` not set** | See below. |

### The vendor mute lifts itself

While the vendor key is absent the scheduler fails every run, for a reason
already known. That is muted — but the mute is **derived from reality, never
from a switch**:

```sh
vendor_key_present()   # reads services/market-data/.env
&& logs contain "vendor_not_configured"
```

**Both** conditions must hold. A scheduler that dies for any other reason still
alerts, even while the key is missing.

A manual "mute alerts" flag would be a switch somebody forgets to turn off, and
an alarm silenced by a forgotten flag is the same class of failure as the silent
failure this work exists to close. Fill in `MARKET_VENDOR_API_KEY` and the mute
lifts by itself, with nothing to remember. Proven: identical failure, identical
logs, key empty → 0 alerts; key present → 1 alert.

---

## Channel

**ntfy.sh**, topic in `/home/ubuntu/arcana/.env.alerts` (mode 600, never
committed, never inline in a unit file).

> On ntfy.sh **the topic name IS the credential**. Anyone who knows it can read
> these alerts and publish fake ones, so it is 32 random hex characters. Alert
> bodies carry unit names, exit codes and log lines — no secrets, since those
> live in `.env` files and are never logged — but a third party does see them.

Subscribe at `https://ntfy.sh/<topic>` in a browser, or in the ntfy mobile app.

Telegram can replace this later if more privacy is wanted; the design is
unchanged, only the transport in `arcana-notify.sh` differs.

Test delivery at any time:

```sh
set -a; . /home/ubuntu/arcana/.env.alerts; set +a
/home/ubuntu/arcana/infra/alerting/arcana-notify.sh test
```

---

## Silencing during maintenance

Do this rather than editing units, so nothing is disabled permanently by
accident.

**Mute everything for a planned window:**

```sh
sudo systemctl stop arcana-decision-watchdog.timer      # stop the silent-failure check
sudo systemctl mask 'arcana-alert@*.service'            # stop OnFailure= alerts
# ... maintenance ...
sudo systemctl unmask 'arcana-alert@*.service'
sudo systemctl start arcana-decision-watchdog.timer
```

**Mute one noisy unit** — comment out its `OnFailure=` with a drop-in, which
`systemctl cat` will show, unlike an edit buried in the unit file:

```sh
sudo systemctl edit arcana-scoring-job.service
#   [Unit]
#   OnFailure=
```

**Re-arming is the part people forget.** After any maintenance:

```sh
systemctl show arcana-cadence -p OnFailure --value      # expect arcana-alert@...
systemctl is-active arcana-decision-watchdog.timer      # expect active
/home/ubuntu/arcana/infra/alerting/arcana-notify.sh test
```

---

## What is deliberately NOT monitored

Stated so nobody assumes coverage that does not exist.

### 1. Total loss of the VPS — the worst case, and it is silent

Every alert here is pushed **from** the host. If the host dies, so does the
thing that would report it. **Nothing in this design catches a dead VPS.**

Closing it needs a dead-man's switch: an external service that expects a
periodic ping and alarms when the pings *stop*. `HEALTHCHECK_PING_URL` already
exists in `.env.alerts`, deliberately empty, waiting for a healthchecks.io
account. Until it is filled in, assume a dead server is a silent server.

This compounds with `docs/backup-restore.md`: backups are also still on this
host only. A VPS loss today is silent **and** unrecoverable.

### 2. The vendor's own calendar

If the vendor wrongly reports a trading day as closed, no snapshot is stored,
the scheduler exits 0, and the watchdog agrees everything is fine. That is the
cost of using the vendor as the calendar — and adding a second calendar would
create a source of disagreement rather than a safety net.
`docs/market-data.md` already flags grouped-daily behaviour on non-trading days
as unverified against the real vendor.

### 3. The main watchdog branch has never fired on real data

All 260 production snapshots are from the simulator era and carry
`trading_date = NULL` (migration 0021 added the column without backfilling), so
"session exists but no tick" cannot occur yet. It was proven on a throwaway
database. **It becomes live the first day the vendor key is set** — expect the
first real exercise of this branch then.

### 4. Service health, latency, disk, memory, certificates

Nothing watches whether the six services are *serving*, only whether their units
failed. `/healthz` returns a constant and does not touch the database, so a
service with a dead database still reports 200 (see the audit's B2). No disk,
memory or latency thresholds. No dashboards. All of that is a monitoring stack,
which this task deliberately is not.

### 5. Alert delivery itself

If ntfy.sh is down or the topic is wrong, `arcana-notify.sh` logs an error and
exits non-zero — visible as a failed `arcana-alert@…` unit on the host, but by
definition not deliverable as an alert. The dead-man's switch would cover this
too.

---

## Proof: every alarm has rung

A gate that has never refused anyone has not been tested. Neither has an alarm
that has never sounded. All of these were run for real, and delivery was
confirmed by reading the messages back off the topic.

| Test | Expected | Result |
|---|---|---|
| Real unit failure (`backup-verify` at an empty backup root) | alert with cause | ✅ delivered, naming `no archive found …` |
| Payout no-op (token not launched) | silent | ✅ 0 alerts, exit 0 |
| Scheduler fails, vendor key **empty** | muted | ✅ 0 alerts, mute logged |
| Same failure, vendor key **present** (test rig) | alerts | ✅ 1 alert — mute lifts from real state |
| Watchdog: session exists, no tick | **alarm** | ✅ delivered |
| Watchdog: session exists, tick exists | silent | ✅ 0 alerts |
| Watchdog: weekend/holiday | silent | ✅ 0 alerts |
| Watchdog: scheduler never ran | **alarm** | ✅ delivered |
| Watchdog: scheduler exited non-zero | silent (no double alert) | ✅ 0 alerts |

### A false alarm found by testing against production

The first production run of the watchdog raised *"scheduler did not run"* on a
day it had run fine. `systemctl` formats its timestamps in the host's local zone
using an abbreviation — here `Thu 2026-09-10 00:57:51 WIB` — and GNU `date -d`
cannot parse `WIB`. The parse returned nothing, the run looked infinitely old,
and the alarm fired.

That would have been a **false alarm every single day**, which is worse than no
watchdog: an alert that is usually wrong gets silenced, and the real one with
it. It was caught only by running against production rather than trusting the
branch tests, which had supplied their own timestamps in UTC.

Fixed by reading the timestamp with `TZ=UTC` so systemd prints a parseable zone,
and by making an unparseable timestamp a **check failure** rather than a default
of zero — a monitor that cannot check must say so, not invent the failure it was
built to detect.
