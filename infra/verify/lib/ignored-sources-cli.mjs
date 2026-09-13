/**
 * The pre-commit hook's entry point into the rule.
 *
 * A FILE RATHER THAN AN INLINE SNIPPET, because `node --input-type=module -e`
 * has to be handed an import specifier, and a Windows path built into one is
 * not a valid URL — the hook refused a commit with ERR_UNSUPPORTED_ESM_URL_SCHEME
 * instead of the message it was written to print. A hook that fails for its own
 * reasons rather than the repository's is a hook people pass --no-verify to,
 * and then keep passing.
 *
 * Prints nothing and exits 0 when there is nothing wrong, so an ordinary commit
 * sees no output at all.
 *
 *   node infra/verify/lib/ignored-sources-cli.mjs [repo-root]
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ignoredSourcePaths, explain } from './ignored-sources.mjs';

const root = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const { ignored } = ignoredSourcePaths(root);
if (ignored.length === 0) process.exit(0);

console.error('');
console.error('COMMIT REFUSED — source files are being ignored by git');
console.error('');
console.error(explain(ignored));
console.error('');
console.error('To commit anyway: git commit --no-verify. The sweep will fail on the same thing.');
console.error('');
process.exit(1);
