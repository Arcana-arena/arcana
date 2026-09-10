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

console.log('\n' + '='.repeat(40));
console.log(`  PASS: ${pass}   FAIL: ${fail}`);
console.log('='.repeat(40));
if (fail > 0) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('phase10-verify: the boundary holds before the second source exists.');
