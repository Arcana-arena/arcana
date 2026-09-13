/**
 * ARCANA decider verification.
 *
 * Four claims are made about the LLM decider. Each is proved here by making it
 * happen, against a real decision-engine process writing real rows.
 *
 *   1. The provider abstraction is real — a DIFFERENT provider is used without
 *      touching the Decision Engine. Only LLM_BASE_URL and LLM_API_KEY change.
 *   2. A model answer becomes a recorded decision WITH ITS EVIDENCE: the exact
 *      prompt, the raw response, the model, the version, the parameters, and a
 *      falsifiable thesis.
 *   3. A provider that does not answer produces a RECORDED HOLD with reason
 *      llm_unavailable — not a dropped tick, not a swallowed exception. The
 *      failure is real: a closed port, not a mocked error.
 *   4. Output the schema rejects produces a RECORDED HOLD with reason
 *      llm_invalid_output, and the raw answer is kept anyway, because a
 *      malformed answer is still evidence of what the model did.
 *
 * WHY A SECOND PROVIDER AND NOT A MOCK OF OUR OWN CLIENT. Mocking the client
 * would test the test. This starts an HTTP server that speaks the OpenAI
 * chat-completions shape — the same thing DeepSeek speaks — and points the
 * engine at it by configuration. If the abstraction were not real, this could
 * not work at all.
 *
 * It runs a SECOND decision-engine on its own port so the live one is never
 * reconfigured or restarted.
 *
 * Usage (on the VPS, from the repo root):
 *   node infra/verify/decider-verify.mjs
 */
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const REPO = process.env.REPO || '/home/ubuntu/arcana';
const ENGINE_PORT = Number(process.env.TEST_ENGINE_PORT || 8091);
const MOCK_PORT = Number(process.env.TEST_MOCK_PORT || 8092);
const DEAD_PORT = Number(process.env.TEST_DEAD_PORT || 8099); // nothing listens here
const GO = process.env.GO_BIN || '/usr/local/go/bin/go';

const env = Object.fromEntries(
  readFileSync(`${REPO}/.env.auth`, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const KEY = env.INTERNAL_API_KEY;
const DB = 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';

const sql = (q) =>
  execFileSync('docker', ['exec', 'arcana-postgres', 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc', q],
    { encoding: 'utf8' }).trim();

// A successful POST here is 201 Created, not 200. Asserting an exact status
// made a passing system look broken twice in this project already, so the
// helper exists to stop it happening a third time.
const ok2xx = (r) => r.status >= 200 && r.status < 300;

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name} — ${detail}`); console.log(`  FAIL  ${name} — ${detail}`); }
};

// --- the second provider ----------------------------------------------------
// Speaks the OpenAI chat-completions shape. `mode` decides what it answers.
let mockMode = 'good';
let lastPrompt = null;
let mockCalls = 0;
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (!req.url.endsWith('/v1/chat/completions')) { res.writeHead(404).end('{}'); return; }
    mockCalls++;
    if ((req.headers.authorization || '') !== 'Bearer verify-key') { res.writeHead(401).end('{"error":{"message":"bad key"}}'); return; }
    try { lastPrompt = JSON.parse(body).messages.map((m) => m.content).join('\n'); } catch {}

    let content;
    if (mockMode === 'garbage') {
      content = 'I think you should probably buy something. Hard to say which.';
    } else if (mockMode === 'unknown-symbol') {
      content = JSON.stringify({ action: 'buy', symbol: 'NOTREAL', size_pct: 0.2, rationale: 'invented', thesis: { claim: 'x', horizon_ticks: 3, invalidated_if: 'y' }, confidence: 0.5 });
    } else {
      // A decision derived from the prompt, so it is answering what it was
      // shown rather than replaying a fixture: buy whichever listed symbol fell
      // the most.
      const rows = [...(lastPrompt || '').matchAll(/^(\w+)\s+([\d.]+)\s+([+-][\d.]+)%/gm)]
        .map((m) => ({ sym: m[1], px: Number(m[2]), chg: Number(m[3]) }));
      const worst = rows.sort((a, b) => a.chg - b.chg)[0];
      content = JSON.stringify({
        action: worst ? 'buy' : 'hold',
        symbol: worst ? worst.sym : null,
        size_pct: 0.15,
        rationale: worst ? `${worst.sym} fell ${worst.chg}% this tick; adding on weakness.` : 'nothing to do',
        thesis: worst
          ? { claim: `${worst.sym} recovers at least half of this tick's move within 5 ticks`, horizon_ticks: 5, invalidated_if: `${worst.sym} falls a further 2% before then` }
          : null,
        confidence: 0.55,
      });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-verify', model: 'verify-model-v1.2',
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 812, completion_tokens: 96, prompt_cache_hit_tokens: 640 },
    }));
  });
});

