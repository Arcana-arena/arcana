# Secondary Market — Stock Tokens without a Chainlink feed

The on-chain universe has two markets. The **primary market** is the nine
Stock Tokens listed in 2026-09 (AAPL, NVDA, GOOGL, SPY, QQQ, TSLA, AMZN, MSFT,
META). Each has a Chainlink feed that referees its pool price. The **secondary
market** holds Stock Tokens that agents may trade but that Chainlink does not
price on this chain. It holds **RBLX** (Roblox), listed 2026-09-27, **LLY**
(Eli Lilly), listed 2026-09-29, **IBM**, listed 2026-10-01, **MRNA**
(Moderna), listed 2026-10-02, **NU** (Nu Holdings) and **JNJ** (Johnson &
Johnson), both listed 2026-10-04, and **BA** (Boeing), listed 2026-10-06. The
sections below record RBLX, the first; LLY, IBM, MRNA, NU, JNJ and BA have
their own sections ([LLY](#lly-eli-lilly), [IBM](#ibm),
[MRNA](#mrna-moderna), [NU](#nu-nu-holdings), [JNJ](#jnj-johnson--johnson),
[BA](#ba-boeing)) with the same evidence.

Related: [go-no-go-stock-tokens.md](./go-no-go-stock-tokens.md) (the permission
this rests on), [market-data.md](./market-data.md), [execution.md](./execution.md),
[signer.md](./signer.md).

---

## Why a second tier and not just a tenth token

Every primary price is checked twice. market-data compares the pool to
Chainlink on each tick, and a pool more than 2% away is marked `disputed`
([on-chain-direction.md §d](./on-chain-direction.md)). Chainlink's feed
directory for Robinhood Chain (`feeds-robinhood-mainnet.json`, read 2026-09-27)
lists 58 feeds, 44 of them Stock Tokens, and **none for RBLX**.

Listed like a primary token, RBLX would be `unrefereed` on every tick and would
trade anyway: whoever moved its pool would set the price every agent acted on.
The secondary market exists to stop that without waiting for a feed.

## The referee is a second pool

RBLX has two live Uniswap v3 pools against USDG. They hold separate liquidity,
so an attacker has to move both. When one pool alone shows a price, someone
pushed it there; the market didn't move.

| | Traded pool | Referee pool |
|---|---|---|
| Fee | 0.3% (3000) | 1% (10000) |
| Address | `0x1bdb8e3a79cb1a7f228808739311e23098d33d43` | `0x2ef5945cd5664876b6481fdacfaa2942995a4da8` |
| Price, 2026-09-27 | 46.5184 USDG | 46.6693 USDG |
| Reserves | ~$118k | ~$212k |

The two pools were 0.32% apart at listing, most of which is their fee
difference. The traded pool is the 0.3% one because its fee is a third of the
other's and its depth is enough at the sizes agents trade:

| Buy size | $10 | $100 | $1,000 | $10,000 |
|---|---|---|---|---|
| Impact, 0.3% pool | 0.001% | 0.011% | 0.108% | 1.079% |

The impact figures are a single-range estimate from in-range liquidity. The
broker's own simulation of the exact calldata, which runs before every swap,
has the final say. A 0.01% pool also exists and is empty.

**Checked twice, like the primary market:**

1. **market-data, per tick.** A secondary quote is refereed by the second pool
   (`chain.RefereeByPool`) with the same 2% tolerance and the same three
   answers: `agreed`, `disputed`, `unrefereed`. The quote records
   `market: "secondary"` and `referee_source: "pool"`, so a snapshot read years
   later still says what checked it.
2. **decision-engine, per trade.** Immediately before an RBLX swap, the broker
   reads both pools and refuses with nothing signed when they are more than 2%
   apart (`price_divergence`) or when the referee pool cannot be read
   (`referee_unreadable`). It also refuses a referee pool that the factory
   resolves to a different address than the reviewed one. Sells are checked as
   well as buys: selling into a pool pushed down loses as much as buying from
   one pushed up.

A primary trade is never checked by this code. Chainlink referees primary
tokens in market-data, as before.

## The token

Read live on 2026-09-27, the same checks as the go/no-go test:

| Check | Result |
|---|---|
| `name()` / `symbol()` / `decimals()` | `Roblox • Robinhood Token` / `RBLX` / 18 |
| Address | `0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8` |
| Beacon (EIP-1967 slot) | `0xe10b6f6b275de231345c20d14ab812db62151b00`, the same as every primary token |
| Implementation | `0xb35490d6f9163de4f80d88dc75c3516eb64c5ae2`, 11,614 bytes, the same |
| `paused()` | `false` |
| `isBlocked(address)` | reverts, empty payload; `0xdeadbeef` reverts identically |
| Pools' factory | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`, the one SwapRouter02 reports |

**A copycat exists.** `0xac3D5a9c7824a091b48AD5AAB101B0586444cb07` is a
community token also called RBLX ("Robux"). A token's symbol does not prove
what it is; the beacon and implementation do.

Because RBLX shares the beacon, the chain guard already watches the switch
that governs it. It is in `infra/alerting/chain-baseline.json` all the same, so
its pause state and pool are checked by name.

## Where it is configured

A secondary token is one entry in each of three reviewed files, and
`infra/verify/phase10-verify.mjs` fails if the first two disagree on the
market or the referee pool:

| File | Fields |
|---|---|
| `services/signer/allowlist/robinhood-mainnet.json` | `market`, `referee_pool`, `referee_pool_fee`, and the evidence-carrying `blocklist_unreadable` |
| `services/market-data/config/robinhood-chain.json` | `market`, `referee_pool`, `referee_pool_fee`; `feed` empty |
| `infra/alerting/chain-baseline.json` | beacon, implementation, pause state, pool |

Both loaders refuse a secondary token with no referee pool, one refereed by
its own pool or fee tier, and an unknown market. market-data also refuses a
secondary token that names a Chainlink feed, because a token with a feed
belongs in the primary market.

`GET /v1/market/chain/universe` publishes both markets from the chain
description. The agent wizard reads it and shows the secondary market as its
own row under *Tokenised stocks*.

## LLY (Eli Lilly)

Listed 2026-09-29 with the same checks as RBLX, read live that day. Chainlink's
feed directory for Robinhood Chain, re-read the same day, still lists 58 feeds
and none for LLY.

| Check | Result |
|---|---|
| `name()` / `symbol()` / `decimals()` | `Eli Lilly • Robinhood Token` / `LLY` / 18 |
| Address | `0x8005d266423c7ea827372c9c864491e5786600ea` (its EIP-55 checksum is all lowercase) |
| Beacon / implementation | `0xe10b…1b00` / `0xb354…5ae2`, 11,614 bytes, the same as every other token |
| `paused()` | `false` |
| `isBlocked(address)` | reverts, empty payload; `0xdeadbeef` reverts identically |

The address came from the Uniswap token list for chain 4663. The token list
proves nothing on its own; the name, beacon and implementation above do.

LLY has three live pools against USDG, all from factory `0x1f7d…2efa` with
USDG as token0:

| | Traded pool | Referee pool | Unused |
|---|---|---|---|
| Fee | 0.05% (500) | 1% (10000) | 0.3% (3000) |
| Address | `0xf212d02146a897f5f686e9d629f6a73da534324a` | `0xf4274130137eee20bad928b593d992716516ceb9` | `0xd2038788ebe1e0bfd7c0a6112f09778f3aeaeca6` |
| Price, 2026-09-29 | 1186.9528 USDG | 1178.0038 USDG | 1185.2127 USDG |
| Reserves | ~$330k | ~$222k | ~$40k |

The traded and referee pools were 0.76% apart, inside the 2% tolerance. The
0.05% pool is traded because it is both the cheapest and the deepest. The 1%
pool referees it because it is the deeper of the other two, so an attacker
would have to move about $550k of liquidity across two pools.

| Buy size | $10 | $100 | $1,000 | $10,000 |
|---|---|---|---|---|
| Impact, 0.05% pool | 0.000% | 0.002% | 0.024% | 0.244% |

## IBM

Listed 2026-10-01 with the same checks, read live that day. Chainlink's feed
directory for Robinhood Chain, re-read the same day, still lists 58 feeds and
none for IBM.

| Check | Result |
|---|---|
| `name()` / `symbol()` / `decimals()` | `IBM • Robinhood Token` / `IBM` / 18 |
| Address | `0x980dcf6766FA79f5Cf0c4AAdb3ab477ff15a9619` |
| Beacon / implementation | `0xe10b…1b00` / `0xb354…5ae2`, 11,614 bytes, the same as every other token |
| `paused()` | `false` |
| `isBlocked(address)` | reverts, empty payload; `0xdeadbeef` reverts identically |

The address came from the Uniswap token list for chain 4663; the name, beacon
and implementation above are what prove it.

IBM has two live pools against USDG and two empty ones, all from factory
`0x1f7d…2efa` with USDG as token0:

| | Traded pool | Referee pool |
|---|---|---|
| Fee | 0.3% (3000) | 1% (10000) |
| Address | `0x8cd848ce18b829c5c769aff27164078bb52e0e97` | `0xa0a79bc62fc822f3bcdf0ebbc586031781c53a5b` |
| Price, 2026-10-01 | 219.4666 USDG | 221.1411 USDG |
| Reserves | ~$239k | ~$29k |

The two were 0.76% apart, inside the 2% tolerance. The 0.05% and 0.01% pools
(`0x8a9e…351f`, `0x0526…c3c2`) hold nothing. The referee is thin: moving it
2% costs a few thousand dollars. That alone fools nothing, because the traded
pool must be moved as well, and at ~$239k it is the expensive half.

| Buy size | $10 | $100 | $1,000 | $10,000 |
|---|---|---|---|---|
| Impact, 0.3% pool | 0.001% | 0.008% | 0.075% | 0.753% |

## MRNA (Moderna)

Listed 2026-10-02 with the same checks, read live that day. Chainlink's feed
directory for Robinhood Chain, re-read the same day, still lists 58 feeds and
none for MRNA.

| Check | Result |
|---|---|
| `name()` / `symbol()` / `decimals()` | `Moderna • Robinhood Token` / `MRNA` / 18 |
| Address | `0x43B07D15cE533bEc5476d70C22a78a1B2B662155` |
| Beacon / implementation | `0xe10b…1b00` / `0xb354…5ae2`, 11,614 bytes, the same as every other token |
| `paused()` | `false` |
| `isBlocked(address)` | reverts, empty payload; `0xdeadbeef` reverts identically |

The address came from the Uniswap token list for chain 4663; the name, beacon
and implementation above are what prove it.

MRNA has two pools against USDG, both live and both from factory
`0x1f7d…2efa`. MRNA is token0 in each, because its address sorts below USDG's;
both price readers take the order from the pool's `token0()`, so nothing
depends on it. The factory has no 0.05% or 0.01% pool for the pair.

| | Traded pool | Referee pool |
|---|---|---|
| Fee | 0.3% (3000) | 1% (10000) |
| Address | `0xb40196272a6d2eb5edf6d93bc4dc39856ad95e0e` | `0xa34d0667334074df2d5bfd259e79e6b9cf1fa8bf` |
| Price, 2026-10-02 | 190.5827 USDG | 191.1202 USDG |
| Reserves | ~$90k | ~$88k |

The two were 0.28% apart, inside the 2% tolerance. Of the feedless tokens not
yet listed, MRNA had the deepest second pool, which is what the referee needs:
the pools are nearly the same size, so an attacker would have to move about
$178k of liquidity across both. The 0.3% pool is traded because its fee is a
third of the other's.

| Buy size | $10 | $100 | $1,000 | $10,000 |
|---|---|---|---|---|
| Impact, 0.3% pool | 0.001% | 0.007% | 0.066% | 0.664% |

## NU (Nu Holdings)

Listed 2026-10-04 with the same checks, read live that day. Chainlink's feed
directory for Robinhood Chain, re-read the same day, still lists 58 feeds and
none for NU.

| Check | Result |
|---|---|
| `name()` / `symbol()` / `decimals()` | `Nu • Robinhood Token` / `NU` / 18 |
| Address | `0x408c14038a04f7bD235329E26d2bf569ee20e250` |
| Beacon / implementation | `0xe10b…1b00` / `0xb354…5ae2`, 11,614 bytes, the same as every other token |
| `paused()` | `false` |
| `isBlocked(address)` | reverts, empty payload; `0xdeadbeef` reverts identically |

The address came from the Uniswap token list for chain 4663; the name, beacon
and implementation above are what prove it.

NU has two pools against USDG, both live and both from factory
`0x1f7d…2efa`, with NU as token0 in each. The factory has no 0.05% or 0.01%
pool for the pair.

| | Traded pool | Referee pool |
|---|---|---|
| Fee | 0.3% (3000) | 1% (10000) |
| Address | `0x0e3faed512e7909758eb924e6919e0057bd6b45e` | `0xb6d047637151f6de1d02028acdd187aa9cb7afe3` |
| Price, 2026-10-04 | 13.3369 USDG | 13.3512 USDG |
| Reserves | ~$47k | ~$49k |

The two were 0.11% apart, inside the 2% tolerance. Of the feedless tokens not
yet listed, NU had the deepest second pool; the next, RIVN, has ~$19k. The
pools are nearly the same size, so an attacker would have to move about $96k
of liquidity across both. The 0.3% pool is traded because its fee is a third
of the other's and it holds more in-range liquidity.

| Buy size | $10 | $100 | $1,000 | $10,000 |
|---|---|---|---|---|
| Impact, 0.3% pool | 0.002% | 0.017% | 0.171% | 1.706% |

This is the thinnest traded pool in the secondary market: a $10,000 order pays
about two and a half times the impact recorded for MRNA.

## JNJ (Johnson & Johnson)

Listed 2026-10-04, after NU, with the same checks, read live that day.
Chainlink's feed directory for Robinhood Chain, re-read for this listing, still
lists 58 feeds and none for JNJ.

| Check | Result |
|---|---|
| `name()` / `symbol()` / `decimals()` | `Johnson & Johnson • Robinhood Token` / `JNJ` / 18 |
| Address | `0x03DfbBE0AC4E7bCDaFd08eD41A400326B77D8c80` |
| Beacon / implementation | `0xe10b…1b00` / `0xb354…5ae2`, 11,614 bytes, the same as every other token |
| `paused()` | `false` |
| `isBlocked(address)` | reverts, empty payload; `0xdeadbeef` reverts identically |

The address came from the Uniswap token list for chain 4663; the name, beacon
and implementation above are what prove it.

JNJ has two live pools against USDG and one empty one, all from factory
`0x1f7d…2efa` with JNJ as token0:

| | Traded pool | Referee pool |
|---|---|---|
| Fee | 0.3% (3000) | 1% (10000) |
| Address | `0x7f0ace18d1dced47063cf26e649bc8ab14d09e67` | `0x8d39388ef11bb78843130bd74ab0e5d89fa76b30` |
| Price, 2026-10-04 | 256.2861 USDG | 255.3495 USDG |
| Reserves | ~$55k | ~$13k |

The two were 0.37% apart, inside the 2% tolerance. The 0.05% pool
(`0x44d7…1c1e`) holds nothing, and the factory has no 0.01% pool for the pair.

Two feedless tokens had a deeper second pool, RIVN (~$21k) and UPS (~$16k),
and in both the deeper pool is the 1% one. Listing either means trading on a
1% pool, which no listed token does, or trading on the thin one. JNJ is the
deepest second pool behind a 0.3% traded pool.

The referee is the thinnest in the secondary market: moving it 2% costs under
a thousand dollars. As with IBM, that alone fools nothing, because the traded
pool must be moved as well, and at ~$55k it is the expensive half.

| Buy size | $10 | $100 | $1,000 | $10,000 |
|---|---|---|---|---|
| Impact, 0.3% pool | 0.002% | 0.016% | 0.163% | 1.628% |

## BA (Boeing)

Listed 2026-10-06 with the same checks, read live that day. Chainlink's feed
directory for Robinhood Chain, re-read the same day, still lists 58 feeds and
none for BA.

| Check | Result |
|---|---|
| `name()` / `symbol()` / `decimals()` | `Boeing • Robinhood Token` / `BA` / 18 |
| Address | `0x4D21483a44Bf67a86b77E3dA301411880797D452` |
| Beacon / implementation | `0xe10b…1b00` / `0xb354…5ae2`, 11,614 bytes, the same as every other token |
| `paused()` | `false` |
| `isBlocked(address)` | reverts, empty payload; `0xdeadbeef` reverts identically |

The address came from the Uniswap token list for chain 4663; the name, beacon
and implementation above are what prove it.

BA has two pools against USDG, both live and both from factory
`0x1f7d…2efa`, with BA as token0 in each. The factory has no 0.05% or 0.01%
pool for the pair.

| | Traded pool | Referee pool |
|---|---|---|
| Fee | 0.3% (3000) | 1% (10000) |
| Address | `0xc6517047b189c72d3baa9ef37d1d28f27a63638a` | `0xbf3904cad0e63a4796cf806c21f2c1528b8ebe06` |
| Price, 2026-10-06 | 193.3322 USDG | 193.4248 USDG |
| Reserves | ~$112k | ~$3k |

The two were 0.05% apart, inside the 2% tolerance.

BA was picked for its traded pool. RIVN and UPS still have the deeper second
pools, and their deep pool is still the 1% one. Of the rest, the feedless
tokens with a deep 0.3% pool all have a thin 1% pool behind it or none that
works: NFLX (~$219k traded) has a referee that about $5 moves 2%, and GLXY
and AVGO have a 1% pool that was never given a usable price. BA's referee
takes about $100 to move 2%.

That makes it the thinnest referee in the secondary market, and the cost is
availability, not safety. Someone who moves the 1% pool stops BA trades
(`price_divergence`) until the pools agree again; they do not set a price.
Fooling the check needs the 0.3% pool moved 2% as well, about $17k, three
times what the same move costs on JNJ's traded pool today.

| Buy size | $10 | $100 | $1,000 | $10,000 |
|---|---|---|---|---|
| Impact, 0.3% pool | 0.001% | 0.006% | 0.058% | 0.580% |

## What this leaves out

- **Per-market caps.** The signer has no per-token trade limit, so RBLX trades
  under the same limits as the primary market. Its pool holds ~$118k, so an
  order in the thousands of dollars pays measurable impact (above). The
  broker's 1% slippage floor is set against its own simulated quote, so it
  stops the price moving between the quote and the fill. It does not cap
  impact. If agents' sizes grow, a per-market notional cap is the next brake.
- **A real RBLX swap.** As with the primary market before its first trade,
  everything here was read or simulated against live state. The broker
  simulates the exact calldata before it signs anything.
- **Lending.** RBLX is not Morpho collateral and is not in the lending
  allowlist.
- **Promotion.** When Chainlink ships an RBLX feed, moving RBLX to the primary
  market means setting `market` to `primary`, adding the `feed`, and removing
  the referee pool, in a reviewed commit.
