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

/**
 * Words that turn a mention into a RECORD rather than a CLAIM.
 *
 * ONE VOCABULARY, used by every check here. There were two — the unit check
 * and the deleted-service check each carried their own list — and they had
 * already drifted: "replaced" counted as history in one and not the other, so
 * the same sentence passed in one document and failed in another. A checker
 * that answers the same question two ways is a checker whose failures nobody
 * can predict, which is how one ends up switched off.
 *
 * Kept deliberately narrow. Every word here unambiguously means the thing
 * named is no longer current; adding one that merely tends to appear near a
 * retirement would quietly turn this into a check that passes everything.
 */
const HISTORY = /retired|removed|deleted|replaced|superseded|gone|no longer|was |used to|went|~~/i;

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
    return !lines.every((l) => HISTORY.test(l));
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
    // THE UNIT OF MEANING IS A PARAGRAPH, NOT A LINE.
    //
    // A per-line check was the wrong granularity, and it produced three false
    // findings against sentences that wrap:
    //
    //     Six files went: `HdWalletService`, `DepositAddressesService`,
    //     `PaymentListenerService`, and the three entities only they used
    //
    // "went" is on the first line and the class name is on the second. The
    // sentence says plainly that these are gone; only the line does not.
    //
    // So prose is read a paragraph at a time. This is not a loosening — it is
    // the correct scope, because prose is written in sentences and a sentence
    // does not stop meaning what it means at a line break. A TABLE ROW is
    // still checked on its own, because a row IS one claim and burying a bad
    // row among good ones must not launder it.
    const isRow = (l) => l.trim().startsWith('|');
    let paragraph = [];
    const units = [];
    const flush = () => { if (paragraph.length) { units.push(paragraph.join(' ')); paragraph = []; } };
    for (const line of splitLines(text)) {
      if (line.includes(HISTORICAL)) { flush(); historical = true; continue; }
      if (/^## /.test(line)) { flush(); historical = false; }
      if (historical) continue;
      if (line.trim() === '') { flush(); continue; }
      if (isRow(line)) { flush(); units.push(line); continue; }
      paragraph.push(line);
    }
    flush();

    for (const unit of units) {
      for (const cls of GONE) {
        if (!unit.includes(cls)) continue;
        if (HISTORY.test(unit)) continue;
        if (unit.trim().startsWith('>')) continue;   // a banner is a record
        offenders.push(`${doc}: ${unit.trim().slice(0, 90)}`);
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

// ---------------------------------------------------------------------------
// The dust floor: one number, three files, and the column it comes from.
//
// "What counts as holding something" is answered in Go, in TypeScript and in
// SQL, because two languages cannot share an import and a chart counts its
// positions in the query. Three copies of a number is three chances for it to
// drift, and the drift would be silent: each side would keep working and they
// would quietly stop agreeing about what an agent holds.
//
// The number is not arbitrary, which is what makes it checkable. It is the
// precision of decisions.quantity — numeric(20,8) — so this check re-derives it
// from the migration rather than trusting any of the three copies.
// ---------------------------------------------------------------------------
{
  console.log('\n=== The dust floor agrees with itself and with the column it comes from ===');

  // The whole engine package, because the two constants that have to agree are
  // declared in different files: OnChainQtyStep in chainpath.go carries the
  // literal, DustFloor in position.go points at it.
  const goDir = 'services/decision-engine/internal/engine';
  let goSrc = '';
  for (const f of readdirSync(goDir).filter((n) => n.endsWith('.go') && !n.endsWith('_test.go'))) {
    goSrc += read(`${goDir}/${f}`);
  }
  const tsSrc = read('services/agent-service/src/common/positions.ts');
  const seriesSrc = read('services/agent-service/src/series/series.service.ts');
  const doc = read('docs/positions.md');

  check('docs/positions.md exists', doc.length > 0, 'the definition has no document');

  // The column, from whichever migration declares it. Everything else is
  // compared against THIS, not against the other copies.
  const migrations = readdirSync('packages/db-migrations/migrations')
    .filter((f) => f.endsWith('.up.sql'))
    .map((f) => read(`packages/db-migrations/migrations/${f}`))
    .join('\n');
  const colMatch = /quantity\s+numeric\((\d+),\s*(\d+)\)/i.exec(migrations);
  check('decisions.quantity declares its precision in a migration', !!colMatch,
    'no `quantity numeric(p,s)` found; this check has nothing to derive from');

  if (colMatch) {
    const scale = Number(colMatch[2]);
    const expected = Number(`1e-${scale}`);
    check(`the column is numeric(${colMatch[1]},${scale}), so the floor is 1e-${scale}`,
      scale > 0, `scale ${scale}`);

    const goFloor = /OnChainQtyStep\s*=\s*1e-(\d+)/.exec(goSrc)
      || /DustFloor\s*=\s*1e-(\d+)/.exec(goSrc);
    const tsFloor = /DUST_FLOOR\s*=\s*1e-(\d+)/.exec(tsSrc);

    check('the engine derives its floor from that scale', !!goFloor && Number(goFloor[1]) === scale,
      goFloor ? `engine says 1e-${goFloor[1]}, column says 1e-${scale}` : 'no floor found in position.go');
    check('the agent service derives the same one', !!tsFloor && Number(tsFloor[1]) === scale,
      tsFloor ? `agent service says 1e-${tsFloor[1]}, column says 1e-${scale}` : 'no DUST_FLOOR found');
    check('and DustFloor is defined as OnChainQtyStep rather than retyped',
      /DustFloor\s*=\s*OnChainQtyStep/.test(goSrc),
      'two constants with the same origin should not be two literals');

    // The chart counts positions in SQL, where no constant can reach.
    const sqlFloors = [...seriesSrc.matchAll(/::float8\s*>=\s*1e-(\d+)/g)].map((m) => Number(m[1]));
    check('the series query counts positions rather than keys', sqlFloors.length > 0,
      'no dust floor in the holdings_count query; it is counting jsonb keys again');
    // `.every` on an empty array is true, so the length is part of the
    // assertion. Without it this check would pass by finding nothing, which is
    // the one result a guard must never treat as success.
    check('and the floor it uses is the same number',
      sqlFloors.length > 0 && sqlFloors.every((s) => s === scale),
      sqlFloors.length === 0 ? 'no floor found to compare' : `SQL uses 1e-${sqlFloors.join(', 1e-')}`);

    check('the document states the floor the code uses',
      doc.includes(`1e-${scale}`), `docs/positions.md does not mention 1e-${scale}`);
    check('and says which column it comes from',
      /numeric\(20,\s*8\)/.test(doc) && /decisions\.quantity/.test(doc),
      'the derivation is not written down, so the next person will read it as a chosen cutoff');
  }

  // The readers must go through the shared helpers. A `> 0` that creeps back in
  // is exactly how this bug happened the first time.
  const engineDir = 'services/decision-engine/internal/engine';
  let rawCompares = [];
  try {
    rawCompares = execFileSync('grep', ['-rn', 'qtyFromHoldings([^)]*)\\s*>\\s*0', engineDir],
      { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch { /* grep exits 1 when nothing matches, which is the passing case */ }
  check('no engine reader compares a raw holdings quantity against zero',
    rawCompares.length === 0, rawCompares.join(' | '));
}

// Shared with the identifier check below: reason codes of the form
// execution_<status> are built by concatenation and appear in no source file as
// a literal, so a check that greps for them would report every one as missing.
let emittedCodes = [];

// ---------------------------------------------------------------------------
// Reason codes: the table must describe the code, not an intention.
//
// docs/on-chain-direction.md listed ten decision reason codes and SIX of them
// existed nowhere in the system — price_implausible, balance_unreadable,
// policy_refused, insufficient_gas, tx_failed, tx_timeout. It was written as a
// design and read as an inventory, which is what arca-go-live.md did before it.
// The cost is somebody building on a brake that is not there.
//
// Same shape as the unit-list check: derive the truth from the source, compare,
// and fail on drift in either direction.
// ---------------------------------------------------------------------------
{
  console.log('\n=== Reason codes in the docs match the ones the code emits ===');

  const engineDir = 'services/decision-engine/internal/engine';
  let engineSrc = '';
  for (const f of readdirSync(engineDir).filter((n) => n.endsWith('.go') && !n.endsWith('_test.go'))) {
    engineSrc += read(`${engineDir}/${f}`);
  }
  const engineCodes = [...engineSrc.matchAll(/Reason[A-Za-z]+\s*=\s*"([a-z_]+)"/g)].map((m) => m[1]);

  // execution_<status> is built by concatenation rather than declared, so the
  // statuses are read from where they ARE declared instead of being guessed.
  const execSrc = read('services/decision-engine/internal/execution/broker.go');
  const execCodes = [...execSrc.matchAll(/Status[A-Za-z]+\s*=\s*"([a-z_]+)"/g)]
    .map((m) => `execution_${m[1]}`);

  const policySrc = read('services/signer/internal/policy/policy.go');
  const signerCodes = [...policySrc.matchAll(/Code[A-Za-z]+\s*=\s*"([a-z_]+)"/g)].map((m) => m[1]);

  emittedCodes = [...new Set([...engineCodes, ...execCodes, ...signerCodes])].filter((c) => c !== 'execution_');
  const emitted = emittedCodes;
  const doc = read('docs/on-chain-direction.md');

  check('the source actually yielded reason codes to compare against',
    emitted.length >= 15, `only found ${emitted.length}`);

  const undocumented = emitted.filter((c) => !doc.includes('`' + c + '`'));
  check('every reason code the system emits is documented',
    undocumented.length === 0, undocumented.join(', '));

  // The reverse, which is the failure that actually happened: a code named in
  // the table that nothing emits. A line describing history is exempt — saying
  // what used to exist is not a claim that it does.
  // SCOPED TO THE REASON-CODE SECTION, not the whole document.
  //
  // The first version scanned every snake_case identifier in backticks and
  // reported six field names from unrelated design sections. They are real doc
  // drift and worth fixing, but they are not reason codes, and a check that
  // mixes the two produces a failure nobody can act on — which is how a check
  // gets ignored. One question per check.
  const secStart = doc.indexOf('### Decision reason codes');
  const secEnd = doc.indexOf('\n## ', secStart < 0 ? 0 : secStart);
  const section = secStart < 0 ? '' : doc.slice(secStart, secEnd < 0 ? doc.length : secEnd);
  check('the reason-code section is where it is expected', section.length > 0,
    'the "### Decision reason codes" heading is gone; this check is scanning nothing');

  const known = new Set(emitted);
  const NOT_A_CLAIM = /never|not implemented|no equivalent|used to|previously/i;
  const docCodes = [...new Set([...section.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((m) => m[1]))];
  const ghosts = docCodes.filter((c) => {
    if (known.has(c)) return false;
    // Config keys, column names and env vars live in backticks too. Anything
    // that exists somewhere in the tree is one of those, not a ghost.
    try {
      execFileSync('grep', ['-rqI', c, 'services', 'infra', 'packages'], { encoding: 'utf8' });
      return false;
    } catch { /* grep exits 1 when it finds nothing, which is the interesting case */ }
    const lines = doc.split('\n').filter((l) => l.includes('`' + c + '`'));
    return !lines.every((l) => HISTORY.test(l) || NOT_A_CLAIM.test(l));
  });
  check('no document names a reason code that nothing emits',
    ghosts.length === 0, ghosts.join(', '));
}

// ---------------------------------------------------------------------------
// Identifiers a document presents as real, that exist nowhere in the code.
//
// A SECOND CHECK, NOT A WIDER FIRST ONE. The reason-code check above asks "does
// the table of reason codes match the codes the engine emits". This asks a
// different question: "does every field, column and flag a document names in
// backticks actually exist". They were one check briefly, and that check
// reported six field names from unrelated design sections alongside the reason
// codes — a failure nobody could act on, which is how a check gets ignored. One
// check, one question; two questions, two checks.
//
// WHAT IT CAUGHT. Six identifiers that had been read as an inventory for
// months: execution_score and decision_score (two scores that were never
// built — what exists is arcana_score and the executions table), model_id (the
// column is decisions.model), input_snapshot_ref (it is market_snapshot_ref),
// receipt_status and effective_price (the columns are executions.status and
// gas_price_wei). Every one of them would have been acted on by somebody.
// ---------------------------------------------------------------------------
{
  console.log('\n=== No document names a field, column or flag that does not exist ===');

  // Sample values, not identifiers the system must provide. Each is a name that
  // appears INSIDE an example — an agent called momentum_v1, a database called
  // arcana_e2e — and naming them here is cheaper than teaching the check to
  // recognise prose. The list is short on purpose: anything added to it should
  // be arguable in one sentence.
  const EXAMPLE_VALUES = new Set([
    'momentum_v1', 'momentum_bot', 'reversion_v1', 'dummy_agent_v2', // example agent names
    'algo_trader',                                                    // an example creator handle
    'barad_agent',                                                    // another tenant's process on this host
    'arcana_e2e',                                                     // the throwaway test database
  ]);

  // The names the DATABASE carries: agent names and creator handles. Read once.
  // If the database cannot be reached the set is empty and this check simply
  // goes back to being source-only — it never silently passes an identifier
  // because a lookup failed, it just stops being able to vouch for data names.
  let liveNames = new Set();
  try {
    const out = execFileSync('docker',
      ['exec', process.env.PG_CONTAINER || 'arcana-postgres', 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc',
        "SELECT name FROM agents UNION SELECT handle FROM creators"],
      { encoding: 'utf8' });
    liveNames = new Set(out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
  } catch {
    console.log('      NOTE  the database could not be read, so identifiers that exist only as ' +
      'rows cannot be vouched for on this run');
  }

  const docFiles = readdirSync('docs').filter((n) => n.endsWith('.md'));
  check('there are documents to check', docFiles.length > 5, `only ${docFiles.length} found`);

  const ghosts = [];
  for (const f of docFiles) {
    const body = read(`docs/${f}`);
    const ids = [...new Set([...body.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((m) => m[1]))];
    for (const id of ids) {
      if (EXAMPLE_VALUES.has(id)) continue;
      // Reason codes are vouched for by the check above, including the ones
      // built by concatenation that exist in no file as a literal.
      if (emittedCodes.includes(id)) continue;
      // Present in the tree at all: a column, a config key, an env var, a
      // constant. This check asks whether it EXISTS, not where.
      try {
        execFileSync('grep', ['-rqI', id, 'services', 'infra', 'packages'], { encoding: 'utf8' });
        continue;
      } catch { /* grep exits 1 on no match, which is the interesting case */ }
      // AND IN THE DATA, because some things this documentation names are rows,
      // not symbols. data-resets.md is about renaming an agent and a creator
      // handle; `onchain_live_v1` and `onchain_operator` are the names those
      // rows now carry, and they were reported as ghosts purely because this
      // check only ever looked in the source tree. A doc naming a live agent
      // was failing while the agent was on the leaderboard.
      //
      // This makes the check stricter, not laxer: an identifier that exists in
      // neither the code nor the database still fails, and now the failure
      // means something closer to what the message says.
      if (liveNames.has(id)) continue;
      // A line that RECORDS something rather than CLAIMING it is exempt, using
      // the same vocabulary every other check here uses.
      const lines = splitLines(body).filter((l) => l.includes('`' + id + '`'));
      if (lines.every((l) => HISTORY.test(l))) continue;
      ghosts.push(`${f}: ${id}`);
    }
  }

  check('no document names an identifier that exists nowhere in the code',
    ghosts.length === 0, ghosts.join(' | '));

  // THE CHECK MUST BE ABLE TO FAIL. Without this it would pass just as happily
  // if the regex stopped matching or the docs directory moved.
  // BUILT FROM PARTS, because this file lives under infra/ and the grep below
  // searches infra/. A literal probe name would be found in this very line and
  // the control would prove its own existence instead of the check working --
  // the same failure as the pgrep that matched its own command line.
  const probe = ['a', 'field', 'that', 'is', 'not', 'anywhere'].join('_');
  let probeFound = true;
  try { execFileSync('grep', ['-rqI', probe, 'services', 'infra', 'packages'], { encoding: 'utf8' }); }
  catch { probeFound = false; }
  check('and it would notice one: the probe name is absent from the tree', !probeFound,
    `${probe} exists somewhere, so this control proves nothing`);
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
