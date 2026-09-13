/**
 * service-errors-verify.mjs — no request-serving service has answered with a 500.
 *
 * WHY THIS IS A SUITE. The earnings read failed for every creator with a wallet
 * from 2026-09-13. creator-dashboard-verify and creator-onboarding-verify both
 * reached that exact query on every run and passed, because agent-service turned
 * arca's 500 into a tolerated "could not be read" and the page still rendered.
 * Every check asked "did the page render?" and none asked "did anything behind
 * it fail?". The journal knew the whole time.
 *
 * So this reads each service's journal since its CURRENT process started — a
 * deploy is a clean slate, and an error from before it is either fixed or will
 * recur — and fails on any server error. Run last in a sweep, it also catches
 * every 500 the other suites provoked without asserting on.
 *
 * It also checks that arcana-error-watch, the timer that does the same thing
 * between sweeps, is actually enabled.
 *
 *   node infra/verify/service-errors-verify.mjs
 */
import { execFileSync } from 'node:child_process';
import { suite } from './lib/sections.mjs';

const { check, section, report } = suite('service-errors-verify');
const UNITS = ['arcana-agent', 'arcana-arca', 'arcana-marketplace', 'arcana-web'];
const PATTERN = /ExceptionsHandler|QueryFailedError|Internal server error|UnhandledPromiseRejection/;

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const clean = (l) =>
  l.replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/^.*(ERROR|WARN)[^\]]*\] */, '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .slice(0, 180);

await section('No request-serving service has answered with a server error since it started', async () => {
  for (const unit of UNITS) {
    const since = sh('systemctl', ['show', unit, '-p', 'ActiveEnterTimestamp', '--value']).trim();
    if (!since) {
      check(`${unit} is running`, false, 'no ActiveEnterTimestamp — the unit is not active');
      continue;
    }
    let log = '';
    try {
      log = sh('journalctl', ['-u', unit, '--since', since, '--no-pager', '-o', 'cat']);
    } catch (e) {
      check(`the journal of ${unit} can be read`, false, String(e.stderr || e.message));
      continue;
    }
    const hits = log.split('\n').filter((l) => PATTERN.test(l));
    const grouped = [...hits.map(clean).reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map())]
      .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([l, n]) => `${n}× ${l}`);
    check(`${unit} logged no server error since ${since}`, hits.length === 0, grouped.join(' | '));
  }
});

// A 502 NEVER REACHES A SERVICE JOURNAL. nginx routed /v1/arca/* and
// /v1/subscriptions/* to 3003, where nothing listens, for as long as arca-service
// has run on 3004: every public call failed at the proxy, every internal call
// (configured separately) worked, and no journal above could see it. So the
// routing table itself is checked against what is listening, and each public
// prefix is requested through the public origin.
await section('Every public route reaches a service that is listening', async () => {
  const conf = (() => {
    try {
      return execFileSync('cat', ['/home/ubuntu/arcana/infra/nginx/arcana-locations.conf'], { encoding: 'utf8' });
    } catch {
      return '';
    }
  })();
  const ports = [...new Set([...conf.matchAll(/proxy_pass http:\/\/127\.0\.0\.1:(\d+)/g)].map((m) => m[1]))];
  check('the nginx routing table names upstream ports', ports.length > 0, 'no proxy_pass found in arcana-locations.conf');
  const listening = (() => {
    try {
      return sh('ss', ['-ltnH']);
    } catch {
      return '';
    }
  })();
  for (const p of ports) {
    check(`something listens on 127.0.0.1:${p}, which nginx routes to`, new RegExp(`127\\.0\\.0\\.1:${p}\\s`).test(listening),
      `nginx proxies to ${p} and nothing is listening there — every request on that route answers 502`);
  }

  const origin = process.env.PUBLIC_ORIGIN || 'https://arcana-arena.com';
  for (const path of ['/healthz', '/v1/anchors', '/v1/marketplace/listings', '/v1/arca/terms', '/v1/subscriptions/mine']) {
    let status = 0;
    try {
      status = (await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(15000) })).status;
    } catch (e) {
      check(`${origin}${path} answers`, false, e instanceof Error ? e.message : String(e));
      continue;
    }
    // 401/404 are the service answering. 502/503/504 are the proxy answering for a service that is not there.
    check(`${origin}${path} is answered by a service, not by the proxy`, status > 0 && status < 502, `status ${status}`);
  }
});

await section('Something watches for them between sweeps', async () => {
  const enabled = (() => { try { return sh('systemctl', ['is-enabled', 'arcana-error-watch.timer']).trim(); } catch (e) { return String(e.stdout || '').trim(); } })();
  check('arcana-error-watch.timer is enabled', enabled === 'enabled', `is-enabled: ${enabled || 'not installed'}`);
  const result = (() => { try { return sh('systemctl', ['show', 'arcana-error-watch.service', '-p', 'Result', '--value']).trim(); } catch { return ''; } })();
  check('and its last run did not fail', result === 'success' || result === '', `Result=${result}`);
});

const code = report();
if (code !== 0) process.exit(code);
console.log('service-errors-verify: no service answered a request with a server error.');
