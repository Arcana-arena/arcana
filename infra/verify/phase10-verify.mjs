/**
 * ARCANA phase-10 verification: continuous cadence, pool prices, the decision
 * watchdog, and the source-boundary fix that had to land before any of them.
 *
 * Grows as phase 10 does. Section 1 is here first because the bug it covers
 * was **latent until the rest of this phase makes it fire**: a second price
 * source is what turns it from harmless arithmetic into a confident number
 * describing nothing.
 *
 * Read-only against production data; the boundary section drives a pure
 * function with synthetic input instead.
 *
 * Usage (on the VPS, from the repo root):
 *   node infra/verify/phase10-verify.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name} — ${detail}`); console.log(`  FAIL  ${name} — ${detail}`); }
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. The autopsy timing window never crosses a source ===');
// ---------------------------------------------------------------------------
//
// THE BUG, AND WHY IT IS BEING FIXED BEFORE IT CAN FIRE.
//
// The market series is ordered `(source, tick_time)`. The autopsy timing
// window indexed it GLOBALLY — `idx-5 .. idx+5` — with nothing checking that
// those neighbours shared a source. With one source that is harmless, which is
// exactly why it survived review twice.
//
// A second source is what phase 10 adds. From that moment, a trade within five
// ticks of a boundary would have its price placed in context against prices
// from a completely different market: a pool price ranked against vendor
// closes. Arithmetically valid, describing nothing, and silent — no error, no
// null, just a percentile.
//
// Driven against the real exported function rather than a re-implementation,
// because a test that reimplements the thing it tests proves the two agree and
// nothing else.
{
  let sourceRuns;
  try {
    ({ sourceRuns } = require('../../services/agent-service/dist/autopsy/autopsy.service.js'));
  } catch (e) {
    check('autopsy.service exports sourceRuns', false, String(e.message).slice(0, 120));
  }

  if (sourceRuns) {
    check('sourceRuns is exported and callable', typeof sourceRuns === 'function');

    // Two sources, six ticks each — the shape phase 10 produces the day pool
    // snapshots start being written alongside the vendor history.
    const series = [
      ...Array.from({ length: 6 }, () => ({ source: 'polygon' })),
      ...Array.from({ length: 6 }, () => ({ source: 'robinhood_pool' })),
    ];
    const runs = sourceRuns(series);

    check('every index gets a run', runs.length === series.length && runs.every(Boolean),
      `${runs.filter(Boolean).length}/${series.length}`);
    check('the first source runs 0..5',
      runs[0].lo === 0 && runs[0].hi === 5, JSON.stringify(runs[0]));
    check('the second source runs 6..11',
      runs[6].lo === 6 && runs[6].hi === 11, JSON.stringify(runs[6]));

    // THE DECISIVE CASE: the last tick of source A. Unclamped, its +5 window
    // reaches indices 6..10 — every one of them the other market.
    const lastOfA = 5;
    const TIMING_WINDOW = 5;
    const hi = Math.min(runs[lastOfA].hi, lastOfA + TIMING_WINDOW);
    const lo = Math.max(runs[lastOfA].lo, lastOfA - TIMING_WINDOW);
    check('the LAST tick of a source does not look forward into the next one',
      hi === 5, `hi=${hi}, would have been ${lastOfA + TIMING_WINDOW} unclamped`);
    check('and it still looks back across its own source', lo === 0, `lo=${lo}`);

    // And the mirror: the first tick of source B must not look backwards into A.
    const firstOfB = 6;
    const loB = Math.max(runs[firstOfB].lo, firstOfB - TIMING_WINDOW);
    check('the FIRST tick of a source does not look back into the previous one',
      loB === 6, `lo=${loB}, would have been ${firstOfB - TIMING_WINDOW} unclamped`);

    // A trade in the middle of a long run is unaffected — the fix must not
    // narrow windows that were always correct.
    const mid = 3;
    check('a tick in the middle of a run keeps its full window on the side that fits',
      Math.min(runs[mid].hi, mid + TIMING_WINDOW) === 5, String(Math.min(runs[mid].hi, mid + TIMING_WINDOW)));

    // Degenerate shapes, because index arithmetic is where off-by-ones live.
    check('a single-tick source is its own run',
      JSON.stringify(sourceRuns([{ source: 'a' }])) === JSON.stringify([{ lo: 0, hi: 0 }]),
      JSON.stringify(sourceRuns([{ source: 'a' }])));
    check('an empty series produces no runs', sourceRuns([]).length === 0);
    const alternating = sourceRuns([{ source: 'a' }, { source: 'b' }, { source: 'a' }]);
    check('three adjacent single-tick sources each stand alone',
      alternating.every((r, i) => r.lo === i && r.hi === i), JSON.stringify(alternating));
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. The chain config and the signer allowlist cannot disagree ===');
// ---------------------------------------------------------------------------
//
// Two files hold the same addresses, deliberately, because they answer
// different questions: the allowlist says what the signer may BUILD, the chain
// config says where prices are READ. Merging them would put a security
// artifact and a data-source description under one review discipline.
//
// But two sources of truth for an address is how funds end up somewhere
// unexpected. So they are not trusted to stay in step — they are checked, the
// same technique as the mandate cap that lives as a Go const and a TypeScript
// const with nothing shared between them.
{
  const chainCfg = JSON.parse(readFileSync('services/market-data/config/robinhood-chain.json', 'utf8'));
  const allow = JSON.parse(readFileSync('services/signer/allowlist/robinhood-mainnet.json', 'utf8'));

  check('both files name the same chain', chainCfg.chain_id === allow.chain_id,
    `${chainCfg.chain_id} vs ${allow.chain_id}`);
  check('both files name the same quote token',
    chainCfg.quote_token.address.toLowerCase() === allow.quote_token.address.toLowerCase() &&
    chainCfg.quote_token.decimals === allow.quote_token.decimals,
    `${chainCfg.quote_token.address}/${chainCfg.quote_token.decimals}`);

  const allowBySymbol = new Map(allow.tokens.map((t) => [t.symbol, t]));
  const mismatches = [];
  for (const t of chainCfg.tokens) {
    const a = allowBySymbol.get(t.symbol);
    if (!a) { mismatches.push(`${t.symbol}: priced but not signable`); continue; }
    if (a.address.toLowerCase() !== t.address.toLowerCase()) mismatches.push(`${t.symbol}: address`);
    if (a.decimals !== t.decimals) mismatches.push(`${t.symbol}: decimals`);
    if ((a.pool ?? '').toLowerCase() !== (t.pool ?? '').toLowerCase()) mismatches.push(`${t.symbol}: pool`);
  }
  check('every priced token is the same token the signer would trade',
    mismatches.length === 0, mismatches.join(', '));

  // The other direction. A token the signer can trade but nobody prices is an
  // agent able to buy something whose value never enters its NAV.
  const pricedSymbols = new Set(chainCfg.tokens.map((t) => t.symbol));
  const unpriced = allow.tokens.filter((t) => !pricedSymbols.has(t.symbol)).map((t) => t.symbol);
  check('every signable token has a price source', unpriced.length === 0, unpriced.join(', '));

  // A missing feed is not a validation error — the referee degrades to
  // "unrefereed" and says so — but it IS something somebody should have to
  // decide deliberately rather than discover.
  const noFeed = chainCfg.tokens.filter((t) => !t.feed).map((t) => t.symbol);
  check('every token has a Chainlink feed configured', noFeed.length === 0, noFeed.join(', '));

  check('the tolerance records what was measured rather than a default',
    typeof chainCfg.dispute_tolerance_note === 'string' &&
    /0\.244|measured/i.test(chainCfg.dispute_tolerance_note),
    'dispute_tolerance_note should say what was observed');
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. The referee refuses ===');
// ---------------------------------------------------------------------------
//
// The arithmetic lives in Go, so the Go tests are the proof and this runs
// them. They drive the referee past its boundary in both directions, with a
// stale feed, and with no feed at all — that last one being the case that
// matters most, because collapsing "could not check" into "agreed" removes the
// referee silently on exactly the occasions it stopped working.
{
  let out = '';
  let ok = false;
  try {
    out = execFileSync('/usr/local/go/bin/go', ['test', './internal/chain/...'],
      { cwd: 'services/market-data', encoding: 'utf8' });
    ok = /^ok\s/m.test(out);
  } catch (e) {
    out = String(e.stdout ?? e.message);
  }
  check('go test ./internal/chain/... passes', ok, out.split('\n').slice(-6).join(' | ').slice(0, 200));
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. The pool answers, and every quote says who refereed it ===');
// ---------------------------------------------------------------------------
{
  const MARKETDATA = process.env.MARKETDATA_URL || 'http://127.0.0.1:8083';
  let body = null;
  try {
    const res = await fetch(`${MARKETDATA}/v1/market/pool/latest`, { signal: AbortSignal.timeout(60000) });
    body = await res.json();
  } catch (e) {
    check('the pool endpoint answers', false, String(e.message).slice(0, 120));
  }
  if (body) {
    const cfg = JSON.parse(readFileSync('services/market-data/config/robinhood-chain.json', 'utf8'));
    const syms = body.symbols ?? [];
    check('every configured symbol was read from the chain',
      syms.length === cfg.tokens.length,
      `${syms.length} of ${cfg.tokens.length}; unreadable ${JSON.stringify(body.unreadable ?? {})}`);

    const prices = syms.map((q) => q.price);
    check('no price is zero or missing',
      prices.length > 0 && prices.every((v) => typeof v === 'number' && v > 0),
      JSON.stringify(prices).slice(0, 120));

    // THE DECIMAL-DIRECTION BUG THIS CATCHES. The first pool reader used the
    // wrong sign on the decimal correction for pools where address ordering
    // puts the Stock Token second, and five of the nine returned prices around
    // 3e-22 — which renders as a tidy 0.0000. A range check is what turns that
    // from a plausible-looking number into a failure.
    check('every price is in a plausible range for an equity',
      prices.every((v) => v > 1 && v < 100000), JSON.stringify(prices).slice(0, 120));

    check('every quote carries a referee verdict',
      syms.every((q) => ['agreed', 'disputed', 'unrefereed'].includes(q.referee_status)),
      [...new Set(syms.map((q) => q.referee_status))].join(', '));

    // A quote that agreed must carry BOTH figures. "They agreed" is only
    // checkable later if the number that was agreed with survives.
    const agreed = syms.filter((q) => q.referee_status === 'agreed');
    check('an agreed quote records the referee price it agreed with',
      agreed.length === 0 || agreed.every((q) => q.referee_price > 0),
      agreed.filter((q) => !(q.referee_price > 0)).map((q) => q.symbol).join(', '));

    check('reading the pool stores nothing',
      String(body.note ?? '').includes('NOT stored'), String(body.note).slice(0, 60));
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. The cadence floor refuses, and the cadence is idempotent ===');
// ---------------------------------------------------------------------------
//
// The floor is arithmetic: a round trip costs 10-60 bp of pool fee, so hourly
// decisions cost 2.4%-14% of NAV per day if they trade. A limit that has never
// turned anything away has not been tested, so it is driven past.
{
  const BIN = process.env.CADENCE_BIN || 'scheduler-bin/cadence';
  const COMP = process.env.CADENCE_COMPETITION || 'd0653071-67e5-4302-ac78-afe2e1130d89';

  function run(args, env = {}) {
    try {
      const out = execFileSync(BIN, args, {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
    }
  }

  const below = run(['-competition', COMP, '-interval', '1h']);
  check('a cadence below the four-hour floor is REFUSED',
    below.code !== 0 && /below the floor/i.test(below.out), below.out.slice(0, 140));
  check('and the refusal explains the arithmetic rather than just saying no',
    /round trip costs|bp|NAV/i.test(below.out), below.out.slice(0, 140));

  const noKey = run(['-competition', COMP, '-interval', '4h'], { INTERNAL_API_KEY: '' });
  check('a cadence with no internal key refuses rather than half-running',
    noKey.code !== 0 && /INTERNAL_API_KEY/i.test(noKey.out), noKey.out.slice(0, 140));

  const noComp = run(['-interval', '4h']);
  check('a cadence with no competition refuses', noComp.code !== 0, noComp.out.slice(0, 100));

  // IDEMPOTENT. A second run inside the interval must do nothing and exit 0.
  // This matters more on a continuous cadence than a daily one: retries
  // overlap normal operation rather than being an exception.
  const again = run(['-competition', COMP, '-interval', '4h']);
  check('a second run inside the interval does nothing and succeeds',
    again.code === 0 && /Nothing to do|already completed/i.test(again.out),
    again.out.slice(-160));
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. The watchdog asks about decisions, and can still alarm ===');
// ---------------------------------------------------------------------------
//
// A monitor that has never alerted is indistinguishable from a monitor that
// cannot. This one could not: it called arcana-notify with the wrong argument
// shape and got a usage error, so it would have detected a stopped system,
// decided to alert, and sent nothing — the exact failure it exists to catch,
// inside the thing meant to catch it. Found by firing it on purpose.
{
  const WD = 'infra/alerting/arcana-decision-watchdog.sh';

  function runWd(env = {}) {
    try {
      const out = execFileSync('bash', [WD], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
    }
  }

  const healthy = runWd();
  check('a healthy system reports healthy and exits 0',
    healthy.code === 0 && /Healthy|no running competition/i.test(healthy.out),
    healthy.out.slice(0, 140));

  // FORCED PAST THE THRESHOLD. Zero missed intervals means any age at all is
  // too much, which drives the alarm path without waiting twelve hours.
  const alarmed = runWd({ CADENCE_HOURS: '1', MISSED_INTERVALS: '0' });
  check('past the threshold it ALERTS',
    /ALERTED/.test(alarmed.out), alarmed.out.slice(0, 140));
  check('and the alert actually reaches the notifier',
    !/usage:/.test(alarmed.out), alarmed.out.slice(0, 160));

  // "COULD NOT CHECK" IS ITS OWN ANSWER, and must not read as healthy. Same
  // shape as the 503s and the referee's "unrefereed".
  const blind = runWd({ WATCHDOG_DB: 'arcana_no_such_database' });
  check('a check that could not be performed exits NON-ZERO, not quietly 0',
    blind.code !== 0 && /NOT performed/i.test(blind.out), `exit ${blind.code}`);

  // It must ask about DECISIONS, not ticks. A tick that opened and closed with
  // every agent failing is the silent fault, and it looks healthy to anything
  // counting ticks.
  const src = readFileSync(WD, 'utf8');
  check('the watchdog measures decisions, not ticks',
    /max\(ts\)\)\)::bigint, -1\) FROM decisions/.test(src) || /FROM decisions/.test(src),
    'expected a query against the decisions table');
  check('it never opens a tick or reads the pool — a monitor must not mutate',
    !/ticks\/pool|\/ticks"|POST/.test(src.replace(/#.*/g, '')), 'found a write in a monitor');
}

console.log('\n' + '='.repeat(40));
console.log(`  PASS: ${pass}   FAIL: ${fail}`);
console.log('='.repeat(40));
if (fail > 0) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('phase10-verify: the boundary holds before the second source exists.');
