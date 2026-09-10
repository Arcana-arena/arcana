/**
 * ARCANA documentation verification — do the documents still describe the
 * system that exists?
 *
 * WHY THIS EXISTS, AND WHY IT IS A SUITE RATHER THAN A REVIEW
 *
 * Documentation drift in this project has never been cosmetic. Every instance
 * of it was, at the time, something an operator could have acted on:
 *
 *   - alerting.md's unit table named `arcana-arca-payout` after that unit was
 *     deleted, and omitted `arcana-chain-guard` and `arcana-signer` entirely.
 *     An operator auditing alerts against it would have found two components
 *     that alert on nothing and one that no longer exists.
 *   - auth.md's endpoint tables listed `POST /v1/arca/deposit-address` and two
 *     listener routes as live, weeks after they were removed, and did not list
 *     the claim route that replaced them. That is a security document
 *     describing an attack surface that is not the real one.
 *   - scheduling.md told an operator not to add a timer for a deposit audit
 *     that had already been deleted, describing an in-process interval that no
 *     longer ran.
 *   - arca-go-live.md was a written PROCEDURE for activating a payment model
 *     the project had abandoned, and every step would have reported success.
 *
 * All four were found by reading, one at a time, months apart. Reading does
 * not scale and does not repeat. So the parts of a document that make a
 * CHECKABLE CLAIM — a route exists, a unit exists, a constant has this value —
 * are checked here, against the running system, on every deploy.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not check prose, judgement, or
 * whether an explanation is still the best one. Those are what review is for.
 * It checks the claims that have a right answer and can be wrong silently.
 *
 * Read-only.
 *
 * Usage (on the VPS, from the repo root):
 *   node infra/verify/docs-verify.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const MKT = process.env.MARKETPLACE_URL || 'http://127.0.0.1:3002';
const ARCA = process.env.ARCA_URL || 'http://127.0.0.1:3004';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name} — ${detail}`); console.log(`  FAIL  ${name} — ${detail}`); }
}

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

/**
 * Split a document into lines, whichever line ending it happens to carry.
 *
 * This repository is edited on Windows and runs on Linux, so a document may
 * arrive with either. A checker that splits on one and silently produces a
 * single enormous "line" for the other would report every document as clean —
 * a check that cannot fail, which is the failure mode this whole suite exists
 * to prevent.
 */
const splitLines = (text) => text.split(/\r?\n/);

