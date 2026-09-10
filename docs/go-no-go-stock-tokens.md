# Go/No-Go — can an ARCANA-created wallet trade Stock Tokens?

The whole on-chain direction rests on one permission: that a wallet **the
platform creates programmatically**, which has never been through KYC and has no
relationship with Robinhood, may hold and trade Robinhood Stock Tokens.

The documentation said it may not. This test asked the chain instead.

**Verdict: GO, with five conditions.** Run 2026-09-10 against Robinhood Chain
mainnet. Zero transactions broadcast, zero money spent, nothing changed.

Related: [on-chain-direction.md](./on-chain-direction.md) (what was decided as a
result), architecture.md §2.7 and §10 (both of which this test corrected).

---

## Why the test existed

Vendor documentation and secondary sources agreed that Stock Tokens carry
transfer restrictions: compliance checks on **both** sender and receiver, trading
on "permissioned DEXs", and the US excluded. If ARCANA's wallets could not be
allowlisted, agents could not trade at all and the direction was dead.

Against that stood one awkward fact: Uniswap turns over roughly $130M a day in
Stock Tokens on this chain. Somebody could. The question was **who**, and on
what terms — and that is a question about execution, not about documents.

**Documents had already been wrong once here.** architecture.md stated for
months that Robinhood Chain was "fully permissioned" and that ARCANA "cannot
deploy its own smart contracts". Mainnet launched permissionless on 1 July 2026.
The entire §10 payment design — HD wallets, derived deposit addresses, the scan
floor, the deposit audit — exists because of that wrong belief.

---

## Method

`eth_call` executes a transaction against real, current chain state and returns
what would happen, without broadcasting it. A compliance hook that would reject
a transfer rejects it there too, with its own revert reason. That makes it
possible to test a permission system exhaustively for free.

The original plan was to test on testnet first. **It could not be run**: every
`*.chain.robinhood.com` host and `docs.robinhood.com` return a certificate
belonging to **Telkomsel** — the local ISP intercepts them — so the official RPC,
the docs and the testnet faucet were all unreachable. Third-party RPC
(`robinhood-rpc.publicnode.com`, chain id `0x1237` = 4663, verified) was used
instead.

The substitution is an improvement, not a compromise: testnet would only prove
how testnet contracts behave. These are the real token, the real pool and the
real liquidity.

---

## Results

| # | Question | Result |
|---|---|---|
| T1 | Can a fresh wallet **receive** a Stock Token? | **Yes** — simulated `pool.transfer(fresh, 1 AAPL)` returned `true` |
| T2 | Is a fresh wallet blocked as a **sender**? | **No** — see below, the decisive one |
| T3 | What restriction mechanism exists in the bytecode? | a **blocklist**, plus pause |
| T4 | Can it approve a router? | Yes, Permit2 and UniversalRouter both |
| T5–6 | Can it hold and move USDG? | Yes |
| T7 | Is the token genuine, or a copycat? | genuine — `name()` = `"Apple • Robinhood Token"` |
| T8 | Swap via the canonical UniversalRouter | **fails** — not wired to this chain's factory |
| T10 | **Full swap, real pool, ARCANA-created address** | **Success** |

### T2 is the decisive one, and it turns on a revert reason

A transfer from a fresh, zero-balance wallet fails either way. *How* it fails is
the whole answer:

```
0xe450d38c → ERC20InsufficientBalance(0x29DB…, 0, 1e18)
```

That is the stock OpenZeppelin error. The transfer ran all the way to the
balance check — meaning nothing rejected the sender before it. A permissioned
token fails earlier, with a compliance error.

### T3 — the permission model is inverted from what was assumed

The token is a **beacon proxy**; the running implementation is at
`0xb35490d6f9163de4f80d88dc75c3516eb64c5ae2` (11,614 bytes). Selector scan:

```
present : isBlocked(address)      ← DENY list, not an ALLOW list
          pause() / unpause() / paused()      → paused() = false
          mint / burn / hasRole               → AccessControl
absent  : isWhitelisted, canTransfer, detectTransferRestriction  (ERC-1404)
          identityRegistry, compliance                            (ERC-3643)
```

**Permissive by default, deny specific addresses.** That is why a brand-new
wallet works, and it is the opposite of what the documentation implied. There is
no allowlist, so there is nothing to apply for.

### T10 — the full swap

A minimal `uniswapV3SwapCallback` contract was injected at a freshly generated
address via state override, and the pool was driven directly:

```
USDG in   : 100.00
AAPL out  : 0.312403
price     : 320.10 USDG per AAPL
impact    : 0.414% vs mid
recipient : 0xc05BBF4AD65f1cC167D38c38E2141BF5Ac021815  (created that second)
```

