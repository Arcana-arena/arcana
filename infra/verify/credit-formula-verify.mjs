/**
 * credit-formula-verify.mjs — the Agent Credit formula as data, held to the Go
 * constants, and every stored row recomputed from its own figures.
 *
 * WHY THIS EXISTS. The ARCANA Score has been published as data since
 * score-formula.ts, and score-proof-verify recomputes it a second time. The
 * capital reputation (arcana-credit-formula/v1, architecture.md §18) had no such
 * surface: its arithmetic lived in Go and in prose, and a reader could not
 * recompute a `capital_reputation` row without reading code. GET
 * /v1/credit-formulas/:version publishes it; this suite is what keeps the
 * publication honest.
 *
 * THREE THINGS ARE PROVED, and the third is the one that matters:
 *
 *   1. the endpoint answers publicly, both route spellings agree, and an unknown
 *      version is refused rather than defaulted;
 *   2. the published constants are the ones in credit.go — parsed out of the Go
 *      source, not retyped here — and the weights sum to 100;
 *   3. every RATED `capital_reputation` row is recomputed from its OWN figures
 *      with those constants, a second implementation of the arithmetic, and the
 *      stored components and score must come out equal.
 *
 * Reads only. No session, no writes, nothing it could spend.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { req } from './lib/rate-aware.mjs';
import { suite } from './lib/sections.mjs';

const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const REPO = process.env.REPO || '/home/ubuntu/arcana';
const DB = process.env.DATABASE_URL || 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';
const { check, section, nothingToCheck, report } = suite('credit-formula-verify');

const sql = (q) => execFileSync('psql', [DB, '-At', '-q', '-c', q], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const VERSION = 'arcana-credit-formula/v1';
const get = (url) => req(url);

// ---------------------------------------------------------------- Go constants
//
// PARSED FROM THE GO SOURCE, not a copy kept here. If credit.go changes and the
// published constants do not, this fails — which is the whole point.
const go = readFileSync(`${REPO}/services/decision-engine/internal/credit/credit.go`, 'utf8');
const num = (name) => {
  const m = go.match(new RegExp(name + '\\s*=\\s*([0-9.]+)'));
  return m ? Number(m[1]) : null;
};
// `24 * time.Hour` and `30 * 24 * time.Hour` both parse: multiply the factors.
const hours = (name) => {
  const m = go.match(new RegExp(name + '\\s*=\\s*([0-9][0-9\\s*]*?)\\s*\\*\\s*time\\.Hour'));
  if (!m) return null;
  return m[1].split('*').map((s) => Number(s.trim())).filter((n) => n > 0).reduce((a, b) => a * b, 1);
};
const days = (name) => {
  const h = hours(name);
  return h === null ? null : h / 24;
};
const GO = {
  w_exposure: num('WeightExposure'),
  w_margin: num('WeightMargin'),
  w_self_sufficiency: num('WeightSelfSufficiency'),
  w_cycles_closed: num('WeightCyclesClosed'),
  exposure_full_usdg_days: num('ExposureFullUSDGDays'),
  deleverage_rate_zero: num('DeleverageRateZero'),
  cycles_closed_full: num('CyclesClosedFull'),
  floor: num('Floor'),
  qualifying_peak_usdg: num('QualifyingPeakUSDG'),
  qualifying_duration_hours: hours('QualifyingDuration'),
  min_history_days: days('MinHistory'),
  liquidation_hold_days: days('LiquidationHold'),
  stuck_hold_days: days('StuckHold'),
  stale_after_hours: hours('StaleAfter'),
};

// ---------------------------------------------------------------- the arithmetic
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const close = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-6;

/** The formula of arcana-credit-formula/v1, from a row's own figures. */
function recompute(C, fig) {
  const ef = clamp01(Math.log1p((fig.usdg_days ?? 0) / 100) / Math.log1p(C.exposure_full_usdg_days / 100));
  const share = fig.share_under_floor ?? 0;
  let depth = 1;
  const low = fig.lowest_health_factor_worst;
  if (low !== null && low !== undefined && low < C.floor) depth = clamp01((low - 1) / (C.floor - 1));
  const marginQuality = (1 - share) * depth;
  let ss = 0;
  if ((fig.debt_days ?? 0) > 0) {
    const rate = (fig.deleverage_steps ?? 0) / (fig.debt_days / 30);
    ss = clamp01(1 - rate / C.deleverage_rate_zero);
  }
  const exposure = C.w_exposure * ef;
  const margin = C.w_margin * marginQuality * ef;
  const self_sufficiency = C.w_self_sufficiency * ss * ef;
  const cycles_closed = C.w_cycles_closed * clamp01((fig.cycles_repaid ?? 0) / C.cycles_closed_full);
  return {
    exposure, margin, self_sufficiency, cycles_closed,
    score: Math.round(exposure + margin + self_sufficiency + cycles_closed),
    // the intermediates, so a golden vector can be checked one at a time
    evidence_fraction: ef, share_under_floor: share, margin_quality: marginQuality, self_sufficiency_quality: ss,
  };
}

