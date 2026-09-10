/**
 * ARCANA market index verification.
 *
 * `market_snapshots.market_return` is a STORED result of a computation that
 * lives in exactly one place: MarketIndexService. The whole reason that service
 * was extracted is that two definitions of "what the market did" would sooner
 * or later disagree, and Agent DNA, Autopsy and Evolution all judge agents
 * against it.
 *
 * Storing the number introduces a way for that to happen quietly: the column
 * could drift from the definition — a bad backfill, a hand-run UPDATE, a future
 * writer that decides it knows better — and nothing downstream would notice,
 * because a stored number looks exactly as authoritative as a computed one.
 *
 * So this recomputes every value from the snapshots themselves and compares.
 * It is the check that keeps "stored" from becoming "second definition".
 *
 * The arithmetic below is a deliberate, independent restatement of the rule
 * rather than a call into the service: a copy that imported the service could
 * only ever agree with it.
 *
 *     return(tick) = mean over symbols of (price / previousPrice - 1)
 *     previous = the preceding tick FROM THE SAME SOURCE
 *     first tick of a source = 0
 *
 * Usage (on the VPS, from the repo root):
 *   node infra/verify/market-index-verify.mjs
 * Exits non-zero if any stored value disagrees, or if any row is unexplained.
 */
import { execFileSync } from 'node:child_process';

const MD = process.env.MARKET_DATA_URL || 'http://127.0.0.1:8083';
const PG_CONTAINER = process.env.PG_CONTAINER || 'arcana-postgres';
const TOLERANCE = 1e-12; // float64 round-trip through double precision is exact;
                         // this only absorbs re-association in the summation.

const sql = (q) =>
  execFileSync('docker', ['exec', PG_CONTAINER, 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc', q],
    { encoding: 'utf8' }).trim();

const rows = sql(
  `SELECT ref || '' || source || '' || COALESCE(market_return::text, '')
   FROM market_snapshots ORDER BY source ASC, tick_time ASC`,
).split('\n').filter(Boolean).map((l) => {
  const [ref, source, stored] = l.split('');
  return { ref, source, stored: stored === '' ? null : Number(stored) };
});

console.log(`market-index-verify: ${rows.length} snapshots\n`);

let pass = 0, fail = 0, unreadable = 0;
const failures = [];

async function pricesFor(ref) {
  try {
    const res = await fetch(`${MD}/v1/market/snapshots/${ref}`);
    if (!res.ok) return null;
    const s = await res.json();
    return Object.fromEntries(s.symbols.map((x) => [x.symbol, x.price]));
  } catch { return null; }
}

let prev = null, prevSource = null;
for (const row of rows) {
  if (row.source !== prevSource) { prev = null; prevSource = row.source; }
  const prices = await pricesFor(row.ref);
  if (!prices) {
    unreadable++;
    // An unreadable snapshot should have NO stored return: the service skips
    // it rather than inventing one, and it must not become the predecessor of
    // the next tick either.
    if (row.stored !== null) {
      fail++;
      failures.push(`${row.ref}: payload unreadable but a return is stored (${row.stored})`);
    }
    continue;
  }

  let expected = 0;
  if (prev) {
    const rets = [];
    for (const [sym, price] of Object.entries(prices)) {
      const before = prev[sym];
      if (before > 0) rets.push(price / before - 1);
    }
    expected = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  }

  if (row.stored === null) {
    fail++;
    failures.push(`${row.ref}: readable snapshot with NO stored return (expected ${expected})`);
  } else if (Math.abs(row.stored - expected) > TOLERANCE) {
    fail++;
    failures.push(`${row.ref}: stored ${row.stored} but recomputes to ${expected} (delta ${row.stored - expected})`);
  } else {
    pass++;
  }
  prev = prices;
}

console.log(`  ${pass} stored returns match a fresh recomputation`);
if (unreadable) console.log(`  ${unreadable} snapshot payload(s) unreadable (skipped, as the service does)`);

// A source boundary must reset the comparison. Proving it is not merely
// asserted: the first tick of every source has to be exactly 0.
const firstOfSource = new Map();
for (const r of rows) if (!firstOfSource.has(r.source)) firstOfSource.set(r.source, r);
for (const [source, r] of firstOfSource) {
  const ok = r.stored === 0 || r.stored === null;
  if (ok) { pass++; console.log(`  first tick of source '${source}' is 0 — no return across worlds`); }
  else { fail++; failures.push(`first tick of source '${source}' stored ${r.stored}, expected 0`); }
}

console.log(`\n========================================`);
console.log(`  PASS: ${pass}   FAIL: ${fail}`);
console.log(`========================================`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures.slice(0, 25)) console.log('  - ' + f);
  if (failures.length > 25) console.log(`  ... and ${failures.length - 25} more`);
  process.exit(1);
}
console.log('market-index-verify: the stored index still equals its definition.');
