/**
 * ignored-sources.mjs — the one definition of "a source file must not be ignored".
 *
 * THE FAILURE THIS EXISTS FOR. A .gitignore pattern that matches a SOURCE path
 * removes the file from the repository without a word. `git add -A` says
 * nothing, the commit succeeds, and the file exists only on the machine that
 * wrote it. No comparison between a clone and this machine can see it, because
 * an untracked file has no place in the commit it is being compared against —
 * there is nothing to differ.
 *
 * It has happened twice, eleven months apart, with the same shape both times:
 *
 *   `vendor/`  unanchored, swallowed services/market-data/internal/vendor —
 *              this project's own market-data adapter, not vendored
 *              dependencies. A fresh clone could not build market-data.
 *   `build/`   unanchored, swallowed services/web/src/app/api/build — the
 *              route that reports which commit the running bundle is. The
 *              endpoint written to detect a stale deploy was itself missing
 *              from the deploy.
 *
 * The second one happened AFTER the first was fixed and documented, because the
 * lesson was applied to one pattern and not to the three sitting beside it. A
 * comment in .gitignore did not stop it. So the rule lives here, in code, with
 * two callers: the sweep (repo-complete-verify) and a pre-commit hook that
 * refuses the commit before it is made.
 *
 * THE RULE: nothing under a service or package SOURCE tree is ever build
 * output, so nothing under one may be ignored. It is deliberately blunt. A rule
 * with exceptions is a rule somebody argues with at the moment they are in a
 * hurry.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The directories inside a service or package that hold hand-written code. */
export const SOURCE_DIRS = ['src', 'internal', 'cmd', 'app'];

/** Every source tree that exists in this repository right now. */
export function sourceTrees(root) {
  const out = [];
  for (const base of ['services', 'packages']) {
    let entries = [];
    try {
      entries = readdirSync(join(root, base), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      for (const src of SOURCE_DIRS) {
        if (existsSync(join(root, base, e.name, src))) out.push(`${base}/${e.name}/${src}`);
      }
    }
  }
  return out;
}

/**
 * Paths inside a source tree that git is ignoring.
 *
 * Asked of git rather than reimplemented. gitignore semantics are subtle —
 * anchoring, negation, directory-only patterns, nested .gitignore files — and a
 * second implementation of them would agree with the first until the day
 * somebody edited one of them.
 */
export function ignoredSourcePaths(root) {
  const trees = sourceTrees(root);
  const found = [];
  for (const dir of trees) {
    let lines = [];
    try {
      lines = execFileSync(
        'git',
        ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', dir],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      )
        .split('\n')
        .filter(Boolean);
    } catch {
      // Not a git repository, or git is unavailable. Reported as no findings
      // rather than as an error: the callers each decide what to do about a
      // check they could not run, and neither should crash over it.
      lines = [];
    }
    found.push(...lines);
  }
  return { trees, ignored: found };
}

/** What to tell somebody who just tripped it. Same words in both callers. */
export function explain(ignored) {
  return [
    'These paths are inside a service or package source tree and git is IGNORING them:',
    '',
    ...ignored.map((f) => `    ${f}`),
    '',
    'They exist on this machine and are NOT in the repository. `git add -A` will not',
    'add them, the commit will succeed, and a fresh clone — or the server — will not',
    'have them at all. Nothing downstream can detect this: an untracked file has no',
    'place in the commit it would be compared against.',
    '',
    'This has happened twice on this project. `vendor/` unanchored swallowed',
    "services/market-data/internal/vendor; `build/` unanchored swallowed",
    'services/web/src/app/api/build — the endpoint written to detect a stale deploy',
    'was itself missing from the deploy.',
    '',
    'THE FIX is almost always to anchor the pattern in .gitignore rather than to',
    'move the source. `build/` matches a directory of that name at ANY depth;',
    '`/services/*/build/` matches the one place build output actually lands.',
    '',
    'If a path here genuinely is generated and belongs outside the repository, move',
    'it out of the source tree. Do not add a negation: an exception to this rule is',
    'the next instance of this bug.',
  ].join('\n');
}
