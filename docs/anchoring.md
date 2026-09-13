# Anchoring decision commitments on chain

## Why

Every decision is sealed with a commitment when it is recorded (migration 0047),
and the database refuses to change a sealed row. That binds the *application*.
It does not bind whoever holds the database: an operator with superuser can
drop the trigger, rewrite a decision and its manifest, and restore the trigger.
Until now "public proof" meant "trust ARCANA's database" — the one thing this
platform exists to make unnecessary.

Anchoring closes that. Every fifteen minutes the new commitments become the
leaves of a Merkle tree and its root is written into a transaction on
Robinhood Chain (4663). Once that transaction is mined, changing, deleting or
backdating an anchored decision breaks a proof anyone can check against the
chain without asking ARCANA.

## What is on chain

A zero-value EIP-1559 transaction from the anchoring address **to itself**,
whose input is:

```
0x 415243414e410001  <root, 32 bytes>
   "ARCANA" 00 01
```

No contract. Nothing is deployed and nothing needs an ABI: the root is read from
the transaction input with `eth_getTransactionByHash` on any RPC.

## The tree — `arcana-anchor/v1`

```
leaf  = sha256(0x00 || commitment)        commitment as its 32 raw bytes
node  = sha256(0x01 || left || right)
odd   = the last node of a level is carried up unchanged
order = decision id ascending
```

The 0x00/0x01 prefixes keep an interior node from being passed off as a leaf.
The odd node is carried, not duplicated, because duplicating the last leaf lets
two different leaf lists share a root.

Three implementations, on purpose: Go builds the roots
(`decision-engine/internal/store/merkle.go`), agent-service checks them
(`src/intelligence/merkle.ts`), and `anchor-verify` checks them a third time. A
proof checked only by the code that produced it proves the code agrees with
itself.

## Why a separate signer, not a third intent

`arcana-signer` holds the seed every agent wallet is derived from, and its
defining property is that a caller cannot put bytes into a transaction — no
`to`, no `data`, no `value`. Anchoring is precisely putting bytes into a
transaction. Adding it there would make that property false for the one process
that holds other people's money, and `docs/signer.md` already says a new shape is
its own decision.

So `arcana-anchor-signer` is:

- **a separate binary** (`services/signer/cmd/anchor`) sharing `internal/tx` and
  `internal/keys`, so RLP, EIP-1559 hashing and low-S signing still have one
  implementation;
- **a separate Linux user** (`arcana-anchor`), directory `/etc/arcana/anchor` at 0700;
- **a separate key**, a standalone file — *not* derived from the agent seed, so
  no agent id can reach it, and it holds only gas;
- **one shape**: the caller sends `{root, nonce, max_fee_wei, tip_wei, gas}` and
  nothing else (any other field is refused); the signer builds the self-send;
- **capped**: max fee 5 gwei, gas 21,000–150,000, 96 signatures a day, counted on
  disk before the signature is released;
- **never broadcasts** — the job does that.

The job (`decision-engine/cmd/anchor`, timer `arcana-anchor`) holds no key.

## Cadence and cost

**Every fifteen minutes, and only when there is something new.**

- *The window.* Until its root is mined, a decision is protected by the database
  alone. Fifteen minutes is far shorter than anything a rewrite could exploit:
  agents decide on a four-hour cadence and a thesis is judged over ticks, so the
  root is public long before any outcome is known.
- *The cost.* Measured when this was written: gas price 0.087–0.16 gwei; an
  `approve` of ~60k gas cost ~$0.02. An anchor is ~22–40k gas, about a cent.
  Decisions arrive in clusters at each tick (at most 5 in an hour over the last
  day), and a run with nothing new sends nothing, so in practice this is a handful
  of anchors a day — cents. The ceiling, one every run, is ~$1.25/day and is
  enforced by the signer's daily cap.

**Gas is a platform cost.** It is paid from the anchoring wallet, never from an
agent's wallet, and every anchor records `gas_cost_wei`, `eth_usd` and
`gas_cost_usd`. `/anchors` shows the total.

## Checking it yourself

For any decision, `GET /v1/agents/:id/decisions/:d/anchor` returns the anchor,
the transaction hash, the leaf index, the proof and `expected_input`. Then,
without ARCANA:

1. `eth_getTransactionByHash(tx_hash)` on any Robinhood Chain RPC: `from` and `to`
   are the anchoring address, `input` equals `expected_input`, the receipt status
   is `0x1`.
2. `cur = sha256(0x00 || commitment)`; for each proof step,
   `cur = sha256(0x01 || sibling || cur)` if the sibling is on the left, else
   `sha256(0x01 || cur || sibling)`. `cur` must equal the root.

`GET /v1/anchors` lists every anchor; `GET /v1/anchors/:id` gives its leaves.

## Operating it

Created deliberately, never by the installer:

```
sudo -u arcana-anchor /usr/local/bin/arcana-anchor-signer keygen
```

It prints the address. Fund that address with the chain's gas token; it needs
nothing else. Until it is funded, the job logs `NOT YET FUNDED` and exits 0 —
nothing has ever been anchored, so nothing has stopped — and `anchor-verify`
fails the sweep. Once anchoring has worked, an unfunded wallet is an outage and
the job fails and alerts.

One anchor at a time: a pending anchor is settled first (receipt recorded, same
bytes rebroadcast, or marked `dropped` if its nonce was spent elsewhere, which
returns its decisions to the queue).

## What it does not cover

- **Before the root is mined.** A decision is protected by the database alone for
  up to one interval.
- **Decisions before 0047.** They carry no commitment and are never anchored.
  Nothing is backfilled: a commitment computed today for last week proves nothing
  about last week.
- **What a commitment does not name.** The commitment covers the decision, its
  evidence and its reasoning; anchoring makes that tamper-evident. It does not make
  the model's reasoning *correct*, and it does not prove a decision that was never
  recorded was never made.
- **Verification fixtures** are not anchored: they are deleted by their own sweep.
