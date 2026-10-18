# Go/No-Go — is cross-chain arbitrage on Stock Tokens viable?

Phase 2 of `architecture.md` §20: the same (or wrapped) Stock Token trading on
two chains, with a spread that clears bridging cost, fees and settlement risk.

**Verdict: NO.** The Stock Tokens are not standard Arbitrum-bridged ERC-20s:
they expose no `l1Address()` / `l1Token()` / `gateway()` / `bridge()`, so there
is no canonical L1 counterpart, and there is no evidence of a liquid market on
any other chain. Measured 2026-10-18 against Robinhood Chain mainnet. Zero
transactions broadcast, zero money spent.

Related: `docs/go-no-go-arbitrage.md` (same-chain, NO),
`docs/go-no-go-arbitrage-cex.md` (DEX↔CEX, NO), `architecture.md` §20.

---

## Why the test existed

Same-chain is dead (one venue) and DEX↔CEX is dead (no CEX counterparty, and a
closed-market artifact). The remaining path in the brief is cross-chain: the
same asset on two chains. Robinhood Chain is an Arbitrum Orbit L2 with a
canonical bridge to Ethereum, so a bridged representation *could* exist. The
test asked whether it does.

The Stock Tokens are described by Robinhood as "tokenised debt securities issued
by Robinhood Assets (Jersey) Limited" — a compliance-bearing instrument, not a
plain utility token. `docs/go-no-go-stock-tokens.md` already established they
carry a blocklist and a pause switch. A token that is free to cross the
canonical bridge and a token issued as a debt security under a blocklist are
different things, and the bytecode should say which one this is.

---

## Method

Read-only `eth_call` against live state over four public RPCs. The canonical
Arbitrum bridge token interface is well defined: a bridged L2 token implements
`l1Address()` (or `l1Token()` on newer versions) returning its L1 counterpart,
and `gateway()` (or `bridge()`) returning the gateway router. The test called
all four selectors on AAPL and NVDA:

| Selector | Signature |
|---|---|
| `0xc2a2bc9f` | `l1Address()` |
| `0xc01e1bd6` | `l1Token()` |
| `0x4c261e6c` | `gateway()` |
| `0xe78cea92` | `bridge()` |

A revert on a `view` call that the contract does not implement is the
"no such function" answer the go/no-go already documented for `isBlocked()`.

---

## Results

```
AAPL (0xaF3D76f1…93f9):
  l1Address(): execution reverted
  l1Token():   execution reverted
  gateway():   execution reverted
  bridge():    execution reverted
NVDA (0xd0601CE1…9EEC):
  l1Address(): execution reverted
  l1Token():   execution reverted
  gateway():   execution reverted
  bridge():    execution reverted
```

None of the four bridge selectors exists on either token. A standard
Arbitrum-bridged token would answer at least `l1Address()`/`gateway()`. This
token does not — it is a custom RHJ contract with an AccessControl
`mint`/`burn` (issuance and redemption by the issuer), not a bridge mint/burn.

---

## Interpretation

- **No canonical bridged representation.** Without `l1Address`/`gateway`, the
  token is not registered as a bridged asset on the canonical Arbitrum gateway,
  so there is no L1 (Ethereum) counterpart to arbitrage against.
- **Compliance and issuance are the reason, and they are deliberate.** A debt
  security with a blocklist is not a permissionless bridge asset. The mint/burn
  is RHJ's issuance/redemption, not a cross-chain gateway.
- **The premise fails before costs are even computed.** Cross-chain arbitrage
  needs a second venue with the same asset; here there is no second chain with
  the asset at all.

---

## What could not be established

- A **custom, non-Arbitrum** bridge or a third-party wrapped token on some other
  chain. The test ruled out the canonical bridge; it did not enumerate every
  third-party bridge, because a wrapped token that exists only as a thin,
  unofficial pool is not a venue — it is the same dust the same-chain test
  found on v2. No public source names a liquid wrapped Stock Token on another
  chain, and none was found.
- Whether RHJ *could* later add a bridged representation. That is an issuer
  decision, not a fact about today's chain state.

## Reproducing

Call the four selectors above on any Stock Token address from
`services/signer/allowlist/robinhood-mainnet.json`. All four revert; a standard
Arbitrum-bridged token would return an address for `l1Address()` and `gateway()`.
