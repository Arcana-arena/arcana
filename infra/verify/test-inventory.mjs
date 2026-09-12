/**
 * test-inventory.mjs — what a green `npm test` actually checked.
 *
 * WHY THIS EXISTS. `npm test` used to exit 1, because three of the four Node
 * workspaces run `jest` with no test files at all. A suite that is red for a
 * reason nobody intends to fix teaches everyone to stop reading it, so the jest
 * runs now pass with --passWithNoTests.
 *
 * That trade is only acceptable with this file next to it. Green because there
 * was nothing to run is the exact pattern this repository keeps digging out:
 * `go test` printing `ok` over six tests that never executed, a verify section
 * printing its header and no checks, a skip counted as a pass. Adding
 * --passWithNoTests without recording the absence would be committing that
 * pattern on purpose.
 *
 * SO THE ABSENCE IS AN ASSERTION, not a comment. test-inventory.json declares
 * how many test files each workspace has. This counts what is actually on disk
 * and fails if the two disagree — IN EITHER DIRECTION:
 *
 *   - Someone writes the first test for agent-service: this fails until the
 *     ledger is updated. The point is that it cannot happen quietly.
 *   - Someone deletes a suite, or a rename stops jest matching it: this fails.
 *     That is the drift --passWithNoTests would otherwise hide completely.
 *
 * It needs no database, no services and no network, so it runs anywhere `npm
 * test` runs.
 *
 * THE GO SUITE IS NOT COVERED HERE. It is not run by npm at all; `make test-go`
 * runs it and prints its own passed/failed/skipped counts per module.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = join(ROOT, 'infra', 'verify', 'test-inventory.json');

// Jest's default testMatch, which is what these workspaces use:
//   **/__tests__/**/*.[jt]s?(x)   and   **/?(*.)+(spec|test).[tj]s?(x)
const isTestFile = (path) =>
  /(^|[\\/])__tests__[\\/].*\.[jt]sx?$/.test(path) ||
  /(^|[\\/])[^\\/]*(^|\.)(spec|test)\.[jt]sx?$/.test(path);

const walk = (dir, acc = []) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (isTestFile(p)) acc.push(p);
  }
  return acc;
};

// The workspaces npm will actually run, expanded from the root package.json.
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const dirs = [];
for (const pattern of rootPkg.workspaces || []) {
  const base = pattern.replace(/[\\/]\*$/, '');
  const abs = join(ROOT, base);
  if (!existsSync(abs)) continue;
  for (const name of readdirSync(abs)) {
    const d = join(abs, name);
    if (statSync(d).isDirectory() && existsSync(join(d, 'package.json'))) {
      dirs.push({ rel: `${base}/${name}`, abs: d });
    }
  }
}

const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
const declared = ledger.workspaces || {};

let fail = 0;
const rows = [];
for (const { rel, abs } of dirs) {
  const pkg = JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8'));
  const runsTests = Boolean(pkg.scripts && pkg.scripts.test);
  const found = walk(abs).length;
  const entry = declared[rel];
  rows.push({ rel, name: pkg.name, runsTests, found, entry });
  if (!entry) {
    fail++;
    console.log(`  FAIL  ${rel} is a workspace that ${LEDGER} does not mention. ` +
      'A workspace nobody has decided about is one nobody is measuring.');
    continue;
  }
  if (entry.tests !== found) {
    fail++;
    console.log(`  FAIL  ${rel} declares ${entry.tests} test file(s) and has ${found}. ` +
      (found > entry.tests
        ? 'Tests were added: update the ledger, which is the point of it — this cannot happen quietly.'
        : 'Tests DISAPPEARED, or a rename stopped jest matching them. --passWithNoTests would ' +
          'have reported that as a pass.'));
  }
}
for (const rel of Object.keys(declared)) {
  if (!dirs.some((d) => d.rel === rel)) {
    fail++;
    console.log(`  FAIL  ${LEDGER} declares ${rel}, which is not a workspace any more.`);
  }
}

const width = Math.max(...rows.map((r) => r.name.length));
console.log('\nWhat `npm test` just checked:\n');
for (const r of rows.sort((a, b) => a.name.localeCompare(b.name))) {
  const note = r.found === 0
    ? (r.runsTests ? 'runs jest, has NO tests' : 'no test script')
    : `${r.found} test file(s)`;
  console.log(`  ${r.name.padEnd(width)}  ${String(r.found).padStart(3)}  ${note}`);
}

const empty = rows.filter((r) => r.found === 0 && r.runsTests);
const total = rows.reduce((a, r) => a + r.found, 0);
console.log(`\n  ${total} test file(s) across ${rows.length} Node workspace(s).`);
if (empty.length > 0) {
  console.log(`  ${empty.length} workspace(s) run jest over nothing and pass on ` +
    '--passWithNoTests: ' + empty.map((r) => r.name).join(', ') + '.');
  console.log('  That is DECLARED in infra/verify/test-inventory.json, not discovered here. ' +
    'A green run above means those were not tested, and says so.');
}
console.log('  The Go suite is separate and is not run by npm: use `make test-go`.');

if (fail > 0) {
  console.log(`\ntest-inventory: ${fail} mismatch(es) between what is declared and what is on disk.`);
  process.exit(1);
}
console.log('\ntest-inventory: what is on disk matches what is declared.');