let published = null;

// =====================================================================
await section('It answers publicly, both spellings agree, and charlatan versions are refused', async () => {
  const r = await get(`${AGENT}/v1/credit-formulas/${VERSION}`);
  check('GET /v1/credit-formulas/arcana-credit-formula/v1 is reachable without a session', r.status === 200,
    `status ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  if (r.status !== 200) return;
  published = r.body;

  check('it names the version it published', published?.version === VERSION, `version = ${JSON.stringify(published?.version)}`);
  check('it carries the constants', typeof published?.constants === 'object' && published.constants !== null,
    JSON.stringify(published?.constants).slice(0, 120));
  check('it carries steps', Array.isArray(published?.steps) && published.steps.length > 0, `${published?.steps?.length} steps`);
  check('it carries notes', Array.isArray(published?.notes) && published.notes.length > 0, `${published?.notes?.length} notes`);
  check('it says how to recompute a row', Array.isArray(published?.how_to_recompute) && published.how_to_recompute.length > 0,
    `${published?.how_to_recompute?.length}`);
  check('it carries the live tier table and ceiling', Array.isArray(published?.tiers) && typeof published?.ceiling_usdg === 'number',
    JSON.stringify({ tiers: published?.tiers?.length, ceiling_usdg: published?.ceiling_usdg }));

  // The URL-encoded single-parameter spelling must reach the same formula.
  const enc = await get(`${AGENT}/v1/credit-formulas/arcana-credit-formula%2Fv1`);
  check('the URL-encoded spelling (…%2Fv1) reaches the same formula',
    enc.status === 200 && enc.body?.version === VERSION,
    `status ${enc.status} version ${JSON.stringify(enc.body?.version)}`);

  const nope = await get(`${AGENT}/v1/credit-formulas/arcana-credit-formula/v99`);
  check('an unknown version is REFUSED, not defaulted', nope.status === 404,
    `status ${nope.status} — a silent fallback would tell a reader it checked a formula it did not`);
});

// =====================================================================
await section('The constants are the Go engine\'s, not a copy of them', async () => {
  if (!published?.constants) {
    nothingToCheck('the formula endpoint did not answer, so there is nothing to hold to credit.go');
    return;
  }
  const c = published.constants;
  for (const key of Object.keys(GO)) {
    if (GO[key] === null || GO[key] === undefined) {
      check(`credit.go declares ${key}`, false, 'not found in credit.go — the parse or the constant changed');
      continue;
    }
    check(`published ${key} is credit.go's ${GO[key]}`, close(c[key], GO[key]), `published ${c[key]}, credit.go ${GO[key]}`);
  }
  const sum = c.w_exposure + c.w_margin + c.w_self_sufficiency + c.w_cycles_closed;
  check('the four component weights sum to 100', close(sum, 100), `they sum to ${sum}`);
  console.log(`      credit.go constants: ${Object.entries(GO).map(([k, v]) => `${k}=${v}`).join(' ')}`);
});