### Corroboration from production, not simulation

Six real swaps were caught in the live block window. **All six were initiated by
ordinary EOAs**, through **five different routers**. One of them —
`0xb526f503…21db` — delivered AAPL **directly to an EOA** (`0xb01a7941…dcd2`).

That is not the shape of a permissioned venue. It is ordinary Uniswap with
independent aggregators competing.

### Authenticity

```
name()                 = "Apple • Robinhood Token"
eip712Domain           = "Apple • Robinhood Token"
pool.factory()         = 0x1f7d7550b1b028f7571e69a784071f0205fd2efa  (24,535 B)
getPool(USDG,AAPL,500) = 0xaae0d815…2d6d   ✓ the pool under test
```

Cross-check: the pool's own `slot0` gives 319.36 USDG per AAPL; an independent
market source said $318.78. They agree.

---

## Liquidity and cost, measured

Price impact, by simulating the swap at each size against live pool state:

| Symbol | Fee | $10 | $100 | $1,000 | $10,000 | Price |
|---|---|---|---|---|---|---|
| AAPL | 5 bp | ~0 | ~0 | 0.002% | 0.017% | 320.50 |
| NVDA | 5 bp | ~0 | 0.001% | 0.002% | 0.008% | 218.88 |
| GOOGL | 5 bp | ~0 | ~0 | 0.003% | 0.028% | 331.25 |
| SPY | 5 bp | ~0 | 0.001% | 0.007% | 0.066% | 760.17 |
| QQQ | 5 bp | ~0 | 0.001% | 0.010% | 0.093% | 711.57 |
| TSLA | 30 bp | ~0 | ~0 | 0.004% | 0.039% | 368.45 |
| AMZN | 30 bp | ~0 | ~0 | 0.004% | 0.037% | 252.60 |
| MSFT | 30 bp | ~0 | 0.001% | 0.005% | 0.051% | 493.25 |
| META | 30 bp | ~0 | 0.005% | 0.048% | 0.477% | 658.04 |

**Price impact is not the cost. The pool fee is.** 5 bp or 30 bp per swap — 10
to 60 bp round trip — plus gas, measured at **$0.0573** per swap (0.127748 gwei,
~180,000 gas, ETH $2,490).

The consequence for cadence and capital is worked through in
[on-chain-direction.md §i](./on-chain-direction.md#i-cadence--the-user-chooses-within-a-floor-the-arithmetic-sets).
The short version: an hourly cadence spends 3.60% of capital per month on pool
fees alone, at any capital, so it is arithmetically unavailable.

---

## The five conditions

1. **The blocklist and pause are real.** `isBlocked(address)` and `pause()` are
   in the running implementation. ARCANA wallets can be frozen at the issuer's
   discretion with no appeal. `token_paused` and `wallet_blocked` are first-class
   refusal states, and reconciliation must tell a frozen wallet from an empty one.

2. **The beacon is one switch over every Stock Token.** Beacon at
   `0xe10b6f6b275de231345c20d14ab812db62151b00`. One upgrade converts the
   blocklist into an allowlist for all of them at once — the permission proved
   here is revocable in a single transaction. **Monitor `implementation()` and
   alarm on change, before real money.**

3. **The US exclusion is not enforced on-chain.** It is a product geofence in
   Robinhood's app. Nothing stops ARCANA technically — which is the problem.
   A legal question, blocking the phase that admits public users.

4. **Confirm with one real ~$20 mainnet swap.** `eth_call` runs the same code
   against the same state and is strong evidence, but it is not a broadcast
   transaction. Balances in T5–T10 were supplied by state override; compliance
   checks key on addresses rather than on where a balance came from, so this does
   not change the result — but the gap is worth closing once.

5. **Never use the canonical UniversalRouter address.** It exists on this chain
   but is not wired to its factory and fails with an empty revert. Routers come
   from an allowlist of addresses proven in production.

---

## What could not be established

- `isBlocked()` exists in the bytecode but reverts when called, most likely
  delegating to a registry that is not set. **The mechanism is there**; who may
  invoke it could not be determined, because the token exposes no enumerable
  AccessControl.
- Nine symbols were measured. The other 41 in `us-large-cap-50.json` were not,
  and almost certainly do not all have pools.
- No broadcast transaction was made. See condition 4.

## Reproducing

The probe scripts are not in this repository — they are throwaway read-only
harnesses, and re-deriving them is cheaper than maintaining them. What matters is
recorded above: the addresses, the selectors, the revert codes and the numbers.
Every one of them can be re-checked with `eth_call` against a public RPC in a
few minutes.
