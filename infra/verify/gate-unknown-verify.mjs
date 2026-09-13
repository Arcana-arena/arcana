/**
 * gate-unknown-verify.mjs — the third state of a gate, built rather than waited for.
 *
 * `access.enforced` has three values and only two of them ever occur on this
 * deployment. `true` means entry is verified against a live balance. `false`
 * means the gates are wired and admit everyone. `null` means the $ARCA service
 * could not be reached, so nobody knows which of the two it is — and rendering
 * that as "free entry" would be the page answering a question the platform
 * could not.
 *
 * Every season here reads `false`, so web-verify has always ended that section
 * with "no season currently has enforced=null, so the unknown-gate rendering is
 * not exercised". Declared rather than passed quietly, which was right, and
 * still leaves the one rendering that matters most unproven: the state nobody
 * can see is the state nobody notices is broken.
 *
 * SO THIS BUILDS THE CONDITION INSTEAD OF WAITING FOR IT, and builds it for the
 * real reason. No stub payload with the field flipped: a second agent-service
 * is started with ARCA_SERVICE_URL pointed at a port nothing is listening on,
 * which is exactly what an arca outage looks like from inside. The real
 * entitlement client times out, the real gate reads `unknown`, the real
 * `seasonView()` computes `enforced: null`, and a second web process rendering
 * from THAT service is what gets read. Every line of code under test is the
 * shipped one.
 *
 * IT ALSO PROVES THE CONTROL. The same page is fetched from the live web
 * process, where arca IS reachable, and must NOT say the gate is unknown —
 * otherwise a page that said "GATE UNKNOWN" unconditionally would pass.
 *
 * Nothing is written to the database and no live process is touched. Both
 * temporary processes are killed on the way out, including on an interrupt.
 *
 *   node infra/verify/gate-unknown-verify.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite } from './lib/sections.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIVE_AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const LIVE_WEB = process.env.WEB_URL || 'http://127.0.0.1:3000';

// High and unusual on purpose: these must not collide with a service this host
// actually runs, and a collision is refused below rather than measured.
const AGENT_PORT = Number(process.env.RIG_AGENT_PORT || 39101);
const WEB_PORT = Number(process.env.RIG_WEB_PORT || 39102);
// The outage. Nothing listens here, and assertPortFree proves it before use.
const DEAD_ARCA_PORT = Number(process.env.RIG_DEAD_PORT || 39109);

const { check, section, report } = suite('gate-unknown-verify');

const children = [];
function killAll() {
  for (const c of children) {
    try {
      // The whole group: `next start` forks a server, and killing only the
      // parent leaves the child holding the port — the orphan this project has
      // already been bitten by twice.
      process.kill(-c.pid, 'SIGKILL');
    } catch {
      try { c.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
  for (const p of [AGENT_PORT, WEB_PORT]) {
    try { execFileSync('bash', ['-lc', `fuser -k ${p}/tcp 2>/dev/null || true`]); } catch { /* best effort */ }
  }
}
process.on('exit', killAll);
process.on('SIGINT', () => { killAll(); process.exit(130); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Refuse to run against a stranger on the port, rather than measuring it. */
async function assertPortFree(port, what) {
  try { execFileSync('bash', ['-lc', `fuser -k ${port}/tcp 2>/dev/null || true`]); } catch { /* none */ }
  await sleep(400);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    throw new Error(
      `something is already listening on ${port} (answered ${r.status}) and this suite would have ` +
      `measured it instead of the ${what} it starts. Refusing to run.`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('something is already listening')) throw e;
    // Connection refused is the outcome this wants.
  }
}

async function waitFor(url, what, timeoutMs = 90000) {
  const until = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.status < 500) return true;
      last = `status ${r.status}`;
    } catch (e) {
      last = String(e.message ?? e);
    }
    await sleep(700);
  }
  throw new Error(`${what} never came up at ${url} within ${timeoutMs / 1000}s (last: ${last})`);
}

