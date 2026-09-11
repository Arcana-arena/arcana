/**
 * dust-verify.mjs — prove that a residue is not read as a position, by giving
 * each reader one on purpose.
 *
 * THE THING THIS IS GUARDING AGAINST. An exit left one wei of GOOGL behind:
 * 0.000000000000000001 shares, the last digit of a seventeen-digit fill that a
 * float64 could not carry. Four readers then treated it as a holding — the
 * chart, the DNA fingerprint, the autopsy breakdown and the prompt the model
 * sees — and each of them was individually reasonable, because each of them
 * asked `> 0`.
 *
 * WHAT MAKES THIS DIFFERENT FROM READING THE BRANCHES. Every case here calls
 * the real function with a residue in the data and checks the number that comes
 * out. The concentration case carries a CONTROL alongside it: the same tick set
 * with the residue replaced by a real small position, which must produce a
 * different answer. Without that control the test would pass just as happily if
 * the function had stopped measuring anything at all.
 *
 * The SQL case runs against the actual recorded row — the 06:01:31Z snapshot of
 * agent a24df218 — and runs BOTH expressions over it, so the difference is
 * measured on production data rather than asserted about it.
 *
 * The Go side of the same fix is driven in
 * services/decision-engine/internal/engine/dust_test.go, including the exact
 * balance that produced the residue.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const REPO = process.env.REPO || '/home/ubuntu/arcana';
const PG = process.env.PG_CONTAINER || 'arcana-postgres';
const SVC = `${REPO}/services/agent-service`;

let pass = 0, fail = 0;
const failures = [];
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; failures.push(`${n} — ${d}`); console.log(`  FAIL  ${n} — ${d}`); }
};
const psql = (s) => execFileSync('docker', ['exec', PG, 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc', s], { encoding: 'utf8' }).trim();

// The readers are TypeScript and this is not, so they are compiled and the real
// compiled functions are called. Not a re-implementation: a re-implementation
// would be a second opinion about what the code should do, and the bug was
// never a disagreement about that.
//
// COMPILED SOMEWHERE ELSE. `npm run build` writes into the dist/ the running
// service loads from, which is a production artefact and is owned by root — so
// the first attempt failed on permissions, which was the right outcome for the
// wrong reason. A verification must not be able to redeploy the thing it is
// verifying even when it is allowed to.
// INSIDE THE REPOSITORY, because the compiled readers still
// `require('@nestjs/common')` when they load and the dependencies are hoisted
// to the repository root. A build under /tmp resolves nothing.
const OUT = process.env.DUST_BUILD_DIR || `${REPO}/.dust-verify-build`;
console.log(`  compiling the readers into ${OUT} (not into the live dist)...`);
execFileSync('npx', ['tsc', '-p', 'tsconfig.json', '--outDir', OUT,
  '--noEmitOnError', 'false', '--tsBuildInfoFile', `${OUT}/.tsbuildinfo`],
  { cwd: SVC, stdio: 'pipe' });
const require_ = createRequire(`${OUT}/`);

const positionsPath = `${OUT}/common/positions.js`;
check('the shared definition compiled', existsSync(positionsPath), positionsPath);
const { DUST_FLOOR, isPosition, positionsOf } = require_(positionsPath);
const { DnaService } = require_(`${OUT}/dna/dna.service.js`);
const { AutopsyService } = require_(`${OUT}/autopsy/autopsy.service.js`);

// =========================================================================
console.log('\n=== The definition itself ===');
check('the floor is the precision of decisions.quantity', DUST_FLOOR === 1e-8, String(DUST_FLOOR));
check('a wei of an 18-decimal token is not a position', isPosition(1e-18) === false, '1e-18 counted');
check('the floor itself IS a position', isPosition(1e-8) === true,
  'a quantity that can be recorded must count, or the definition contradicts its own argument');
check('a real position is a position', isPosition(0.0177) === true, '0.0177 rejected');
check('null and NaN are not positions',
  !isPosition(null) && !isPosition(undefined) && !isPosition(NaN), 'a missing quantity passed');
check('positionsOf drops the residue and keeps the rest',
  JSON.stringify(positionsOf({ GOOGL: 1e-18, AAPL: 0.5 })) === JSON.stringify([['AAPL', 0.5]]),
  JSON.stringify(positionsOf({ GOOGL: 1e-18, AAPL: 0.5 })));

// =========================================================================
// DNA concentration. The index scores a single-symbol tick as 1 — maximally
// concentrated — and the service's own comment says a tick holding NOTHING is
// skipped rather than counted that way. A residue defeated exactly that.
console.log('\n=== DNA concentration skips a tick that holds only residue ===');
{
  const prices = { AAPL: 100, GOOGL: 100 };
  const market = new Map([['r1', { ref: 'r1', tickTime: new Date(), prices, marketReturn: 0 }]]);
  const tick = (holdings) => ({
    ts: new Date(), nav: 1000, cash: 500, holdings,
    ref: 'r1', action: null, symbol: null, quantity: null,
  });

  // Two evenly-split ticks, which score 0, and one tick that is really flat.
  const even = { AAPL: 5, GOOGL: 5 };
  const dna = new DnaService(null, null);

  const withResidue = dna.deriveFeatures([tick(even), tick(even), tick({ GOOGL: 1e-18 })], market);
  const withoutIt = dna.deriveFeatures([tick(even), tick(even)], market);
  check('a residue-only tick does not change the fingerprint',
    withResidue.concentration === withoutIt.concentration,
    `with residue ${withResidue.concentration}, without ${withoutIt.concentration}`);
  check('and the value is the even-split value, not a concentrated one',
    withResidue.concentration === 0, String(withResidue.concentration));

  // THE CONTROL. Replace the residue with a real single-symbol position and the
  // number MUST move. Without this, a deriveFeatures that had stopped counting
  // anything would pass the check above.
  const withRealPosition = dna.deriveFeatures([tick(even), tick(even), tick({ GOOGL: 0.5 })], market);
  check('a real single-symbol tick still scores as concentrated',
    withRealPosition.concentration > withoutIt.concentration,
    `real position gave ${withRealPosition.concentration}, same as the residue case`);
  console.log(`      even only ${withoutIt.concentration}, + residue ${withResidue.concentration}, ` +
    `+ a real position ${withRealPosition.concentration.toFixed(4)}`);
}

// =========================================================================
console.log('\n=== Autopsy does not list a symbol the agent held only residue of ===');
{
  const market = new Map([
    ['r1', { ref: 'r1', tickTime: new Date(), prices: { AAPL: 100, GOOGL: 100 }, marketReturn: 0.01 }],
    ['r2', { ref: 'r2', tickTime: new Date(), prices: { AAPL: 110, GOOGL: 110 }, marketReturn: 0.01 }],
  ]);
  const tick = (ref, holdings) => ({
    ts: new Date(), nav: 1000, cash: 500, holdings, ref,
    action: null, symbol: null, quantity: null, rationale: null,
  });
  const autopsy = new AutopsyService(null, null);
  const out = autopsy.allocation([tick('r1', { AAPL: 1, GOOGL: 1e-18 }), tick('r2', { AAPL: 1 })], market);
  const symbols = out.by_symbol.map((r) => r.symbol);
  check('the residue symbol is absent from the breakdown',
    !symbols.includes('GOOGL'), symbols.join(', '));
  check('and the real position is still there', symbols.includes('AAPL'), symbols.join(', '));
}

// =========================================================================
// The chart counts positions in SQL, where no constant can reach. Both
// expressions are run over the row that actually carried the residue.
console.log('\n=== The chart counts positions, measured on the recorded row ===');
{
  const DUSTY_TS = '2026-09-11 06:01:31.501685+00';
  const exists = psql(`SELECT count(*) FROM portfolio_snapshots WHERE ts = '${DUSTY_TS}'`);
  check('the snapshot that carried the residue is still in the table', exists === '1',
    `found ${exists} rows at ${DUSTY_TS}; if the row is gone this check is measuring nothing`);

  if (exists === '1') {
    const oldWay = psql(
      `SELECT jsonb_array_length(COALESCE(jsonb_path_query_array(holdings, '$.keyvalue()'), '[]'::jsonb))
         FROM portfolio_snapshots WHERE ts = '${DUSTY_TS}'`);
    const newWay = psql(
      `SELECT (SELECT count(*) FROM jsonb_each_text(COALESCE(holdings, '{}'::jsonb)) kv
                WHERE kv.value ~ '^-?[0-9.eE+-]+$' AND kv.value::float8 >= 1e-8)::int
         FROM portfolio_snapshots WHERE ts = '${DUSTY_TS}'`);
    check('counting keys read it as holding one position', oldWay === '1', `old expression said ${oldWay}`);
    check('counting positions reads it as holding none', newWay === '0', `new expression said ${newWay}`);
    console.log(`      the recorded holdings: ${psql(`SELECT holdings::text FROM portfolio_snapshots WHERE ts = '${DUSTY_TS}'`)}`);
  }

  // And the mixed case, which the historical row cannot show: a residue
  // alongside a real position must count one, not two and not zero.
  const mixed = psql(
    `SELECT (SELECT count(*) FROM jsonb_each_text('{"GOOGL":0.000000000000000001,"AAPL":0.5}'::jsonb) kv
              WHERE kv.value ~ '^-?[0-9.eE+-]+$' AND kv.value::float8 >= 1e-8)::int`);
  check('a residue beside a real position counts one', mixed === '1', `counted ${mixed}`);
  const atFloor = psql(
    `SELECT (SELECT count(*) FROM jsonb_each_text('{"AAPL":0.00000001}'::jsonb) kv
              WHERE kv.value ~ '^-?[0-9.eE+-]+$' AND kv.value::float8 >= 1e-8)::int`);
  check('and the floor itself counts', atFloor === '1', `counted ${atFloor}`);
}

console.log('\n' + '='.repeat(40));
console.log(`  PASS: ${pass}   FAIL: ${fail}`);
console.log('='.repeat(40));
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('dust-verify: every reader was handed a residue and none of them called it a position.');
