# Secondary Market — Stock Tokens without a Chainlink feed

The on-chain universe has two markets. The **primary market** is the nine
Stock Tokens listed in 2026-09 (AAPL, NVDA, GOOGL, SPY, QQQ, TSLA, AMZN, MSFT,
META). Each has a Chainlink feed that referees its pool price. The **secondary
market** holds Stock Tokens that agents may trade but that Chainlink does not
price on this chain. It holds **RBLX** (Roblox), listed 2026-09-27, **LLY**
(Eli Lilly), listed 2026-09-29, **IBM**, listed 2026-10-01, **MRNA**
(Moderna), listed 2026-10-02, **NU** (Nu Holdings) and **JNJ** (Johnson &
Johnson), both listed 2026-10-04, **BA** (Boeing), listed 2026-10-06, **NFLX**
(Netflix), listed 2026-10-09, **UPS**, listed 2026-10-11, **COST**
(Costco), listed 2026-10-13, **PFE** (Pfizer), listed 2026-10-15, **LULU**
(Lululemon), listed 2026-10-20, and **GME** (GameStop), listed 2026-10-22. The
sections below record RBLX, the first; LLY, IBM, MRNA, NU, JNJ, BA, NFLX, UPS,
COST, PFE, LULU and GME have their own sections ([LLY](#lly-eli-lilly), [IBM](#ibm),
[MRNA](#mrna-moderna), [NU](#nu-nu-holdings), [JNJ](#jnj-johnson--johnson),
[BA](#ba-boeing), [NFLX](#nflx-netflix), [UPS](#ups), [COST](#cost-costco),
[PFE](#pfe-pfizer), [LULU](#lulu-lululemon), [GME](#gme-gamestop)) with the same evidence.

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

## NFLX (Netflix)

Listed 2026-10-09 with the same checks, read live that day. Chainlink's
tokenized-equity feed directory for Robinhood Chain, re-read the same day,
carries a feed for many other tickers but none for NFLX.

| Check | Result |
|---|---|
| `name()` / `symbol()` / `decimals()` | `Netflix • Robinhood Token` / `NFLX` / 18 |
| Address | `0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8` |
| Beacon / implementation | `0xe10b…1b00` / `0xb354…5ae2`, 11,614 bytes, the same as every other token |
| `paused()` | `false` |
| `isBlocked(address)` | reverts, empty payload; `0xdeadbeef` reverts identically |

The address came from the issuer's own contract registry for chain 4663; the
name, beacon and implementation above are what prove it.

NFLX has exactly two pools against USDG, both live and both from factory
`0x1f7d…2efa` with USDG as token0. The factory has no 0.05% or 0.01% pool for
the pair.

| | Traded pool | Referee pool |
|---|---|---|
| Fee | 0.3% (3000) | 1% (10000) |
| Address | `0x59895c0302f41aeaa129d2fa2442cec01e7ef45e` | `0xea75ea625d83ae276b9ae8b0a3dc205916ee65cf` |
| Price, 2026-10-09 | 70.4428 USDG | 70.9520 USDG |
| Reserves | ~$210k | ~$4k |

The two were 0.72% apart, inside the 2% tolerance. The 0.3% pool is traded
because its fee is a third of the other's and it is far the deeper: about $3.6M
of in-range liquidity, second only to IBM's among the secondary market's traded
pools. That is what an agent pays, and it is the cheapest large order in the
secondary market:

| Buy size | $10 | $100 | $1,000 | $10,000 |
|---|---|---|---|---|
| Impact, 0.3% pool | 0.001% | 0.006% | 0.055% | 0.552% |

The 1% pool is the only other pool, so it referees. It is thin — about $1.2k
moves it 2% — much thinner than NFLX's traded pool, though nearly six times
harder to move than BA's referee. As with IBM, JNJ and BA, the cost is
availability and not safety: someone who moves the 1% pool stops NFLX trades
(`price_divergence`) until the pools agree again; they do not set a price.
Fooling the check needs the 0.3% pool moved 2% as well, about $73k, and that is
where the money is — the deepest traded pool in the secondary market, so the
most expensive half to move.

NFLX was picked over RIVN and UPS, the other feedless tokens with a deep second
pool, because in both of those the deep pool is the 1% one: listing either means
trading on a 1% pool, which no listed token does, or on the thinner 0.3% pool.
NFLX is the remaining feedless token with a deep 0.3% traded pool and a live, if
thin, 1% referee.

## UPS

Listed 2026-10-11 with the same checks, read live that day. Chainlink's
tokenized-equity feed directory for Robinhood Chain, re-read the same day,
carries feeds for other tickers and none for UPS.

| Check | Result |
|---|---|
| `name()` / `symbol()` / `decimals()` | `UPS • Robinhood Token` / `UPS` / 18 |
| Address | `0xf23250dac154D05Bb671CB0d0eBEf3c635c79CE2` |
| Beacon / implementation | `0xe10b…1b00` / `0xb354…5ae2`, 11,614 bytes, the same as every other token |
| `paused()` | `false` |
| `isBlocked(address)` | reverts, empty payload; `0xdeadbeef` reverts identically |

The address came from the issuer's own contract registry for chain 4663; the
name, beacon and implementation above are what prove it.

UPS has exactly two pools against USDG, both live and both from factory
`0x1f7d…2efa` with USDG as token0. The factory has no 0.05% or 0.01% pool for
the pair.

| | Traded pool | Referee pool |
|---|---|---|
| Fee | 0.3% (3000) | 1% (10000) |
| Address | `0x5c67a84ec5494ffe24e217b28debb96341014c86` | `0x3ab74c45dcecc6a62898204dd42143a816b44cb1` |
| Price, 2026-10-11 | 93.4641 USDG | 94.1029 USDG |
| Reserves | ~$16k | ~$86k |

The two were 0.68% apart, inside the 2% tolerance. This is the mirror image of
BA: UPS has the **thinnest traded pool** in the secondary market and the
**deepest referee**. The 0.3% pool is traded because its fee is a third of the
other's, and it is where an order actually pays:

| Buy size | $10 | $100 | $1,000 | $10,000 |
|---|---|---|---|---|
| Impact, 0.3% pool | 0.007% | 0.071% | 0.712% | 7.233% |

The 1% pool is the only other pool, so it referees, and it is the most robust
referee in the secondary market: about $2.1M of in-range liquidity, so roughly
$43k moves it 2% — more than two hundred times what BA's referee costs to
move. Fooling the check still needs the 0.3% pool moved as well. That traded
pool is thin (~$281k of in-range liquidity), so the cost of listing UPS is
impact at size, not safety: an agent trading in the tens of dollars pays almost
nothing, and a $10,000 order pays about 7.2%.

UPS was picked over RIVN, the last feedless token with a live second pool,
because UPS's traded pool is deeper (~$281k of in-range liquidity against
RIVN's ~$150k) and its referee is far deeper (~$2.1M against ~$322k). RIVN's
$10,000 order would have paid about 13.8%.

## COST (Costco)

Listed 2026-10-13 with the same checks, read live that day. Chainlink's
tokenized-equity feed directory for Robinhood Chain, re-read the same day,
lists 58 feeds and none for COST.

| Check | Result |
|---|---|
| `name()` / `symbol()` / `decimals()` | `Costco • Robinhood Token` / `COST` / 18 |
| Address | `0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2` |
| Beacon / implementation | `0xe10b…1b00` / `0xb354…5ae2`, 11,614 bytes, the same as every other token |
| `paused()` | `false` |
| `isBlocked(address)` | reverts, empty payload; `0xdeadbeef` reverts identically |

The address came from the issuer's own contract registry for chain 4663; the
name, beacon and implementation above are what prove it.

COST has exactly two pools against USDG, both live and both from factory
`0x1f7d…2efa` with COST as token0. The factory has no 0.05% or 0.01% pool for
the pair.

| | Traded pool | Referee pool |
|---|---|---|
| Fee | 0.3% (3000) | 1% (10000) |
| Address | `0x0a2121a50a09ed0796ae81f9c53ff9398355a398` | `0xdb073638f94a384b8b7a647d73274decac9e7ca5` |
| Price, 2026-10-13 | 958.6662 USDG | 959.8221 USDG |
| Reserves | ~$585k | ~$920 |

The two were 0.12% apart, inside the 2% tolerance. The 0.3% pool is traded
because its fee is a third of the other's and it is far the deeper — about
$17M of in-range liquidity, the deepest traded pool in the secondary market.
That is what an agent pays, and it is the cheapest large order in the
secondary market:

| Buy size | $10 | $100 | $1,000 | $10,000 |
|---|---|---|---|---|
| Impact, 0.3% pool | 0.000% | 0.001% | 0.011% | 0.115% |

The 1% pool is the only other pool, so it referees. It is thin — about $25k of
in-range liquidity, so roughly $250 moves it 2% — comparable to BA's and JNJ's
referees. As with them, the cost is availability and not safety: someone who
moves the 1% pool stops COST trades (`price_divergence`) until the pools agree
again; they do not set a price. Fooling the check needs the 0.3% pool moved 2%
as well, about $174k, and that is where the money is — the deepest traded pool
in the secondary market, so the most expensive half to move.

COST was picked over HIMS, the only feedless token with a deeper traded pool,
because HIMS's 1% referee holds under $200 — about $17 moves it 2%, an order of
magnitude thinner than any referee the market has accepted — so HIMS would halt
on almost any trade. COST pairs the second-deepest traded pool with a referee
inside that accepted range. PFE (~$1.3M traded, ~$50k referee) and RIVN
(~$123k traded, ~$278k referee) were the next candidates.

## PFE (Pfizer)

Listed 2026-10-15 with the same checks, read live that day. Chainlink's
tokenized-equity feed directory for Robinhood Chain, re-read the same day,
lists 58 feeds and none for PFE.

| Check | Result |
|---|---|
| `name()` / `symbol()` / `decimals()` | `Pfizer • Robinhood Token` / `PFE` / 18 |
| Address | `0x7066A64c24e4206CD62E83bf198c1E7EB361F51e` |
| Beacon / implementation | `0xe10b…1b00` / `0xb354…5ae2`, 11,614 bytes, the same as every other token |
| `paused()` | `false` |
| `isBlocked(address)` | reverts, empty payload; `0xdeadbeef` reverts identically |

The address came from the issuer's own contract registry for chain 4663; the
name, beacon and implementation above are what prove it.

PFE has exactly two pools against USDG, both live and both from factory
`0x1f7d…2efa` with USDG as token0. The factory has no 0.05% or 0.01% pool for
the pair.

| | Traded pool | Referee pool |
|---|---|---|
| Fee | 0.3% (3000) | 1% (10000) |
| Address | `0xc7d573fcda6d2107c97fb582ae18411f9db32e7f` | `0xa26df7296ef5dfc727f3bc6f1e9050e6b62e6abf` |
| Price, 2026-10-15 | 29.2354 USDG | 29.1906 USDG |
| Reserves | ~$48k | ~$1.1k |

The two were 0.15% apart, inside the 2% tolerance. The 0.3% pool is traded
because its fee is a third of the other's and it is far the deeper — about
$815k of in-range liquidity against about $51k in the 1% pool. That is what an
agent pays:

| Buy size | $10 | $100 | $1,000 | $10,000 |
|---|---|---|---|---|
| Impact, 0.3% pool | 0.002% | 0.024% | 0.245% | 2.408% |

The 1% pool is the only other pool, so it referees. It is thin — about $500
moves it 2% — comparable to IBM's and JNJ's referees. As with them, the cost is
availability and not safety: someone who moves the 1% pool stops PFE trades
(`price_divergence`) until the pools agree again; they do not set a price.
Fooling the check needs the 0.3% pool moved 2% as well, about $8k, and that is
where the money is.

PFE was picked over RIVN, NET and LULU, the other feedless tokens with a live
second pool behind a 0.3% traded pool. RIVN's traded pool is thinner (~$106k of
in-range liquidity, ~16% impact at $10,000) even though its 1% referee is
deeper (~$251k); NET (~$316k traded) and LULU (~$580k traded) pair thinner
traded pools with referees (~$13k and ~$10k) no deeper than PFE's. PFE pairs
the deepest 0.3% traded pool of the group (~$815k) with a referee inside the
range the market has accepted (~$51k, about $500 to move 2%). HIMS (~$20M
traded), AMC (~$1.5M) and TTWO (~$0.9M) have deeper traded pools but no usable
referee: HIMS's and AMC's 1% pools hold about $8 and $12 to move 2%, far
thinner than any referee the market has accepted, and TTWO has only an empty
0.05% pool — so they would halt on almost any trade. GLD's v3 pools are deeper
still, but it has a Chainlink feed (`GLD / USD`, read live 2026-10-15 at 374.31
against a 0.3% pool at 375.21), so it belongs in the primary market rather than
here.

## LULU (Lululemon)

Listed 2026-10-20 with the same checks, read live that day. Chainlink's
tokenized-equity feed directory for Robinhood Chain, re-read the same day,
lists 58 feeds and none for LULU.

| Check | Result |
|---|---|
| `name()` / `symbol()` / `decimals()` | `Lululemon • Robinhood Token` / `LULU` / 18 |
| Address | `0x4e62068525Ab11FE768e29dfD00ef909B9803016` |
| Beacon / implementation | `0xe10b…1b00` / `0xb354…5ae2`, 11,614 bytes, the same as every other token |
| `paused()` | `false` |
| `isBlocked(address)` | reverts, empty payload; `0xdeadbeef` reverts identically |

The address came from the issuer's own contract registry for chain 4663; the
name, beacon and implementation above are what prove it.

LULU has two live pools against USDG, both from factory `0x1f7d…2efa` with LULU
as token0, and a third at 0.05% that is initialised but holds nothing. There is
no 0.01% pool for the pair.

| | Traded pool | Referee pool |
|---|---|---|
| Fee | 0.3% (3000) | 1% (10000) |
| Address | `0x0f4227d27082b3bca6818381b9ea6460275e49f4` | `0x19757223628da89569f9a2488af6c45cb9824ea1` |
| Price, 2026-10-20 | 97.6736 USDG | 96.9947 USDG |
| Reserves | ~$21k | ~$32 |

The two were 0.70% apart, inside the 2% tolerance. The 0.3% pool is traded
because its fee is a third of the other's and it is far the deeper — about
$3.07M of in-range liquidity against about $10k in the 1% pool. That is what an
agent pays, and only COST's and NFLX's traded pools are cheaper at size:

| Buy size | $10 | $100 | $1,000 | $10,000 |
|---|---|---|---|---|
| Impact, 0.3% pool | 0.001% | 0.007% | 0.065% | 0.653% |

The 1% pool is the only other live pool, so it referees. It is thin — about
$100 moves it 2%, level with BA's, the thinnest referee the market has accepted
— and as with BA the cost is availability and not safety: someone who moves the
1% pool stops LULU trades (`price_divergence`) until the pools agree again;
they do not set a price. Fooling the check needs the 0.3% pool moved 2% as
well, about $31k, and that is where the money is.

LULU was passed over at PFE's listing five days earlier, when its 0.3% pool
held about $580k of in-range liquidity; it has since deepened to about $3.07M,
which retires that reason. It is now the deepest traded pool among the feedless
tokens that have a usable referee. HIMS (~$20.2M) and AMC (~$2.6M) are deeper
and both still have a 1% pool that about $8 and $12 move 2%, so they would halt
on almost any trade; TTWO (~$1.8M), AVGO (~$1.1M), FIG (~$1.1M), SNAP (~$0.9M)
and BE (~$0.6M) have no live second pool at all. RIVN (~$374k traded, ~$114k
referee) and NET (~$72k traded, ~$31k referee) were the next candidates with a
usable referee.

## GME — GameStop

GME was listed on **2026-10-22**. Read live before the entry was written:
`name()` = "GameStop • Robinhood Token", symbol GME, 18 decimals, behind the
same beacon (`0xe10b…1b00`) and implementation (`0xb354…5ae2`, 11,614 bytes) as
every other Stock Token, `paused()` = false, `uiMultiplier()` = 1e18. Chainlink
publishes no GME feed on this chain, so a second pool referees the price.

GME is token0 in every pool for the pair (its address sorts below USDG's), all
from factory `0x1f7d…2efa`. A third pool at 0.3% exists holding about $24k —
too thin to trade and not used:

| | Traded pool | Referee pool |
|---|---|---|
| Fee | 0.05% (500) | 1% (10000) |
| Address | `0xE2b46c905E12Ab8E2f864e4821a4325884C1B126` | `0xE9713f453aDB9245B19559790c96F470a18F2fDF` |
| Price, 2026-10-22 | 24.7431 USDG | 24.8399 USDG |
| In-range liquidity | ~$791k | ~$2.60M |

The two are **0.39% apart**, inside the 2% tolerance. The 0.05% pool is traded
because its fee is a twentieth of the other's and its depth is enough at the
sizes agents trade: about 0.003% impact at $10 and 0.025% at $100.

The referee is also the deeper pool, which is the first time the market has had
that: about **$25.5k** moves it 2%, against about **$7.8k** for the traded pool.
Fooling the check therefore needs both — roughly **$33k** — and the cheaper side
to move is the larger of the two, not the smaller. That is the opposite of the
thin referees (BA, LULU) the market has accepted so far, where a few hundred
dollars halts a symbol.

Why this one and not a deeper name: the unlisted tokens with deeper traded pools
still have no usable referee. HIMS (~$20.2M) and AMC (~$2.6M) have 1% pools that
about $8 and $12 move 2%; TTWO, AVGO, FIG, SNAP and BE have no live second pool
at all. GME is the deepest unlisted name whose referee is deep enough to be
worth trusting.

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