// --- fixtures ---------------------------------------------------------------
const TAG = 'verify-llm-agent';
let agentId = null, seasonId = null, ref = null, creatorId = null, engineProc = null;

function cleanup() {
  try {
    if (agentId) {
      sql(`DELETE FROM decisions WHERE agent_id = '${agentId}'`);
      sql(`DELETE FROM portfolio_snapshots WHERE portfolio_id IN (SELECT id FROM portfolios WHERE agent_id='${agentId}')`);
      sql(`DELETE FROM portfolios WHERE agent_id = '${agentId}'`);
      sql(`DELETE FROM agents WHERE id = '${agentId}'`);
    }
    if (creatorId) sql(`DELETE FROM creators WHERE id = '${creatorId}'`);
    // Evidence bodies are content-addressed and not owned by any one decision,
    // so deleting the decisions leaves them behind. Collect the ones nothing
    // cites any more — otherwise every run of this suite grows the table.
    // A manifest and the system prompt are bodies too (0047), cited by
    // commitment and system_prompt_hash. Collecting only prompt and response
    // references would delete every live decision's manifest.
    sql(`DELETE FROM decision_evidence e WHERE NOT EXISTS (
           SELECT 1 FROM decisions d
            WHERE d.prompt_hash = e.hash OR d.response_hash = e.hash
               OR d.system_prompt_hash = e.hash OR d.commitment = e.hash)`);
  } catch (e) { console.log('  cleanup warning: ' + e.message); }
}

