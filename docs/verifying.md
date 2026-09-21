# Checks that cannot pass by accident

Rules this project arrived at by having checks pass while the thing they checked
was broken. Each one is here because it already happened.

## 1. A check must not be able to match itself

**`pgrep -f cycle-watch.sh` matched the `pgrep` command that was looking for it.**

A watcher was started with `nohup` and never actually came up. It was confirmed
alive with `pgrep -f cycle-watch.sh`, which returned a PID — the PID of the
`pgrep` process, whose own command line contains the string being searched for.
The check proved its own existence. The watcher was dead for hours, and the
first sign of it was the absence of output nobody was looking for.

> A check that matches its own inspecting command proves that the check exists,
> not that the thing it went looking for does.

**What to do instead.** Ask the supervisor, not the process table:

```sh
systemctl is-active arcana-cycle-watch     # active | inactive | failed
systemctl show -p NRestarts arcana-cycle-watch
```

Every long-running process in this system is a systemd unit for this reason. A
unit has a state that something other than the checker maintains, it restarts on
its own, and `is-active` cannot accidentally be satisfied by the act of asking.

If a process table really must be searched, exclude the searcher and match the
executable rather than the string: `pgrep -x`, or `pgrep -f -- "$pat" | grep -v
$$`. Prefer not needing to.

## 2. A check must not be satisfied by a stranger

**A verify suite found an orphan from its own previous run and measured that.**

`cost-budget-verify` starts a decision engine on port 8093 and polls `/healthz`.
Two separate bugs combined:

- the suite called `process.exit(1)` **inside a `try`**, which skips `finally`,
  so a failing run cleaned up nothing;
- it started the engine with `go run`, whose child holds the port after the
  parent is killed.

A failed run therefore left an engine listening. The next run's health check was
answered by that orphan — configured by a run that had already ended, with the
cost meter switched off — and eleven checks failed for a reason that had nothing
to do with the meter. It cost several rounds of debugging the wrong thing.

**What to do instead.**

- Build the binary and spawn it directly, so the process you kill is the process
  that listens. `go run` is a parent, not the server.
- Refuse to start if the port is already answering. A suite that finds something
  alive where it was about to put its own subject has not found a convenience;
  it has found a reason to stop.
- Never `process.exit()` inside a `try` that owns cleanup. Set a flag; exit after
  the `finally`.

## 3. A check must be able to fail

`[].every(...)` is `true`. A guard that compares "every floor found in the SQL"
against an expected value passes when it finds no floors at all — which is
precisely the regression it exists to catch. Assert the sample size as part of
the assertion.

The same rule kills the more common version: a suite whose interesting branch is
never taken. `prompt-injection-verify` wrote mandates demanding 100% of NAV and
confirmed the system was unharmed — on a flat market, where the model held every
time and the clamp was never reached. It proved the system survived a hostile
prompt and proved nothing about the clamp. `clamp_test.go` exists because of it.

## 4. Prove a brake by exceeding it, not by reading the branch

Every limit in this system has been driven past on purpose at least once:

| brake | how it was proved |
|---|---|
| token meter | a budget exhausted until the refusal appeared |
| signature cap | the signer actually restarted, and the count survived |
| cost meter | `$5` of real rows against a `$2` budget, and separately a projection over a 48-hour sample |
| alerting | the alarm was fired for real through ntfy, HTTP 200 |
| dust floor | the readers were each handed a residue, with a control that must still register a real position |

Twice this found fail-open bugs that code review had passed: `CapitalOf`
swallowing a scan error as "no snapshot" (which permits), and approval gas being
discarded so 26% of an agent's spend had no row anywhere.

## 5. A passing control is part of the result

A check that something is ignored must sit next to a check that something
similar is **not** ignored. "The residue did not change the fingerprint" passes
just as happily if the fingerprint stopped being computed. The control — a real
position in the same shape, which must change it — is what makes the first
result mean anything.

## 6. Verify on chain, not on exit code

A transaction that returns success from the broadcast call has not happened yet.
Read the receipt, then read the balance, then compare against what was recorded.
`executions` holds what was broadcast; the wallet holds what is true.