// =====================================================================
await section('The tier table and ceiling are the allowlist\'s, read live', async () => {
  const lending = JSON.parse(readFileSync(`${REPO}/services/signer/allowlist/robinhood-mainnet.json`, 'utf8')).lending;
  const CEILING = Number(lending.limits.max_debt_per_agent_usdg);
  const CREDIT_ON = lending.credit?.enabled === true;
  const TIERS = (lending.credit?.tiers ?? []).map((t) => ({ tier: t.tier, min_score: t.min_score, max_debt_usdg: Number(t.max_debt_usdg), min_scored_days: t.min_scored_days ?? 0 }));

  if (!published?.tiers) {
    nothingToCheck('the formula endpoint did not answer, so there is no tier table to compare');
    return;
  }
  check('the published ceiling is the signer\'s per-agent cap', published.ceiling_usdg === CEILING,
    `published ${published.ceiling_usdg}, allowlist ${CEILING}`);
  check('whether the tier moves the limit is reported exactly as the allowlist sets it',
    published.enabled === CREDIT_ON, `published ${published.enabled}, allowlist ${CREDIT_ON}`);
  check('the published tier table is the allowlist\'s',
    JSON.stringify(published.tiers) === JSON.stringify(TIERS),
    `published ${JSON.stringify(published.tiers)} vs allowlist ${JSON.stringify(TIERS)}`);

  // And the same numbers a real agent is shown, so the formula and the capital
  // surface cannot disagree.
  const anyAgent = sql(`SELECT id FROM agents WHERE provenance = 'live' ORDER BY created_at LIMIT 1`);
  if (!anyAgent) {
    nothingToCheck('no live agent exists yet, so the capital surface cannot be compared');
    return;
  }
  const cap = await get(`${AGENT}/v1/agents/${anyAgent}/capital`);
  check('GET /v1/agents/:id/capital carries a credit block', cap.status === 200 && !!cap.body?.credit,
    `status ${cap.status} ${JSON.stringify(cap.body).slice(0, 120)}`);
  check('and shows the same ceiling', cap.body?.credit?.ceiling_usdg === CEILING, `${cap.body?.credit?.ceiling_usdg} vs ${CEILING}`);
  check('and the same tier table', JSON.stringify(cap.body?.credit?.tiers) === JSON.stringify(TIERS),
    JSON.stringify(cap.body?.credit?.tiers));
});

// =====================================================================
//
// THE SAME ARITHMETIC, AGAINST THE GO ENGINE'S OWN TEST VECTORS. Production has
// no rated row yet — a rating needs thirty days of history — and a recomputation
// that only ever runs against an empty set proves nothing. These vectors are the
// expected values ASSERTED IN credit_test.go, taken from the Go tests rather than
// invented here, so the published arithmetic is checked against the engine even
// before the first agent is rated.
await section('The recompute matches the Go engine\'s own test vectors', async () => {
  if (!published?.constants) {
    nothingToCheck('the formula endpoint did not answer, so there are no constants to recompute with');
    return;
  }
  const C = published.constants;

  // TestACleanRecordScoresByHowMuchWasAtStake (the large loan): full evidence,
  // full margin, no deleverage, one of twelve cycles closed.
  // want := int(math.Round(35 + 30 + 20 + 15.0/12))
  const large = recompute(C, { usdg_days: 25000, debt_days: 100, share_under_floor: 0, lowest_health_factor_worst: 3.0, deleverage_steps: 0, cycles_repaid: 1 });
  check('full evidence: exposure 35, margin 30, self-sufficiency 20',
    close(large.exposure, 35) && close(large.margin, 30) && close(large.self_sufficiency, 20), JSON.stringify(large));
  check('full evidence: one of twelve cycles closed is 15/12', close(large.cycles_closed, 15 / 12), `${large.cycles_closed}`);
  check('full evidence: the score is round(35+30+20+15/12) = 86', large.score === 86, `${large.score}`);

  // The same test's small loan: 3,000 USDG-days, so ln(31)/ln(251) of the evidence.
  const small = recompute(C, { usdg_days: 3000, debt_days: 30, share_under_floor: 0, lowest_health_factor_worst: 3.0, deleverage_steps: 0, cycles_repaid: 1 });
  check('3,000 USDG-days is ln(31)/ln(251) of the evidence',
    close(small.evidence_fraction, Math.log(31) / Math.log(251)),
    `${small.evidence_fraction} vs ${Math.log(31) / Math.log(251)}`);
  check('and the exposure follows it (35 × evidence)', close(small.exposure, (35 * Math.log(31)) / Math.log(251)), `${small.exposure}`);

  // TestTimeNearLiquidationCostsMargin: ten of a hundred days under the floor at
  // 1.25 gives share 0.1 and a margin quality of 0.9 × 0.5.
  const risky = recompute(C, { usdg_days: 25000, debt_days: 100, share_under_floor: 0.1, lowest_health_factor_worst: 1.25, deleverage_steps: 0, cycles_repaid: 1 });
  check('a tenth of the time under the floor is share 0.1', close(risky.share_under_floor, 0.1), `${risky.share_under_floor}`);
  check('a low of 1.25 is half way to liquidation, so the margin quality is 0.45', close(risky.margin_quality, 0.9 * 0.5), `${risky.margin_quality}`);

  // TestDeleverageStepsCostSelfSufficiency: four steps in sixty debt-days is two
  // per thirty, half marks.
  const helped = recompute(C, { usdg_days: 15000, debt_days: 60, share_under_floor: 0, lowest_health_factor_worst: 3.0, deleverage_steps: 4, cycles_repaid: 0 });
  check('four steps in sixty debt-days is a rate of two per thirty, quality 0.5',
    close(helped.self_sufficiency_quality, 0.5), `${helped.self_sufficiency_quality}`);

  // A null lowest health factor is the agent that never owed: the margin keeps
  // its full depth rather than reading an absent figure as a bad one.
  const noLow = recompute(C, { usdg_days: 25000, debt_days: 100, share_under_floor: 0, lowest_health_factor_worst: null, deleverage_steps: 0, cycles_repaid: 0 });
  check('a missing lowest health factor does not penalise the margin', close(noLow.margin_quality, 1),
    'an absent reading was read as a low one');
});

