import { execSync } from 'node:child_process';

/**
 * THE COMMIT IS BAKED IN AT BUILD TIME, and that is the whole point.
 *
 * A deploy can build a new bundle, stamp it, and leave the old process serving
 * the old pages — `next start` reads its manifests once, at boot. That happened
 * here: the installer restarted seven services and the web was not one of them,
 * so visitors were served a build from hours earlier while every check on the
 * machine reported success.
 *
 * The check that would have caught it has to ask the RUNNING SERVER what it is,
 * from the address a visitor uses. So the identity cannot be read from disk at
 * request time — a stale process would happily read the new stamp file and
 * report a commit it is not running. It has to be compiled in, which is what
 * `env` does: the value is inlined into the bundle, so an old bundle can only
 * ever say the old commit.
 *
 * A build outside a git checkout reports `unknown` rather than failing. The
 * verifier treats `unknown` as a failure to identify, which is the honest
 * outcome — it is not the same as a match and must not be read as one.
 */
function buildCommit() {
  if (process.env.ARCANA_BUILD_COMMIT) return process.env.ARCANA_BUILD_COMMIT;
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

const COMMIT = buildCommit();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Nothing here is a static site. Every page reads live numbers, and a page
  // that silently served a cached 3-hour-old score would be the same class of
  // lie this codebase keeps removing — so the data layer opts out of caching
  // explicitly (see src/lib/api.ts) rather than relying on a default.
  poweredByHeader: false,
  output: 'standalone',

  // Inlined at build. Read by the root layout for its meta tag and by
  // /api/build, so both report the bundle rather than the disk.
  env: { ARCANA_BUILD_COMMIT: COMMIT },

  /**
   * The same value as a response header on every page.
   *
   * A header is what a verifier can read without parsing HTML, and it survives
   * a page that fails to render — which is precisely when knowing which build
   * answered matters most.
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [{ key: 'x-arcana-build', value: COMMIT }],
      },
    ];
  },
};

export default nextConfig;