// ---------------------------------------------------------------------------
console.log('\n=== 1. auth.md lists the routes that exist, and only those ===');
// ---------------------------------------------------------------------------
//
// The route table is the drift that matters most, because auth.md is where
// somebody looks to answer "what is exposed, and to whom". Both directions are
// checked: a route named that is gone, and a route live that is unnamed.
{
  const authMd = read('docs/auth.md');
  check('docs/auth.md is present', authMd.length > 0);

  // Routes NestJS actually mapped, taken from each service's boot log. This is
  // evidence rather than a second hand-kept list — the same reason install.sh
  // derives its timer list from the files instead of restating it.
  function mappedRoutes(unit) {
    try {
      const log = execFileSync(
        'journalctl', ['-u', unit, '-n', '4000', '--no-pager', '-o', 'cat'],
        { encoding: 'utf8' },
      );
      // The last boot only: an earlier boot's routes are not this build's.
      const boots = log.split(/Starting Nest application|Nest application successfully started/);
      const recent = boots.slice(-3).join('\n');
      const out = new Set();
      for (const m of recent.matchAll(/Mapped \{([^,]+), (\w+)\} route/g)) {
        out.add(`${m[2]} ${m[1]}`);
      }
      return out;
    } catch {
      return null;
    }
  }

  const services = [
    ['arcana-agent.service', 'agent-service'],
    ['arcana-marketplace.service', 'marketplace'],
    ['arcana-arca.service', 'arca-service'],
  ];

  // Retired routes must appear NOWHERE as a live claim. A line that says
  // "RETIRED" or sits under a superseded banner is a record, not a claim, so
  // only lines that read as current count.
  const RETIRED = [
    'POST /v1/arca/deposit-address',
    'internal/v1/payments/listener/poll',
    'internal/v1/payments/listener/audit',
    'internal/v1/payments/payout/run',
    '/v1/marketplace/listings/:id/subscribe',
  ];
  for (const route of RETIRED) {
    const path = route.split(' ').pop();
    const lines = authMd.split('\n').filter((l) => l.includes(path));
    // A table row is a claim. A prose line that says why it went is history.
    const claims = lines.filter(
      (l) => l.trim().startsWith('|') && !/retired|removed|gone|was |used to|no longer/i.test(l),
    );
    check(`auth.md does not list the retired ${path} as live`,
      claims.length === 0, claims.join(' / ').slice(0, 120));
  }

  // And the other direction: every route a service maps under an
  // authenticated or internal prefix should be findable in auth.md. Public
  // reads are excluded — they are listed in bulk and enumerating them here
  // would produce noise rather than a finding.
  let unlisted = [];
  for (const [unit, label] of services) {
    const routes = mappedRoutes(unit);
    if (routes === null) { check(`${label} boot log is readable`, false, `journalctl -u ${unit} failed`); continue; }
    check(`${label} reported its route table at boot`, routes.size > 0, `${routes.size} routes`);
    for (const r of routes) {
      const path = r.split(' ')[1];
      if (!path.startsWith('/internal/')) continue;   // internal tier only
      if (path.includes('healthz')) continue;
      // Strip parameters: auth.md names them as :id, Nest logs them as :id too,
      // but the doc groups some with braces.
      const leaf = path.split('/').filter(Boolean).slice(-2).join('/');
      if (!authMd.includes(leaf) && !authMd.includes(path)) unlisted.push(`${label} ${r}`);
    }
  }
  check('every internal-tier route is named in auth.md',
    unlisted.length === 0, unlisted.join(', ').slice(0, 200));
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. scheduling.md and alerting.md match the installed units ===');
// ---------------------------------------------------------------------------
{
  const scheduling = read('docs/scheduling.md');
  const alerting = read('docs/alerting.md');
  const unitFiles = readdirSync('infra/systemd')
    .filter((f) => f.endsWith('.service') || f.endsWith('.timer'))
    .map((f) => f.replace(/\.(service|timer)$/, ''));
  const units = [...new Set(unitFiles)].filter((u) => u.startsWith('arcana-'));

  // Templated units (arcana-alert@) are named with the @ in the docs.
  const named = (doc, unit) => doc.includes(unit);

  const missingSched = units.filter((u) => !named(scheduling, u));
  check('scheduling.md names every unit in infra/systemd',
    missingSched.length === 0, missingSched.join(', '));

  // The reverse: a unit named in the docs that has no file. This is the
  // alerting.md failure — it named arcana-arca-payout after the file was gone.
  const docUnits = new Set(
    [...`${scheduling}\n${alerting}`.matchAll(/\b(arcana-[a-z0-9-]+)\.(service|timer)\b/g)].map((m) => m[1]),
  );
  const ghosts = [...docUnits].filter(
    (u) => !units.includes(u) && !u.startsWith('arcana-alert'),
  );
  // A ghost named on a line that says it was retired is history, not a claim.
  const liveGhosts = ghosts.filter((u) => {
    const lines = `${scheduling}\n${alerting}`.split('\n').filter((l) => l.includes(u));
    return !lines.every((l) => /retired|removed|deleted|gone|no longer|~~/i.test(l));
  });
  check('no document names a unit that does not exist',
    liveGhosts.length === 0, liveGhosts.join(', '));
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. Documented numbers equal the numbers in the code ===');
// ---------------------------------------------------------------------------
//
// A number in prose is the easiest thing in a document to leave behind, and
// the hardest to notice: `ARCA_CONFIRMATIONS` sat documented as 12 while the
// code that read it had been deleted.
{
  const cases = [
    {
      what: 'the mandate cap',
      code: /MandateMaxChars\s*=\s*(\d+)/,
      codeFile: 'services/decision-engine/internal/engine/decider_llm.go',
      docFile: 'docs/decision-engine-llm.md',
      docRe: /capped at (\d+)\s*\n?\s*characters|(\d+) characters/,
    },
    {
      what: 'the active-agent cap',
      code: /MAX_ACTIVE_AGENTS_PER_CREATOR\s*=\s*(\d+)/,
      codeFile: 'services/agent-service/src/agents/agents.service.ts',
      docFile: 'docs/agents.md',
      docRe: /(\d+)\s+active agents?/i,
    },
    {
      what: 'claim confirmations',
      code: /ARCA_CLAIM_MIN_CONFIRMATIONS'\)\s*\?\?\s*'(\d+)'/,
      codeFile: 'services/arca-service/src/payments/claims.service.ts',
      docFile: 'docs/marketplace-payments.md',
      docRe: /defaults to \*\*(\d+)/,
    },
  ];
  for (const c of cases) {
    const codeText = read(c.codeFile);
    const docText = read(c.docFile);
    if (!codeText) { check(`${c.what}: ${c.codeFile} exists`, false, 'missing'); continue; }
    if (!docText) { check(`${c.what}: ${c.docFile} exists`, false, 'missing — document it'); continue; }
    const inCode = c.code.exec(codeText)?.[1];
    const m = c.docRe.exec(docText);
    const inDoc = m ? (m[1] ?? m[2]) : undefined;
    check(`${c.what} agrees between code and ${c.docFile.split('/').pop()}`,
      inCode !== undefined && inCode === inDoc, `code=${inCode} doc=${inDoc}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. No document names a source file that is gone ===');
// ---------------------------------------------------------------------------
//
// The §10 retirement left five documents naming DepositAddressesService,
// HdWalletService and PaymentListenerService in the present tense. Naming a
// deleted class is fine as history; naming it as a live component is not.
{
  const docs = readdirSync('docs').filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`);
  docs.push('architecture.md', 'README.md');

  // Classes that existed and were removed. A document may still discuss them —
  // the history is valuable — but not on a line that reads as current.
  const GONE = [
    'DepositAddressesService', 'HdWalletService', 'PaymentListenerService',
    'PayoutBatchService',
  ];

  // TELLING HISTORY FROM A CLAIM NEEDS A MARKER, NOT A CLEVERER REGEX.
  //
  // The first version of this check guessed, by looking for words like
  // "retired" on the same line. It flagged data-resets.md three times — a
  // document that is ENTIRELY a historical record, where a table row reading
  // "**LIVE** — held" is a true statement about 2026-09-10 and a false one
  // about today. No regex resolves that, because the difference is not in the
  // text; it is in what the section is FOR.
  //
  // So a document says so, once, in a comment the renderer ignores:
  //
  //     <!-- docs-verify: historical -->
  //
  // Everything from that line to the next top-level heading is a record of
  // what was true then. Cheap to add, visible to the next person editing the
  // file, and — unlike a regex — it cannot quietly start matching things it
  // was never meant to.
  const HISTORICAL = '<!-- docs-verify: historical -->';
  const offenders = [];
  for (const doc of docs) {
    const text = read(doc);
    if (!text) continue;
    let historical = false;
    for (const line of splitLines(text)) {
      if (line.includes(HISTORICAL)) { historical = true; continue; }
      if (/^## /.test(line)) historical = false;   // a heading ends the section
      if (historical) continue;
      for (const cls of GONE) {
        if (!line.includes(cls)) continue;
        // Retirement language on the line itself still reads as history, for
        // the ordinary case of one sentence in an otherwise current document.
        if (/retired|removed|deleted|gone|no longer|was |used to|went|~~/i.test(line)) continue;
        if (line.trim().startsWith('>')) continue;
        offenders.push(`${doc}: ${line.trim().slice(0, 80)}`);
      }
    }
  }
  check('no document presents a deleted service as live',
    offenders.length === 0, offenders.slice(0, 3).join(' | '));
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. Documented endpoints answer ===');
// ---------------------------------------------------------------------------
//
// The strongest check available: take the URLs a document tells a reader to
// call and call them. A 404 means the document is wrong; anything else means
// the route is at least there.
{
  const probes = [
    ['GET /v1/agents/mandate-templates', `${AGENT}/v1/agents/mandate-templates`],
    ['GET /v1/marketplace/listings', `${MKT}/v1/marketplace/listings`],
    ['GET /v1/agents', `${AGENT}/v1/agents`],
  ];
  for (const [label, url] of probes) {
    let status = 0;
    try { status = (await fetch(url)).status; } catch { status = 0; }
    check(`${label} answers (documented as public)`, status === 200, `got ${status}`);
  }

  // And the retired ones must be gone. Documented as retired, so 404 is the
  // documented behaviour and this checks the document rather than the code.
  const retired = [
    ['POST /v1/arca/deposit-address', `${ARCA}/v1/arca/deposit-address`],
    ['POST /internal/v1/payments/listener/poll', `${ARCA}/internal/v1/payments/listener/poll`],
  ];
  for (const [label, url] of retired) {
    let status = 0;
    try {
      status = (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status;
    } catch { status = 0; }
    check(`${label} is gone, as documented`, status === 404, `got ${status}`);
  }
}

console.log('\n' + '='.repeat(40));
console.log(`  PASS: ${pass}   FAIL: ${fail}`);
console.log('='.repeat(40));
if (fail > 0) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  console.log('\nA document that describes a system that does not exist is worse than no');
  console.log('document: somebody will act on it. Fix the document, or fix the code.');
  process.exit(1);
}
console.log('docs-verify: the documents still describe the system that exists.');
