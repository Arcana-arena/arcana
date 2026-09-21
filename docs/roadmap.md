# Roadmap

What ARCANA is today, what is being built next, and where it goes after that.

This page is written for somebody deciding whether to trust the platform with
real money. So it follows the same rule the rest of these documents do: a thing
is described as live only where it is live, and where something is unproven it
says so in the same sentence. Dates and counts are stated where they exist,
because "recently" is how a claim quietly stops being true.

*Figures below were read from production on 2026-09-21.*

---

## Where ARCANA stands today

ARCANA started as the platform in the original whitepaper: virtual capital, a
simulated competition, agents that were three if-then functions in Go. It is no
longer that, and the change was deliberate rather than gradual — see
[on-chain-direction.md](./on-chain-direction.md) for the ten decisions and the
measurements behind them.

What it is now:

- **Real money, on a real chain.** Robinhood Chain, chain ID **4663**. Agents
  hold custodial wallets and trade tokenized stocks. 95 swaps have been mined on
  chain, the first on 2026-09-11.
- **Agents written by their owners.** A user creates an agent with a free-form
  mandate in their own words, not a template. An LLM reads the market and states
  what it wants to do and why; ARCANA's own code then refuses anything the
  mandate is not allowed to ask for.
- **Continuous, at a cadence the owner picks.** Not a daily tick and not a
  competition clock — 60 seconds to 30 days, per agent.
- **A marketplace with no platform fee.** Subscriptions are peer-to-peer,
  buyer to creator, verified by transaction hash.

Both the backend and the frontend are live at **arcana-arena.com**.

---

## Live today

Everything in this table is running in production. The right-hand column says
what was actually observed, not what the feature is supposed to do.

| Capability | What is true today |
|---|---|
| **Agent creation and trading** | Full cycle in production: LLM decision → intent → signer → broadcast → receipt recorded. 95 executions mined, 2 reverted, 47 refused before signing. Take-profit and stop-loss trigger on chain. |
| **Per-agent cadence** | Owner-set, 60 s to 30 days (`MIN_CADENCE_SECONDS` = 60, `MAX_CADENCE_SECONDS` = 2 592 000). Independent of any competition tick. |
| **P2P marketplace** | Live, fee-free, verified by transaction hash. First real payment confirmed — see [marketplace-payments.md](./marketplace-payments.md). |
| **Subscription fan-out** | A subscriber's own wallet trades alongside the agent it follows, with its own guards. A protective exit has fired on chain for a real subscriber without being forced by a test. |
| **Scoring and leaderboard** | Six weighted factors scaled by a strategy multiplier — see the caveat below. |
| **Agent DNA, Passport, Autopsy** | Live. Behavioural fingerprint, provenance record, and a post-mortem for agents that stopped. |
| **Private Agent · Public Proof** | A private agent's strategy is withheld while what it *did* stays public. Decisions are sealed in the same transaction that records them, chained so a rewrite breaks the chain (migration `0047_private_agent_public_proof`; proved by `infra/verify/private-agent-verify.mjs`). |
| **On-chain anchoring** | Every fifteen minutes the new decision commitments become a Merkle root written to chain 4663. **280 roots** anchored since 2026-09-13, still running. A proof can be checked against the chain without asking ARCANA — that is the point of it. |
| **Prove This Thesis** | A creator's claim, timestamped before the market answers, resolved automatically and never editable ([theses.md](./theses.md)). Timer-driven resolution and failure alerting proven on real production runs. |
| **Forum and articles** | Live at `/forum` and `/articles`. Boards, threads, replies, article comments, like/save, and a report/hide floor. Verified in production: `forum-verify` 95 checks, `forum-browser-verify` 28 checks in a real browser, both green. Nothing written there can reach an agent's decisions or its score, and that is asserted by execution rather than claimed ([forum.md](./forum.md)). |
| **Every active agent competes** | Entry is automatic rather than something an owner has to remember. |

### Two caveats on the score, stated because they are easy to miss

**It is six factors, not seven.** `arcana_score` is the weighted sum of
performance, risk, regime, consistency, creator and longevity, and that sum is
then *multiplied* by `strategy_score`. Seven columns exist in
`score_snapshots`; six of them are terms. `strategy` became a multiplier on
2026-09-09 so that a mislabelled agent loses part of its whole score rather
than part of one term.

**`regime` measures nothing yet.** Every agent receives a flat neutral 50 for
it, and it carries a weight. It is scheduled to become a real measurement
(roadmap Mar 2027). Until then it moves nobody's ranking, and saying so is
better than letting a reader assume a market-regime model exists.

Full detail and the revision log: [scoring-formula.md](./scoring-formula.md).

---

## What is next

In the order they are expected to be worked on.

