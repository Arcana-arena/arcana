/**
 * run-all.mjs — run the verifiers and say what failed, not just how many did.
 *
 * WHY THIS EXISTS. The throwaway script this replaces scraped each suite's
 * summary line and nothing else. guard-verify came back "PASS: 27 FAIL: 1" and
 * the tool could not say which of the 28 checks had failed, because it had
 * thrown the output away. Four re-runs were green, so the failure looked
 * unreproducible when in fact it had simply never been recorded.
 *
 * A summary with no failure text is the same defect this repository keeps
 * removing — `ok` over six tests that never ran, a section printing its header
 * and no checks, a skip counted as a pass — this time in the instrument used to
 * look for it. An instrument that loses the evidence is worse than no
 * instrument, because it produces a number people believe.
 *
 * So every run's full output is kept on disk, every FAIL line is printed under
 * the suite it came from, and the log path is printed beside it.
 *
 *   node infra/verify/run-all.mjs                     every verifier, once
 *   node infra/verify/run-all.mjs guard-verify        just that one
 *   node infra/verify/run-all.mjs --repeat 30 guard-verify   chase a flake
 *
 * It sources nothing. Run it with the environment already loaded:
 *   set -a; . ./.env; . ./.env.auth; set +a
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const LOGS = join(ROOT, '.verify-logs');
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || 300000);

const argv = process.argv.slice(2);
let repeat = 1;
const names = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--repeat') repeat = Number(argv[++i]) || 1;
  else names.push(argv[i]);
}

const all = readdirSync(HERE).filter((f) => f.endsWith('-verify.mjs')).sort();
const chosen = names.length
  ? all.filter((f) => names.some((n) => f === n || f === `${n}.mjs` || f.startsWith(n)))
  : all;
if (chosen.length === 0) {
  console.log(`no verifier matches ${names.join(', ')}. Available:\n  ${all.join('\n  ')}`);
  process.exit(2);
}

mkdirSync(LOGS, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

// Both summary shapes in use: "39 pass, 0 fail" and "PASS: 27   FAIL: 1".
const readCounts = (out) => {
  let m = out.match(/^(\d+) pass, (\d+) fail$/m);
  if (m) return { pass: +m[1], fail: +m[2] };
  m = out.match(/PASS: (\d+)\s+FAIL: (\d+)/);
  if (m) return { pass: +m[1], fail: +m[2] };
  return null;
};

const results = [];
for (const file of chosen) {
  for (let run = 1; run <= repeat; run++) {
    let out = '';
    let code = 0;
    const started = Date.now();
    try {
      out = execFileSync('node', [join(HERE, file)],
        { cwd: ROOT, encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = String(e.stdout || '') + String(e.stderr || '');
      code = e.status === undefined ? 124 : e.status;
    }
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    const log = join(LOGS, `${stamp}_${file.replace(/\.mjs$/, '')}${repeat > 1 ? `_${run}` : ''}.log`);
    writeFileSync(log, out);

    // THE PART THE OLD SCRIPT THREW AWAY. Every suite here prints a failed
    // check as "  FAIL  <name> — <detail>", so that one shape is all it takes;
    // the "Failures:" block at the end of a run repeats the same lines.
    const fails = out.split('\n').filter((l) => /^\s*FAIL\s{2}/.test(l));
    const quiet = out.split('\n').filter((l) => /NOT YET|NOTHING TO CHECK|did not run|checked nothing/.test(l));
    results.push({ file, run, code, secs, counts: readCounts(out), log, out, fails, quiet });
  }
}

const width = Math.max(...results.map((r) => r.file.length));
let bad = 0;
for (const r of results) {
  const c = r.counts ? `${r.counts.pass} pass, ${r.counts.fail} fail` : '(no summary line found)';
  const tag = r.code === 124 ? 'TIMEOUT' : `exit=${r.code}`;
  const label = repeat > 1 ? `${r.file} #${r.run}` : r.file;
  console.log(`  ${label.padEnd(width + 4)} ${tag.padEnd(9)} ${c.padEnd(22)} ${r.secs}s`);
  if (r.code !== 0 || (r.counts && r.counts.fail > 0)) {
    bad++;
    const seen = new Set();
    for (const l of r.fails) {
      const t = l.trim();
      if (seen.has(t)) continue;
      seen.add(t);
      console.log(`        ${t}`);
    }
    if (r.fails.length === 0) {
      console.log('        (no FAIL line in the output — read the log, it exited non-zero anyway)');
    }
    console.log(`        log: ${r.log}`);
  }
}

const quietLines = results.flatMap((r) => r.quiet.map((l) => `${r.file}: ${l.trim()}`));
if (quietLines.length > 0) {
  console.log('\nNot proven by these runs (declared, not discovered):');
  for (const l of [...new Set(quietLines)]) console.log(`  - ${l}`);
}

console.log(`\n${results.length} run(s), ${bad} failing. Logs in ${LOGS}`);
if (repeat > 1) {
  const byFile = new Map();
  for (const r of results) {
    const e = byFile.get(r.file) || { n: 0, bad: 0 };
    e.n++;
    if (r.code !== 0 || (r.counts && r.counts.fail > 0)) e.bad++;
    byFile.set(r.file, e);
  }
  console.log('\nFlake rate over these runs:');
  for (const [f, e] of byFile) {
    console.log(`  ${f}: ${e.bad}/${e.n} failed` +
      (e.bad === 0 ? ' — which bounds the rate, it does not show there is none' : ''));
  }
}
process.exit(bad > 0 ? 1 : 0);
