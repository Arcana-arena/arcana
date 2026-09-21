# Roadmap

What ARCANA is today, what is being built next, and one direction that is being
evaluated rather than built.

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

## ARCANA CAPITAL — a second product, under evaluation

> **Nothing in this section is live, and none of it is committed.** It is a
> direction being evaluated. It depends on a technical fact that has not been
> checked on chain yet — stated plainly at the end of this section. Read it as
> a question being asked, not as a plan being executed.

### The idea

Agents that do not only trade, but manage capital: collateral, debt and risk,
under a mandate their owner writes.

A mandate of that kind might read: *keep a tokenized stock position as
collateral without selling it; hold a minimum health factor; borrow USDG for
liquidity at the lowest available rate; deploy idle USDG only when expected
yield exceeds the cost of borrowing; and reduce debt automatically as
liquidation risk rises.*

Four capabilities are under consideration:

| | |
|---|---|
| **Autonomous borrowing** | Use tokenized stocks and other RWAs as collateral without selling the underlying asset. |
| **Autonomous refinancing** | Continuously compare borrowing markets and move to more efficient terms. |
| **Autonomous debt repayment** | Direct portfolio yield and cash flow toward reducing debt, as the mandate specifies. |
| **Autonomous risk protection** | Watch collateral ratio, borrowing cost, volatility and liquidation risk, and act inside limits the user set. |

### What would make it different: reputation

PayFi-style protocols already do parts of this. What none of them carry is a
track record that can be compared.

A capital-management agent would have its own ARCANA Score — capital managed,
liquidations, average borrowing cost saved, maximum drawdown — and would
compete through the same marketplace mechanism trading agents already use. The
output is a ranked, comparable record of what an agent actually did, rather
than a protocol nobody can grade.

That opens categories beyond trading: **Trading, Portfolio, Yield, Risk, Debt
and Treasury** agents, all measured by the same infrastructure. The long-term
shape is an *AI family office*: a research agent surfacing opportunities, a
trading agent choosing entry, a portfolio agent setting allocation, a risk
agent managing exposure, a debt agent managing borrowing and a yield agent
managing idle capital — all under one user's master mandate.

### The dependency that decides whether this is small or enormous

**Unverified, and it must be checked on chain before anything is committed:**
does a lending and borrowing market exist on Robinhood Chain that accepts
ARCANA's stock tokens as collateral?

- **If one exists**, this is a new intent type through the signer that already
  exists — similar in shape to how `swap_exact_in` works today. That is an
  ordinary amount of work.
- **If none exists**, this is not "add a feature". It is "build and audit a
  lending protocol": a liquidation engine, price oracle wiring and smart
  contract risk. That is a different category of risk from anything ARCANA has
  shipped, because **everything shipped so far has deliberately avoided writing
  a single new contract** — the platform swaps through pools that already
  exist and anchors to a chain it does not control.

The gap between those two answers is the whole decision, and it is a fact about
the chain rather than a matter of opinion. It has not been established yet.

### Sequencing

This would be a V2 expansion, not part of the current product. The core does
not change: build AI agents, let them compete, and measure what they actually
did.

---

## Where this page can be wrong

Two other roadmap documents exist and one of them was stale when this page was
written: [on-chain-rollout.md](./on-chain-rollout.md) still lists phase 8, the
first real swap, as waiting on the owner, and describes the frontend as not
started. Both were true once. 95 mined swaps and a live site say otherwise.

If this page and that one disagree, check the database and the chain before
believing either.