function start(cmd, args, opts) {
  const c = spawn(cmd, args, { ...opts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(c);
  // Kept, not printed: a failure to start needs the reason, and a success does
  // not need the noise.
  c.tail = '';
  const grab = (b) => { c.tail = (c.tail + b.toString()).slice(-4000); };
  c.stdout.on('data', grab);
  c.stderr.on('data', grab);
  return c;
}

const json = async (url) => {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  const t = await r.text();
  try { return { status: r.status, body: t ? JSON.parse(t) : null }; } catch { return { status: r.status, body: null }; }
};
const html = async (url) => {
  const r = await fetch(url, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(30000) });
  return { status: r.status, html: await r.text() };
};
const text = (h) =>
  h.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ').replace(/&ldquo;|&rdquo;/g, '"').replace(/\s+/g, ' ');

const AGENT_DIST = join(ROOT, 'services/agent-service/dist/main.js');
const WEB_DIR = join(ROOT, 'services/web');

try {
  await section('The rig can be built at all', async () => {
    check('the agent service is built', existsSync(AGENT_DIST), `${AGENT_DIST} does not exist`);
    check('the web app is built', existsSync(join(WEB_DIR, '.next')), 'services/web/.next does not exist');
    await assertPortFree(AGENT_PORT, 'agent service');
    await assertPortFree(WEB_PORT, 'web process');
    await assertPortFree(DEAD_ARCA_PORT, 'unreachable arca stand-in');
    check('the three rig ports are free', true);

    // THE OUTAGE IS PROVEN, NOT ASSUMED. If something answered on the port this
    // points arca at, the gate would read `inactive` and the whole suite would
    // pass for the wrong reason.
    let answered = false;
    try {
      await fetch(`http://127.0.0.1:${DEAD_ARCA_PORT}/v1/arca/entitlements/check?action=compete`,
        { signal: AbortSignal.timeout(1500) });
      answered = true;
    } catch { /* refused, which is the point */ }
    check('nothing answers on the port arca will be pointed at', !answered,
      `something is listening on ${DEAD_ARCA_PORT}; the gate would read inactive rather than unknown`);
  });

  await section('With $ARCA unreachable, the real service reports the gate as unknown', async () => {
    const agent = start('node', [AGENT_DIST], {
      cwd: join(ROOT, 'services/agent-service'),
      env: {
        ...process.env,
        PORT: String(AGENT_PORT),
        // THE WHOLE RIG, IN ONE VARIABLE.
        ARCA_SERVICE_URL: `http://127.0.0.1:${DEAD_ARCA_PORT}`,
      },
    });
    try {
      await waitFor(`http://127.0.0.1:${AGENT_PORT}/v1/seasons?page_size=1`, 'the rig agent service');
    } catch (e) {
      check('the rig agent service starts', false, `${e.message} — last output: ${agent.tail.slice(-600)}`);
      throw e;
    }
    check('the rig agent service starts', true);

    const rig = await json(`http://127.0.0.1:${AGENT_PORT}/v1/seasons?page_size=50`);
    check('it answers the seasons list', rig.status === 200, `status ${rig.status}`);
    const items = rig.body?.items ?? [];
    check('with seasons in it', items.length > 0, `${items.length} seasons`);

    const unknown = items.filter((s) => s.access?.enforced === null);
    check('and every gate it could not read is reported as unknown',
      unknown.length === items.length,
      `${unknown.length} of ${items.length} seasons carry enforced=null; the others: ` +
        items.filter((s) => s.access?.enforced !== null)
          .map((s) => `${s.name}=${JSON.stringify(s.access?.enforced)}`).join(', '));

    const one = unknown[0];
    check('the gate status itself says unknown rather than inactive',
      (one?.access?.gates ?? []).every((g) => g.status === 'unknown'),
      JSON.stringify(one?.access?.gates));
    check('no $ARCA figure is invented for a gate nothing could read',
      one?.access?.required_arca === null, String(one?.access?.required_arca));
    check('and the note says unknown is not the same as off',
      /not known to be off/i.test(one?.access?.note ?? ''), one?.access?.note ?? '');

    // THE CONTROL, on the live service where arca IS reachable. Without this,
    // a build that reported `unknown` for everything always would pass here.
    const live = await json(`${LIVE_AGENT}/v1/seasons?page_size=50`);
    check('the live service, which can reach arca, reports a state that is not unknown',
      (live.body?.items ?? []).every((s) => s.access?.enforced !== null),
      (live.body?.items ?? []).filter((s) => s.access?.enforced === null).map((s) => s.name).join(', ') ||
        'live seasons carry enforced=null too, so this suite proves nothing about the outage');
  });

  await section('And the page draws that third state as its own thing', async () => {
    const next = join(WEB_DIR, 'node_modules/.bin/next');
    check('the web app has its own next binary', existsSync(next), `${next} does not exist`);
    const web = start(next, ['start', '-p', String(WEB_PORT)], {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        PORT: String(WEB_PORT),
        AGENT_API: `http://127.0.0.1:${AGENT_PORT}`,
      },
    });
    try {
      await waitFor(`http://127.0.0.1:${WEB_PORT}/seasons`, 'the rig web process');
    } catch (e) {
      check('the rig web process starts', false, `${e.message} — last output: ${web.tail.slice(-600)}`);
      throw e;
    }
    check('the rig web process starts', true);

    const p = await html(`http://127.0.0.1:${WEB_PORT}/seasons`);
    const t = text(p.html);
    check('the seasons page renders against the rig', p.status === 200, `status ${p.status}`);

    // THE CHECK THIS FILE EXISTS FOR.
    const tags = (t.match(/GATE UNKNOWN/gi) ?? []).length;
    const rigSeasons = (await json(`http://127.0.0.1:${AGENT_PORT}/v1/seasons?page_size=50`)).body?.items ?? [];
    check('every season whose gate could not be read is labelled unknown',
      tags === rigSeasons.length && tags > 0,
      `${tags} "GATE UNKNOWN" tag(s) for ${rigSeasons.length} season(s)`);
    // COUNTING RATHER THAN LOOKING FOR THE ABSENCE OF A WORD: the enforced=false
    // branch renders "OPEN" for a standard season and StatusTag renders "OPEN"
    // for a running one, so that word proves nothing either way. "NOT GUARDED"
    // is the premium half of the false branch and must be gone.
    check('and none of them is drawn as marked-but-unguarded',
      !/NOT GUARDED/i.test(t),
      'the page states a gate is wired and admitting everyone, which is the one thing nobody could establish');
    check('the reason is available rather than only the label',
      /could not be reached/i.test(p.html),
      'nothing on the page says why the gate is unknown');

    // AND THE SAME PAGE, LIVE, MUST NOT SAY IT. The rendering is only proven if
    // it is absent when the condition is absent.
    const livePage = await html(`${LIVE_WEB}/seasons`);
    check('the live page, where the gate IS readable, does not say unknown',
      !/GATE UNKNOWN/i.test(text(livePage.html)),
      'the live page marks the gate unknown too, so the label is not evidence of anything');
  });
} catch (e) {
  check('the run completed', false, String(e && e.message));
} finally {
  killAll();
}

const code = report();
if (code !== 0) process.exit(code);
console.log('gate-unknown-verify: the state nobody can see was built, and the page draws it as unknown.');