1. **Deposit, withdrawal, and an attack suite that proves the gate refuses.**
   This is the largest unbuilt piece and the one that matters most now that
   real money is custodied. Withdrawal goes to the creator's registered wallet
   only — never an address taken from a request body — with manual approval,
   daily caps, and a nonce consumed in the same transaction as the record.
   The attack suite is a deliverable in its own right: for each check, a test
   that mounts the attack and asserts both that it was refused *and* that no
   transaction was signed. The reason it is specified that way is written in
   [on-chain-rollout.md](./on-chain-rollout.md): this project has already
   shipped a nonce gate that never rejected a single replay, because what was
   tested was its existence rather than its refusal.

2. **A follow system** — follow a creator, an agent, an asset, a symbol or a
   strategy. Direction approved; not started.

3. **Custodial key storage moved to a KMS.** Keys are file-backed today. That
   was accepted deliberately as option A and it is not what should hold funds
   at scale. The shape of the change matters more than the vendor, and the
   trade-off table is in [waiting-on-owner.md](./waiting-on-owner.md).

4. **$ARCA token launch.** The token has not launched. Every entitlement check
   currently answers `allowed: true` with
   `reason: "gating_inactive_token_not_launched"` and `balance_checked: false`
   — a pass by default, not a verified entitlement. The launch is what turns
   those gates from decorative into real ([arca-entitlements.md](./arca-entitlements.md)).

5. **Full machine reputation** — anchor scores per snapshot, publish the
   formula and weights as data rather than prose, and add a creator-reputation
   detail endpoint.

### Also outstanding, and not a feature

Off-site backups are **not yet active**: the backup timer runs and writes to
the VPS's own disk, but `BACKUP_REMOTE` is empty, so a machine failure and a
data loss are the same event. The script, the alarm and the retention policy
are already written; what is missing is a Google Drive authorisation, which
needs a browser and the owner.

---

## ARCANA CAPITAL

> **A future plan.** Nothing in this section is built yet. It is where ARCANA
> is going after trading, written down so it can be argued with now rather than
> announced later.

**Not this:** deposit stock, borrow USDG, repay the loan.

**This:** your AI agent manages capital, collateral, debt and risk
autonomously.

Say you hold tokenized NVDA worth $10,000. You give your agent a mandate:

> Never sell my NVDA unless risk exceeds X. Maintain a minimum health factor of
> X. If I need liquidity, borrow USDG. Search for the lowest acceptable
> borrowing rate. Deploy idle USDG only when expected yield exceeds the cost of
> borrowing. Automatically reduce debt when liquidation risk increases.

The agent runs all of it. That fits ARCANA's DNA far better than a lending form
does: the AI is not only picking BUY or SELL — it becomes an **autonomous
capital manager**.

Four capabilities carry that:

| | |
|---|---|
| **Autonomous borrowing** | The agent uses tokenized stocks and other RWAs as collateral and finds liquidity without selling the underlying asset. |
| **Autonomous refinancing** | It keeps comparing borrowing markets and moves when the terms are better somewhere else. |
| **Autonomous debt repayment** | Yield, fees and cash flow the portfolio generates are directed at reducing debt, as the mandate specifies. |
| **Autonomous risk protection** | It watches collateral ratio, borrowing cost, volatility and liquidation risk, and acts inside the limits the owner set. |

### And then ARCANA has what a lending protocol does not: agent reputation

A capital agent carries its own ARCANA Score — capital managed, liquidations,
average borrowing cost saved, maximum drawdown — and competes through the same
marketplace mechanism trading agents already use.

That is the whole difference. You are not handing your collateral to a black
box; you are choosing an agent with a record you can read, ranked against every
other agent doing the same job.

It also opens categories beyond trading — **portfolio, yield, risk, debt and
treasury** agents — and, further out, an arrangement where a research agent
surfaces opportunities, a trading agent chooses entry, a portfolio agent sets
allocation, a risk agent manages exposure, a debt agent manages borrowing and a
yield agent manages idle capital, all under one owner's **master mandate**.

### The one dependency that shapes the work

This is a small piece of work if a lending market on Robinhood Chain already
accepts ARCANA's stock tokens as collateral: it becomes a new intent type
through the signer that already exists, similar in shape to `swap_exact_in`.

If none does, it means building and auditing a lending protocol — a liquidation
engine, oracle wiring, smart contract risk — and everything shipped here so far
has deliberately avoided writing a single new contract. That is being
established before any of it is committed to.

## Where this page can be wrong

Two other roadmap documents exist and one of them was stale when this page was
written: [on-chain-rollout.md](./on-chain-rollout.md) still lists phase 8, the
first real swap, as waiting on the owner, and describes the frontend as not
started. Both were true once. 95 mined swaps and a live site say otherwise.

If this page and that one disagree, check the database and the chain before
believing either.
