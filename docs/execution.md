# Execution: from a decision to what the chain actually did

Until phase 8b a decision **was** the outcome. `applyIntent()` settled the trade
against snapshot prices in memory, so the recorded position was arithmetic on a
number the platform chose, and a trade that could not settle was written down as
a hold.

That is defensible for virtual capital and indefensible once a transaction is
broadcast. A swap can be signed, paid for, mined, and revert. Gas is gone,
nothing moved, and "hold" is not what happened.

## The chain, end to end

```
decision engine decides  (LLM or a deterministic strategy)
  -> intent, through buyableQty() and the agent's own risk limits
  -> broker reads the chain: balances, allowance, gas reserve
  -> quote, by eth_call of the EXACT calldata that will be signed
  -> signer signs                      (the only process that can)
  -> broker broadcasts                 (the signer never does)
  -> receipt read back FROM THE CHAIN
  -> executions row, written from the receipt and a balance delta
  -> decision + portfolio snapshot, written from what happened
```

Two properties hold all the way along:

**Nothing writes down what it expected.** The fill is measured as the balance
delta of the output token across the transaction, not decoded from the router's
return value: the balance is what the agent can spend next tick. The quote is
kept beside it so the two can disagree *on the record*.

**Holdings and cash come from the chain.** For an agent with a wallet, the
portfolio is not arithmetic at all — `Broker.Read` returns what the wallet holds
and that is what the snapshot records. The next decision is therefore made from
the same numbers the next transaction will be checked against.

## Which settlement layer

The branch is the presence of an `agent_wallets` row, not a flag. An agent with
no wallet settles the way every season has settled so far. An agent **with** a
wallet and no broker configured is **refused**, rather than settled virtually —
there must be no configuration under which funds sit on chain while a portfolio
is computed from arithmetic.

## The outcomes, and why two of them are new actions

| `executions.status` | `decisions.action` | what it means |
|---|---|---|
| `mined` + a measured fill | `buy` / `sell` | funds moved |
| `reverted` | `trade_failed` | mined and failed: gas paid, nothing moved |
| `unresolved` | `trade_unresolved` | broadcast, not mined inside the wait |
| `refused` | `trade_failed` | the signer declined; nothing was sent |
| `quote_failed` | `trade_failed` | the simulation reverted; nothing was sent |
| `blocked` | `trade_failed` | a precondition failed; nothing was sent |

`trade_failed` and `trade_unresolved` are **not holds**. The agent tried, and
recording that as "it chose to do nothing" is a lie the record cannot recover
from, because nothing else in the row says a transaction ever existed.

Downstream consumers filter explicitly on `buy`/`sell`/`hold`, so the new values
degrade correctly without any change to them: counted as a decision, never
counted as a trade, never mistaken for a deliberate hold. The first real run
produced 8 decisions and 1 trade, with two `trade_failed` rows between them, and
the autopsy reported exactly that.

### `unresolved` is a state, not a failure

A broadcast transaction that has not been mined inside the wait is neither a
success nor a non-event. It is recorded as `unresolved` with its hash, and
**nothing is retried**. A swap that has been signed and sent carries a nonce;
sending it again, or sending a replacement, is how one intent becomes two fills.

## What the caller may not cancel

Once `eth_sendRawTransaction` returns, the rest of the cycle runs on a context
**detached from the request**. A client disconnecting or a handler deadline
expiring at that moment would otherwise leave a real, paid-for transaction with
no row describing it — the one outcome this path exists to prevent, arriving
disguised as a timeout.

The same applies to the `executions` insert, and the execution row is written
**before** the decision: a crash between them leaves an orphan row naming a real
transaction hash, which is recoverable. The other order would leave a decision
claiming a trade with nothing on chain to check it against.

## Custody drift

The check compares what ARCANA last recorded against what the wallet holds, and
only when a prior snapshot exists. With nothing recorded there is no claim to
disagree with, and reporting "no drift" from an absent record is reading a green
light off an unplugged lamp.

It is **not an error**. For a wallet whose key the owner also holds, moving funds
is something they are entitled to do; halting on it would mean the platform
stopping because a user used their own money. It is recorded because an
unexplained balance change is the hardest thing to reconstruct afterwards.

Everything is compared in **base units**, because `custody_drift` stores
`numeric(78,0)`. The first version wrote dollars and shares into it, Postgres
rounded them to integers, and a wallet holding $9.79 was recorded as expecting
10 while a 0.0061 AAPL drift was recorded as a drift of zero — rows that look
like findings and carry no information.

The tolerances are the precision of the **recorded** side, not a number chosen
for convenience:

- cash: half a cent, because `portfolio_snapshots.cash` is `numeric(20,2)` and a
  claim of "9.79" was never a claim about the third decimal
- holdings: a billionth of a share, far above float-to-integer error and far
  below any movement that matters

It has fired on real movement: funds were moved out of a funded agent's wallet
with the owner's key, and the next cycle recorded `CASH` expected 9.79 observed 0
and `AAPL` expected 0.00614483287630944 observed 0.

## Timeouts

A chain-backed cycle reads ten balances, may send an approval, sends a swap, and
waits for two receipts. The execute handler's deadline was fifteen seconds — the
right bound for read-decide-insert and far too short for this, and it surfaced
as `append decision: context deadline exceeded`, a database-shaped message for a
limit that had nothing to do with the database. It is now four minutes when a
broker is attached and fifteen seconds when one is not.

`LLM_TIMEOUT_MS` needed raising for the same reason: MiMo routinely takes longer
than 30s, and the decider was standing down with `llm_unavailable` — correct
behaviour, wrong bound.

## The pool fee comes from the pair

The signer read the fee tier from `token_out`. That is right for a **buy** —
`token_out` is the stock token, which carries `pool_fee` — and silently wrong
for a **sell**, where `token_out` is the quote token and its allowlist entry has
no `pool_fee` at all.

A fee of `0` is not a fee tier. The router derives the pool address from it,
derives an address with no contract at it, and reverts with no message for about
30,000 gas. **Every sell this service would ever have signed did that**, and the
only reason nobody noticed is that the first real trade was a buy.

The fee is now taken from whichever side is not the quote token, and a pair
without exactly one such side is refused. A resolved fee of zero is also refused
rather than signed: the transaction is guaranteed to revert, and signing it
spends the agent's gas to discover something knowable for free.

Two real sells cost gas and moved nothing before this was found. Both are in the
record as `trade_failed`, which is how it was found.