// =====================================================================
await section('Every rated row recomputes from its own figures', async () => {
  if (!published?.constants) {
    nothingToCheck('the formula endpoint did not answer, so there are no constants to recompute with');
    return;
  }
  const C = published.constants;
  // LIVE ROWS ONLY. A verification fixture writes a row directly, with figures
  // that need not satisfy the formula; recomputing one would report the fixture's
  // inconsistency as a fault in the published arithmetic.
  const rows = sql(`SELECT cr.agent_id || '|' || cr.score || '|' || cr.components::text || '|' || cr.inputs::text
                      FROM capital_reputation cr JOIN agents a ON a.id = cr.agent_id
                     WHERE cr.rated = true AND a.provenance = 'live'
                     ORDER BY cr.computed_at DESC LIMIT 200`)
    .split('\n').filter(Boolean).map((line) => {
      const [agent_id, score, components, inputs] = line.split('|');
      return { agent_id, score: Number(score), components: JSON.parse(components), inputs: JSON.parse(inputs) };
    });

  if (rows.length === 0) {
    nothingToCheck('no agent has a rated capital reputation yet — the recomputation has nothing real to check');
    return;
  }
  console.log(`      ${rows.length} rated row(s) to recompute`);

  let badComponents = 0;
  let badScore = 0;
  for (const row of rows) {
    const fig = row.inputs?.figures;
    if (!fig) { badComponents++; continue; }
    const want = recompute(C, fig);
    if (!(close(want.exposure, row.components.exposure) &&
          close(want.margin, row.components.margin) &&
          close(want.self_sufficiency, row.components.self_sufficiency) &&
          close(want.cycles_closed, row.components.cycles_closed))) {
      badComponents++;
      console.log(`      MISMATCH ${row.agent_id.slice(0, 8)}: stored ${JSON.stringify(row.components)} recomputed ${JSON.stringify(want)}`);
    }
    if (want.score !== row.score) {
      badScore++;
      console.log(`      SCORE ${row.agent_id.slice(0, 8)}: stored ${row.score}, recomputed ${want.score}`);
    }
  }
  check('every stored component equals the published arithmetic applied to the row\'s own figures',
    badComponents === 0, `${badComponents} of ${rows.length} disagree`);
  check('every stored score equals the rounded sum', badScore === 0, `${badScore} of ${rows.length} disagree`);

  // THE LIMITATION, STATED RATHER THAN HIDDEN. A row records its components and
  // the figures behind them, but not which formula version it was computed
  // under; the published constants are the ones in force now.
  const hasVersion = rows.some((r) => r.inputs && typeof r.inputs.formula === 'string');
  if (!hasVersion) {
    console.log('      NOTE  no capital_reputation row records a formula version; the constants ' +
      'published today are the ones in force now, and attributing an old row to the constants ' +
      'under which it was written is not yet recorded.');
  }
});

const code = report();
if (code !== 0) process.exit(code);
console.log('credit-formula-verify: the credit formula is published, held to credit.go, and every stored row recomputes.');