async function waitFor(url, ms = 25000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * THE ENGINE IS BUILT, NOT `go run` -- the lesson cost-budget-verify and
 * cost-meter-verify already wrote down.
 *
 * `go run` is a parent that compiles and then execs the server as a CHILD, so
 * a SIGKILL to the parent leaves the child holding the port. This suite starts
 * the engine several times with different environments; an orphan from any of
 * them would be found healthy by the next waitUp() and measured instead -- an
 * engine configured by a case that had already finished.
 */
const ENGINE_BIN = `/tmp/decider-verify-engine.${process.pid}`;

function buildEngine() {
  execFileSync(GO, ['build', '-o', ENGINE_BIN, './cmd/server'], {
    cwd: `${REPO}/services/decision-engine`, stdio: 'inherit',
  });
}

/**
 * A STRANGER ON THE PORT IS A FAILED RUN, NOT A PASSING ONE.
 */
async function assertEnginePortFree() {
  try { execFileSync('bash', ['-lc', `fuser -k ${ENGINE_PORT}/tcp 2>/dev/null || true`]); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  try {
    const r = await fetch(`http://127.0.0.1:${ENGINE_PORT}/healthz`);
    if (r.ok) {
      throw new Error(
        `something is already listening on ${ENGINE_PORT} and answering /healthz. This suite would ` +
        'have measured that process instead of the one it configures. Refusing to run.');
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('something is already listening')) throw e;
  }
}

function startEngine(extraEnv) {
  return spawn(ENGINE_BIN, [], {
    cwd: `${REPO}/services/decision-engine`,
    env: { ...process.env, DATABASE_URL: DB, PORT: String(ENGINE_PORT),
           MARKET_DATA_URL: 'http://127.0.0.1:8083', INTERNAL_API_KEY: KEY, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function stopEngine() {
  if (!engineProc) return;
  engineProc.kill('SIGKILL');
  try { execFileSync('bash', ['-lc', `fuser -k ${ENGINE_PORT}/tcp 2>/dev/null || true`]); } catch {}
  engineProc = null;
  await new Promise((r) => setTimeout(r, 1200));
}

async function executeTick() {
  const res = await fetch(`http://127.0.0.1:${ENGINE_PORT}/internal/v1/decisions/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Key': KEY, 'X-Arcana-Verification': '1' },
    body: JSON.stringify({ agent_id: agentId, season_id: seasonId, market_snapshot_ref: ref }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const lastDecision = () => {
  const r = sql(`SELECT COALESCE(action,'') || '|' || COALESCE(reason_code,'') || '|' || COALESCE(decider,'')
                 || '|' || COALESCE(provider,'') || '|' || COALESCE(model,'') || '|' || COALESCE(model_version,'')
                 || '|' || COALESCE(prompt_hash,'') || '|' || COALESCE(response_hash,'')
                 || '|' || COALESCE(thesis::text,'') || '|' || COALESCE(rationale,'')
                 FROM decisions WHERE agent_id='${agentId}' ORDER BY ts DESC, id DESC LIMIT 1`);
  const [action, reason, decider, provider, model, version, ph, rh, thesis, rationale] = r.split('|');
  return { action, reason, decider, provider, model, version, ph, rh, thesis, rationale };
};

try {
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  await assertEnginePortFree();
  buildEngine();
  console.log(`decider-verify: second provider listening on :${MOCK_PORT}\n`);

  // Fixtures: a creator, an LLM agent, a season, and the newest live snapshot.
  creatorId = randomUUID();
  agentId = randomUUID();
  seasonId = sql(`SELECT id FROM seasons ORDER BY start_at DESC LIMIT 1`);
  ref = sql(`SELECT ref FROM market_snapshots WHERE ingest_mode='live' ORDER BY tick_time DESC LIMIT 1`);
  sql(`INSERT INTO creators (id, handle, status) VALUES ('${creatorId}', '${TAG}-${creatorId.slice(0, 8)}', 'active')`);
  sql(`INSERT INTO agents (id, creator_id, name, version, strategy_type, risk_profile, asset_universe, status, mandate)
       VALUES ('${agentId}', '${creatorId}', '${TAG}', 1, 'llm',
               '{"max_position_pct":0.35,"trade_size_pct":0.2,"cash_floor_pct":0.05,"rebalance_band_pct":0.0001}'::jsonb,
               'us_equity', 'active', 'Buy weakness in large caps you already understand. Avoid trading on noise.')`);
  console.log(`  agent ${agentId}\n  season ${seasonId}\n  snapshot ${ref}\n`);

  // === 1. a working second provider ======================================
  console.log('=== 1. A DIFFERENT provider, selected by configuration alone ===');
  engineProc = startEngine({
    LLM_PROVIDER: 'verify-mock',
    LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    LLM_API_KEY: 'verify-key',
    LLM_MODEL: 'verify-model',
  });
  check('second decision-engine came up', await waitFor(`http://127.0.0.1:${ENGINE_PORT}/healthz`), 'never became healthy');

  mockMode = 'good';
  let r = await executeTick();
  check('tick executed against the second provider', ok2xx(r), `got ${r.status} ${JSON.stringify(r.body)}`);
  let d = lastDecision();
  check('the model actually decided (a trade, not a hold)', d.action === 'buy' || d.action === 'sell', `action=${d.action} reason=${d.reason} rationale=${d.rationale}`);
  check('decider recorded as llm', d.decider === 'llm', `got '${d.decider}'`);
  check('provider recorded as the one that answered', d.provider === 'verify-mock', `got '${d.provider}'`);
  check('model recorded', d.model === 'verify-model', `got '${d.model}'`);
  check('model VERSION recorded as served, not as requested', d.version === 'verify-model-v1.2', `got '${d.version}'`);
  check('prompt stored as evidence', /^[0-9a-f]{64}$/.test(d.ph), `hash='${d.ph}'`);
  check('raw response stored as evidence', /^[0-9a-f]{64}$/.test(d.rh), `hash='${d.rh}'`);

  const promptBody = d.ph ? sql(`SELECT body FROM decision_evidence WHERE hash='${d.ph}'`) : '';
  check('the stored prompt contains the prices the agent saw', /change since last tick/.test(promptBody) && /\d+\.\d+/.test(promptBody), 'prompt body missing market table');
  check("the stored prompt contains the owner's mandate, fenced", /begin owner instruction/.test(promptBody) && /Buy weakness in large caps/.test(promptBody), 'mandate not rendered or not fenced');

  let thesis = null;
  try { thesis = JSON.parse(d.thesis); } catch {}
  check('a thesis was recorded', thesis && typeof thesis.claim === 'string' && thesis.claim.length > 0, `thesis=${d.thesis}`);
  check('the thesis is FALSIFIABLE (states what would prove it wrong)',
    thesis && typeof thesis.invalidated_if === 'string' && thesis.invalidated_if.length > 0, `invalidated_if=${thesis?.invalidated_if}`);
  check('the thesis has a horizon to be judged over', thesis && Number(thesis.horizon_ticks) > 0, `horizon=${thesis?.horizon_ticks}`);

  // === 2. invalid output ==================================================
  console.log('\n=== 2. Output the schema rejects ===');
  mockMode = 'garbage';
  r = await executeTick();
  check('tick still succeeds (a rejected answer is not a failed tick)', ok2xx(r), `got ${r.status}`);
  d = lastDecision();
  check('recorded as a HOLD', d.action === 'hold', `action=${d.action}`);
  check('reason_code = llm_invalid_output', d.reason === 'llm_invalid_output', `got '${d.reason}'`);
  check('the malformed answer is kept as evidence anyway', /^[0-9a-f]{64}$/.test(d.rh), `hash='${d.rh}'`);

  console.log('\n=== 3. A symbol that is not in the snapshot ===');
  mockMode = 'unknown-symbol';
  r = await executeTick();
  d = lastDecision();
  check('invented symbol refused, recorded as a hold', d.action === 'hold' && d.reason === 'llm_invalid_output', `action=${d.action} reason=${d.reason}`);
  check('the refusal names the symbol it rejected', /NOTREAL/.test(d.rationale), `rationale='${d.rationale}'`);

  // === 4. a provider that does not answer ================================
  console.log('\n=== 4. A provider that does not answer (a really closed port) ===');
  await stopEngine();
  engineProc = startEngine({
    LLM_PROVIDER: 'verify-dead',
    LLM_BASE_URL: `http://127.0.0.1:${DEAD_PORT}`,
    LLM_API_KEY: 'verify-key',
    LLM_MODEL: 'verify-model',
    LLM_TIMEOUT_MS: '3000',
  });
  check('engine came up pointed at a dead provider', await waitFor(`http://127.0.0.1:${ENGINE_PORT}/healthz`), 'never became healthy');
  r = await executeTick();
  check('the tick still SUCCEEDS — the decision exists', ok2xx(r), `got ${r.status} ${JSON.stringify(r.body)}`);
  d = lastDecision();
  check('recorded as a HOLD, not a lost tick', d.action === 'hold', `action=${d.action}`);
  check('reason_code = llm_unavailable', d.reason === 'llm_unavailable', `got '${d.reason}'`);
  check('the failure itself is recorded, not swallowed', /^[0-9a-f]{64}$/.test(d.rh), `hash='${d.rh}'`);
  const errBody = d.rh ? sql(`SELECT body FROM decision_evidence WHERE hash='${d.rh}'`) : '';
  check('the recorded failure says what went wrong', /connection refused|unavailable/i.test(errBody), `body='${errBody.slice(0, 120)}'`);

  // === 5. no provider configured at all ==================================
  console.log('\n=== 5. No provider configured — must NOT fall back to a strategy ===');
  await stopEngine();
  engineProc = startEngine({ LLM_API_KEY: '' });
  check('engine came up with no LLM configured', await waitFor(`http://127.0.0.1:${ENGINE_PORT}/healthz`), 'never became healthy');
  r = await executeTick();
  d = lastDecision();
  check('LLM agent holds rather than silently trading as a deterministic one',
    d.action === 'hold' && d.reason === 'llm_unavailable', `action=${d.action} reason=${d.reason}`);
  check('and it is still recorded as an llm agent, not relabelled', d.decider === 'llm', `decider='${d.decider}'`);

  // === 6. nothing moved ===================================================
  //
  // The cheapest refusal there is: if no symbol moved beyond the agent's own
  // rebalance band, do not buy inference to be told to hold. Asserting the
  // provider was NOT called is the whole point — a version of this that still
  // called out and discarded the answer would look identical in the database.
  console.log('\n=== 6. Nothing moved beyond the rebalance band ===');
  await stopEngine();
  sql(`UPDATE agents SET risk_profile = jsonb_set(risk_profile, '{rebalance_band_pct}', '9.0')
       WHERE id = '${agentId}'`);
  engineProc = startEngine({
    LLM_PROVIDER: 'verify-mock',
    LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    LLM_API_KEY: 'verify-key',
    LLM_MODEL: 'verify-model',
  });
  check('engine came up', await waitFor(`http://127.0.0.1:${ENGINE_PORT}/healthz`), 'never became healthy');
  mockMode = 'good';
  const callsBefore = mockCalls;
  r = await executeTick();
  check('tick recorded', ok2xx(r), `got ${r.status}`);
  d = lastDecision();
  check('recorded as a hold with reason no_material_move',
    d.action === 'hold' && d.reason === 'no_material_move', `action=${d.action} reason=${d.reason}`);
  check('NO inference was purchased — the provider was never called',
    mockCalls === callsBefore, `provider was called ${mockCalls - callsBefore} time(s)`);
  check('and therefore no prompt was stored', d.ph === '', `prompt_hash='${d.ph}'`);
  const total = sql(`SELECT count(*) FROM decisions WHERE agent_id='${agentId}'`);
  console.log(`\n  ${total} decisions recorded across every branch — none dropped.`);
} finally {
  await stopEngine();
  mock.close();
  cleanup();
  try { execFileSync('rm', ['-f', ENGINE_BIN]); } catch {}
  console.log('decider-verify: fixtures removed');
}

console.log(`\n========================================`);
console.log(`  PASS: ${pass}   FAIL: ${fail}`);
console.log(`========================================`);
if (fail) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
