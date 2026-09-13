import { NextResponse } from 'next/server';

/**
 * Which build is answering, according to the build itself.
 *
 * THE VALUE IS COMPILED IN, not read from disk. That distinction is the entire
 * reason this route exists. A deploy writes a new bundle and a new stamp file;
 * if this read the file, a process still serving the previous bundle would
 * report the new commit and every check would pass while visitors were served
 * old pages. `process.env.ARCANA_BUILD_COMMIT` is inlined by next.config.mjs at
 * build time, so an old bundle can only say the old commit.
 *
 * PUBLIC ON PURPOSE. It reveals a commit hash for a repository whose contents
 * are the product, and the alternative — a check that needs a credential — is a
 * check that stops being run.
 *
 * `unknown` means the build could not identify itself. The verifier treats that
 * as a failure rather than a pass: not knowing which build is running is the
 * same position as knowing it is the wrong one.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  const commit = process.env.ARCANA_BUILD_COMMIT || 'unknown';
  return NextResponse.json(
    {
      build_commit: commit,
      identified: commit !== 'unknown',
      note:
        commit === 'unknown'
          ? 'This bundle was built outside a git checkout and carries no commit. Nothing can tell ' +
            'whether it is current.'
          : 'Compiled into the bundle at build time. A process serving an older bundle reports the ' +
            'older commit, which is what makes this answerable from outside.',
      // NOT the build time and NOT the boot time: either would be read at
      // request time and could describe something other than this bundle.
      as_of: new Date().toISOString(),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
