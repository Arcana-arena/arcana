/**
 * private-agent-verify.mjs — PRIVATE AGENT. PUBLIC PROOF., proven by trying to break it.
 *
 * WHAT IS CLAIMED, and what would falsify each claim:
 *
 *   1. Every decision carries a commitment written WHEN IT IS RECORDED. Falsified
 *      by a decision without one, a manifest that does not hash to it, a manifest
 *      that describes a different row, or a chain that skips.
 *   2. The seal holds. Falsified by the database accepting an edit to a sealed
 *      decision, or a commitment added to a decision after the fact.
 *   3. Nothing private leaks. A private agent is created with a CANARY in every
 *      private field — mandate, a risk-profile key, model name, model version,
 *      thesis, rationale — and decided by a real decision engine against a second
 *      provider that echoes them. Every public endpoint and every public page is
 *      then searched for every canary. Any hit is a leak.
 *   4. The owner can read what the public cannot.
 *   5. Opening is permanent, recorded and checkable — and a tampered manifest is
 *      CAUGHT, so "verified" is shown to be able to say no.
 *   6. Visibility moves one way, enforced by the database rather than by the page.
 *   7. A public agent lost nothing.
 *
 * Nothing live is touched. The fixtures are marked `verification` and swept on
 * exit; the engine is a second process on its own port; the one statement that
 * needs a LIVE agent to prove a refusal runs inside a transaction that cannot
 * commit.
 *
 *   node infra/verify/private-agent-verify.mjs
 */
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { suite } from './lib/sections.mjs';
import { signIn, SIWE_DOMAIN, SIWE_URI, VERIFICATION_HEADER } from './lib/rate-aware.mjs';
import { sweepOnExit } from './lib/fixtures.mjs';

const REPO = process.env.REPO || '/home/ubuntu/arcana';
const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const MARKET = process.env.MARKETPLACE_URL || 'http://127.0.0.1:3002';
const WEB = process.env.WEB_URL || 'http://127.0.0.1:3000';
const ENGINE_PORT = Number(process.env.TEST_ENGINE_PORT || 8095);
const MOCK_PORT = Number(process.env.TEST_MOCK_PORT || 8096);
const GO = process.env.GO_BIN || '/usr/local/go/bin/go';
const DB = 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';
const ENGINE_BIN = `/tmp/private-agent-verify-engine.${process.pid}`;

const KEY = Object.fromEntries(
  readFileSync(`${REPO}/.env.auth`, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
).INTERNAL_API_KEY;

const { check, section, report } = suite('private-agent-verify');
sweepOnExit('private-agent-verify');

const psqlArgs = (q) => ['exec', 'arcana-postgres', 'psql', '-U', 'arcana', '-d', 'arcana', '-v', 'ON_ERROR_STOP=1', '-tAc', q];
const sql = (q) => execFileSync('docker', psqlArgs(q), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** Run a statement that is expected to be REFUSED. Returns the error text, or null if it succeeded. */
const refused = (q) => {
  try {
    sql(q);
    return null;
  } catch (e) {
    return String(e.stderr || e.message);
  }
};
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const RUN = randomUUID().replace(/-/g, '').slice(0, 10);
const CANARY = {
  mandate: `CANARYMANDATE${RUN}`,
  riskKey: `canary_rule_${RUN}`,
  model: `canary-model-${RUN}`,
  version: `canary-version-${RUN}`,
  thesis: `CANARYTHESIS${RUN}`,
  rationale: `CANARYRATIONALE${RUN}`,
};
const PUBLIC_MANDATE = `PUBLICMANDATE${RUN} buy weakness in large caps.`;

// --- the second provider ------------------------------------------------------
// Answers with every canary in the places a model's answer would carry them.
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (!req.url.endsWith('/v1/chat/completions')) { res.writeHead(404).end('{}'); return; }
    let prompt = '';
    try { prompt = JSON.parse(body).messages.map((m) => m.content).join('\n'); } catch {}
    const rows = [...prompt.matchAll(/^(\w+)\s+([\d.]+)\s+([+-][\d.]+)%/gm)].map((m) => ({ sym: m[1], chg: Number(m[3]) }));
    const pick = rows.sort((a, b) => a.chg - b.chg)[0];
    const content = JSON.stringify({
      action: pick ? 'buy' : 'hold',
      symbol: pick ? pick.sym : null,
      size_pct: 0.1,
      rationale: CANARY.rationale,
      thesis: { claim: CANARY.thesis, horizon_ticks: 5, invalidated_if: 'it falls a further 2%' },
      confidence: 0.5,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-private', model: CANARY.version,
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 500, completion_tokens: 80 },
    }));
  });
});

let engine = null;
function stopRig() {
  try { engine?.kill('SIGKILL'); } catch {}
  try { execFileSync('bash', ['-lc', `fuser -k ${ENGINE_PORT}/tcp 2>/dev/null || true`]); } catch {}
  try { mock.close(); } catch {}
  // Bodies are content-addressed and outlive the fixture decisions the sweep
  // removes. Collect every body nothing cites any more — manifests and system
  // prompts included (0047).
  try {
    sql(`DELETE FROM decision_evidence e WHERE NOT EXISTS (
           SELECT 1 FROM decisions d
            WHERE d.prompt_hash = e.hash OR d.response_hash = e.hash
               OR d.system_prompt_hash = e.hash OR d.commitment = e.hash)`);
  } catch {}
}
process.on('exit', stopRig);
process.on('SIGINT', () => { stopRig(); process.exit(130); });
// run-all stops a suite that outlives its timeout with SIGTERM, and a signal
// does not fire 'exit' — so without this the engine outlived every such run.
process.on('SIGTERM', () => { stopRig(); process.exit(143); });

// --- http ---------------------------------------------------------------------
let token = null;
const api = async (base, path, init = {}) => {
  const r = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(init.auth && token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, body, text };
};
const page = async (path) => {
  const r = await fetch(`${WEB}${path}`, { headers: { accept: 'text/html' } });
  return { status: r.status, html: await r.text() };
};
const leaks = (s) => Object.entries(CANARY).filter(([, v]) => s.includes(v)).map(([k]) => k);

const waitFor = async (url, ms = 30000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};

let privateId = null, publicId = null, creatorId = null, seasonId = null, ref = null, listingId = null;
const tick = async (agentId) => {
  const r = await fetch(`http://127.0.0.1:${ENGINE_PORT}/internal/v1/decisions/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Key': KEY, ...VERIFICATION_HEADER },
    body: JSON.stringify({ agent_id: agentId, season_id: seasonId, market_snapshot_ref: ref }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const decisionRow = (id) => {
  const out = sql(`SELECT json_build_object(
      'id', id, 'agent_id', agent_id, 'commitment', trim(commitment), 'scheme', commitment_scheme,
      'prompt_hash', trim(prompt_hash), 'response_hash', trim(response_hash),
      'system_prompt_hash', trim(system_prompt_hash), 'model', model, 'model_version', model_version,
      'rationale', rationale, 'thesis', thesis,
      'ts', to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    FROM decisions WHERE id = ${Number(id)}`);
  return out ? JSON.parse(out) : null;
};
const body = (hash) => (hash ? sql(`SELECT body FROM decision_evidence WHERE hash = '${hash}'`) : '');
/** psql -tA prints a body with its trailing newline stripped; a manifest always ends in one. */
const manifestOf = (hash) => {
  const b = body(hash);
  return b ? `${b}\n` : '';
};
const manifestFields = (m) =>
  Object.fromEntries(m.trimEnd().split('\n').slice(1).map((l) => [l.slice(0, l.indexOf(': ')), JSON.parse(l.slice(l.indexOf(': ') + 2))]));

const decisions = { private: [], public: [] };

try {
  // ============================================================== the rig
  await section('The rig: a real engine, a provider that echoes canaries, marked fixtures', async () => {
    await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
    try { execFileSync('bash', ['-lc', `fuser -k ${ENGINE_PORT}/tcp 2>/dev/null || true`]); } catch {}
    execFileSync(GO, ['build', '-o', ENGINE_BIN, './cmd/server'], { cwd: `${REPO}/services/decision-engine`, stdio: 'inherit' });
    engine = spawn(ENGINE_BIN, [], {
      cwd: `${REPO}/services/decision-engine`,
      env: {
        ...process.env, DATABASE_URL: DB, PORT: String(ENGINE_PORT), MARKET_DATA_URL: 'http://127.0.0.1:8083',
        INTERNAL_API_KEY: KEY, LLM_PROVIDER: 'verify-mock', LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
        LLM_API_KEY: 'verify-key', LLM_MODEL: CANARY.model,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    check('a second decision engine came up', await waitFor(`http://127.0.0.1:${ENGINE_PORT}/healthz`), 'never healthy');

    const owner = privateKeyToAccount(generatePrivateKey());
    const s = await signIn(AGENT, owner, { chainId: 4663, domain: SIWE_DOMAIN, uri: SIWE_URI });
    check('a fresh wallet signs in', s.status === 200 && !!s.body?.access_token, `status ${s.status}`);
    token = s.body.access_token;

    const c = await api(AGENT, '/v1/creators', {
      method: 'POST', auth: true, headers: VERIFICATION_HEADER, body: { handle: `verify_priv_${RUN}` },
    });
    check('a fixture creator was created', c.status < 300, JSON.stringify(c.body));
    creatorId = c.body.id;

    const risk = { max_position_pct: 0.35, trade_size_pct: 0.2, cash_floor_pct: 0.05, rebalance_band_pct: 0.0001, [CANARY.riskKey]: 1 };
    const made = await api(AGENT, '/v1/agents', {
      method: 'POST', auth: true, headers: VERIFICATION_HEADER,
      body: { name: `verify_priv_${RUN}`, strategyType: 'llm', assetUniverse: 'us_equities', mandate: CANARY.mandate,
              riskProfile: JSON.stringify(risk), visibility: 'private' },
    });
    check('a PRIVATE agent was created', made.status < 300, JSON.stringify(made.body));
    privateId = made.body.id;
    const pub = await api(AGENT, '/v1/agents', {
      method: 'POST', auth: true, headers: VERIFICATION_HEADER,
      body: { name: `verify_pub_${RUN}`, strategyType: 'llm', assetUniverse: 'us_equities', mandate: PUBLIC_MANDATE,
              riskProfile: JSON.stringify({ ...risk, [CANARY.riskKey]: undefined }) },
    });
    check('a PUBLIC agent was created', pub.status < 300, JSON.stringify(pub.body));
    publicId = pub.body.id;

    check('the private one is recorded private', sql(`SELECT visibility FROM agents WHERE id='${privateId}'`) === 'private');
    check('the public one defaulted to public', sql(`SELECT visibility FROM agents WHERE id='${publicId}'`) === 'public');
    check('both are marked as verification fixtures',
      sql(`SELECT count(*) FROM agents WHERE id IN ('${privateId}','${publicId}') AND provenance='verification'`) === '2');

    // Activation proper takes a slot and an entitlement; neither is what this
    // suite measures, and the fixtures are swept by their mark.
    sql(`UPDATE agents SET status='active' WHERE id IN ('${privateId}','${publicId}')`);
    seasonId = sql(`SELECT id FROM seasons ORDER BY start_at DESC LIMIT 1`);
    ref = sql(`SELECT ref FROM market_snapshots WHERE ingest_mode='live' ORDER BY tick_time DESC LIMIT 1`);
    check('there is a live snapshot to decide on', !!ref, 'no live snapshot');
  });

  // ================================================== 1. commitment at record time
  await section('Every decision is sealed with a commitment when it is recorded', async () => {
    for (const [who, id, n] of [['private', privateId, 2], ['public', publicId, 1]]) {
      for (let i = 0; i < n; i++) {
        const t = await tick(id);
        check(`${who} tick ${i + 1} executed`, t.status >= 200 && t.status < 300, `${t.status} ${JSON.stringify(t.body)}`);
        const did = t.body?.decision_id ?? Number(sql(`SELECT id FROM decisions WHERE agent_id='${id}' ORDER BY id DESC LIMIT 1`));
        decisions[who].push(did);
      }
    }

    const [p1, p2] = decisions.private.map(decisionRow);
    check('the provider was really asked, so the canaries are really in the record',
      p1?.model === CANARY.model && p1?.model_version === CANARY.version && (p1?.rationale ?? '').includes(CANARY.rationale),
      JSON.stringify({ model: p1?.model, version: p1?.model_version }));

    for (const [label, d] of [['first', p1], ['second', p2]]) {
      check(`the ${label} decision carries a commitment`, /^[0-9a-f]{64}$/.test(d?.commitment ?? ''), String(d?.commitment));
      check(`and names its scheme`, d?.scheme === 'arcana-commitment/v1', String(d?.scheme));
      const m = manifestOf(d?.commitment);
      check(`the ${label} manifest is stored and hashes to the commitment`, !!m && sha256(m) === d.commitment,
        m ? `sha256 ${sha256(m)}` : 'manifest body missing');
      if (!m) continue;
      const f = manifestFields(m);
      check(`the ${label} manifest describes this row`,
        f.agent_id === privateId && f.ts === d.ts && f.prompt_sha256 === d.prompt_hash &&
          f.response_sha256 === d.response_hash && f.system_prompt_sha256 === d.system_prompt_hash &&
          f.model_version === d.model_version,
        JSON.stringify({ f_ts: f.ts, ts: d.ts }));
      for (const k of ['prompt_sha256', 'response_sha256', 'system_prompt_sha256']) {
        // HASHED IN THE DATABASE, byte for byte. Printing a body through psql
        // can trim its edges, and a check that fails on whitespace it introduced
        // itself would be measuring the tool.
        const same = f[k]
          ? sql(`SELECT encode(sha256(convert_to(body, 'UTF8')), 'hex') = '${f[k]}' FROM decision_evidence WHERE hash = '${f[k]}'`)
          : '';
        check(`the ${label} ${k.replace('_sha256', '')} body hashes to its name`, same === 't', `${k}=${f[k]} → ${same || 'no body'}`);
      }
      check(`the ${label} manifest carries 32 bytes of salt`, /^[0-9a-f]{64}$/.test(f.salt ?? ''));
      if (label === 'first') check('the first decision starts the chain', f.previous_commitment === null, String(f.previous_commitment));
      else check('the second decision names the first commitment', f.previous_commitment === p1.commitment, String(f.previous_commitment));
    }
  });

  // ============================================================== 2. the seal
  await section('The database refuses to unseal a decision, or seal one afterwards', async () => {
    const sealed = decisions.public[0];
    const e1 = refused(`UPDATE decisions SET rationale = 'rewritten after the price moved' WHERE id = ${sealed}`);
    check('an edit to a sealed decision is refused', !!e1 && /sealed/i.test(e1), e1 ?? 'the UPDATE succeeded');
    const e1b = refused(`UPDATE decisions SET commitment = repeat('0', 64) WHERE id = ${sealed}`);
    check('replacing a commitment is refused', !!e1b && /sealed/i.test(e1b), e1b ?? 'the UPDATE succeeded');

    const probe = sql(`INSERT INTO decisions (agent_id, season_id, ts, market_snapshot_ref, action, symbol, resulting_allocation, rationale)
                       SELECT agent_id, season_id, ts + interval '1 second', market_snapshot_ref, 'hold', '', resulting_allocation, 'unsealed probe'
                         FROM decisions WHERE id = ${sealed} RETURNING id`).split('\n')[0];
    const e2 = refused(`UPDATE decisions SET commitment = repeat('a', 64) WHERE id = ${probe}`);
    check('adding a commitment to a decision after it was recorded is refused', !!e2 && /never added afterwards/i.test(e2),
      e2 ?? 'the UPDATE succeeded');
    sql(`DELETE FROM decisions WHERE id = ${probe}`);
  });

  // ============================================================== 3. no leaks
  const d1 = decisions.private[0], d2 = decisions.private[1];
  listingId = sql(`INSERT INTO marketplace_listings (agent_id, access_type, price_usd, arca_gate_amount, active)
                   VALUES ('${privateId}', 'subscription', 10, 10, false) RETURNING id`).split('\n')[0];

  const PUBLIC_JSON = () => [
    ['agent list', AGENT, `/v1/agents?provenance=verification&page_size=100`],
    ['agent', AGENT, `/v1/agents/${privateId}`],
    ['overview', AGENT, `/v1/agents/${privateId}/overview`],
    ['positions', AGENT, `/v1/agents/${privateId}/positions`],
    ['decisions', AGENT, `/v1/agents/${privateId}/decisions?page_size=50`],
    ['evidence (first)', AGENT, `/v1/agents/${privateId}/decisions/${d1}/evidence`],
    ['evidence (second)', AGENT, `/v1/agents/${privateId}/decisions/${d2}/evidence`],
    ['passport', AGENT, `/v1/agents/${privateId}/passport`],
    ['dna', AGENT, `/v1/agents/${privateId}/dna`],
    ['autopsy', AGENT, `/v1/agents/${privateId}/autopsy`],
    ['evolution', AGENT, `/v1/agents/${privateId}/evolution`],
    ['disclosures', AGENT, `/v1/agents/${privateId}/disclosures`],
    ['creator agents', AGENT, `/v1/creators/${creatorId}/agents`],
    ['recent decisions', AGENT, `/v1/decisions/recent?limit=50`],
    ['status', AGENT, `/v1/status`],
    ['leaderboard', AGENT, `/v1/leaderboard?include_unranked=true&page_size=100`],
    ['listing detail', MARKET, `/v1/marketplace/listings/${listingId}/detail`],
  ];
  const PUBLIC_PAGES = () => [
    `/agents/${privateId}`, `/agents/${privateId}?tab=decisions&open=${d2}`, `/agents/${privateId}?tab=positions`,
    `/agents/${privateId}?tab=dna`, `/agents/${privateId}?tab=autopsy`, `/agents/${privateId}?tab=evolution`,
    `/agents/${privateId}?tab=passport`, '/agents', `/marketplace/${listingId}`, '/status',
  ];

  await section('No public endpoint or page prints anything a private agent keeps', async () => {
    for (const [name, base, path] of PUBLIC_JSON()) {
      const r = await api(base, path);
      const hit = leaks(r.text);
      check(`${name} leaks nothing`, hit.length === 0, `status ${r.status}, printed: ${hit.join(', ')}`);
    }
    for (const path of PUBLIC_PAGES()) {
      const p = await page(path);
      const hit = leaks(p.html);
      check(`page ${path} leaks nothing`, hit.length === 0, `status ${p.status}, printed: ${hit.join(', ')}`);
    }

    const a = await api(AGENT, `/v1/agents/${privateId}`);
    check('the agent says it is private rather than leaving nulls to be read',
      a.body?.intelligence?.private === true && a.body?.mandate === null, JSON.stringify(a.body?.intelligence));
    const list = await api(AGENT, `/v1/agents/${privateId}/decisions?page_size=50`);
    const rows = list.body?.decisions ?? [];
    check('every decision row carries its commitment', rows.length >= 2 && rows.every((r) => /^[0-9a-f]{64}$/.test(r.commitment ?? '')),
      JSON.stringify(rows.map((r) => r.commitment)));
    check('and is marked withheld', rows.every((r) => r.intelligence === 'withheld'));
    check('while what it DID stays public — action, symbol, quantity, who decided',
      rows.some((r) => r.action === 'buy' && r.symbol && r.quantity !== null && r.decided_by));
    const ev = await api(AGENT, `/v1/agents/${privateId}/decisions/${d1}/evidence`);
    check('the evidence endpoint returns the commitment with its one-sentence explanation',
      ev.body?.commitment?.value && /no longer match/.test(ev.body?.commitment?.explained ?? ''), JSON.stringify(ev.body?.commitment));
    check('and withholds the bodies rather than returning empty ones', ev.body?.prompt === null && ev.body?.intelligence?.opened === false);
    const detail = await api(MARKET, `/v1/marketplace/listings/${listingId}/detail`);
    check('the listing detail says the intelligence is private, and that buying does not unlock it',
      detail.body?.visibility === 'private' && /does not include/.test(detail.body?.intelligence_note ?? ''),
      JSON.stringify({ v: detail.body?.visibility }));
    const overview = await page(`/agents/${privateId}`);
    check('the public page labels the agent private rather than showing a gap', /PRIVATE AGENT/.test(overview.html) && /Mandate · private/.test(overview.html));
  });

  // ============================================================== 4. owner
  await section('The owner can read what the public cannot', async () => {
    const mine = await api(AGENT, `/v1/agents/${privateId}/intelligence`, { auth: true });
    check('the owner reads the mandate', mine.status === 200 && mine.body?.mandate === CANARY.mandate, `status ${mine.status}`);
    check('and the risk rules', mine.body?.risk_profile && CANARY.riskKey in mine.body.risk_profile);
    const anon = await api(AGENT, `/v1/agents/${privateId}/intelligence`);
    check('nobody else does', anon.status === 401 || anon.status === 403, `status ${anon.status}`);
  });

  // ============================================================== 5. opening
  await section('Opening one decision is permanent, recorded, and checkable — and tampering is caught', async () => {
    const r = await api(AGENT, `/v1/agents/${privateId}/decisions/${d1}/reveal`, { method: 'POST', auth: true });
    check('the owner opens one decision', r.status === 200 && r.body?.commitment, `status ${r.status} ${JSON.stringify(r.body)}`);
    const again = await api(AGENT, `/v1/agents/${privateId}/decisions/${d1}/reveal`, { method: 'POST', auth: true });
    check('opening it twice keeps the first record', again.body?.disclosure_id === r.body?.disclosure_id);

    const rec = await api(AGENT, `/v1/agents/${privateId}/disclosures`);
    const item = (rec.body?.items ?? []).find((x) => x.decision_id === d1);
    check('the opening is on the public record: what, when, and by whom',
      item && item.scope === 'decision' && item.commitment === r.body.commitment && /^0x/.test(item.disclosed_by_wallet ?? ''),
      JSON.stringify(item));

    const ev = await api(AGENT, `/v1/agents/${privateId}/decisions/${d1}/evidence`);
    check('the opened decision now shows its prompt', (ev.body?.prompt?.body ?? '').includes(CANARY.mandate));
    check('and the platform verifies it against the commitment',
      ev.body?.verification?.status === 'verified' && ev.body.verification.checks.every((c) => c.ok),
      JSON.stringify(ev.body?.verification?.checks?.filter((c) => !c.ok)));
    const other = await api(AGENT, `/v1/agents/${privateId}/decisions/${d2}/evidence`);
    check('the decision that was NOT opened stays withheld', leaks(other.text).length === 0 && other.body?.prompt === null);

    const e = refused(`UPDATE intelligence_disclosures SET disclosed_at = now() - interval '1 year' WHERE id = ${r.body.disclosure_id}`);
    check('a disclosure record cannot be edited', !!e && /permanent record/.test(e), e ?? 'the UPDATE succeeded');

    // A LIVE agent's disclosure cannot be deleted. Proven inside one statement
    // that fails as a whole, so the live agent it creates never commits.
    const e2 = refused(`
      WITH a AS (INSERT INTO agents (creator_id, name, version, risk_profile, asset_universe, status)
                 VALUES ('${creatorId}', 'verify_rollback_${RUN}', 1, '{}'::jsonb, 'us_equities', 'draft') RETURNING id),
           d AS (INSERT INTO intelligence_disclosures (agent_id, scope, disclosed_by_wallet, creator_id)
                 SELECT id, 'agent', '0x0', '${creatorId}' FROM a RETURNING id)
      SELECT 1;
      DELETE FROM intelligence_disclosures WHERE agent_id IN (SELECT id FROM agents WHERE name = 'verify_rollback_${RUN}');`);
    check('a real agent\'s disclosure cannot be deleted', !!e2 && /cannot be deleted/.test(e2), e2 ?? 'the DELETE succeeded');
    sql(`DELETE FROM agents WHERE name = 'verify_rollback_${RUN}' AND NOT EXISTS (SELECT 1 FROM intelligence_disclosures d WHERE d.agent_id = agents.id)`);

    // TAMPERING IS CAUGHT: a verifier that can only ever say "verified" proves nothing.
    const m = manifestOf(r.body.commitment);
    const tag = `$m${RUN}$`;
    sql(`UPDATE decision_evidence SET body = ${tag}${m.replace('"buy"', '"sell"')}${tag} WHERE hash = '${r.body.commitment}'`);
    const tampered = await api(AGENT, `/v1/agents/${privateId}/decisions/${d1}/evidence`);
    check('an altered manifest is reported as a mismatch', tampered.body?.verification?.status === 'mismatch',
      String(tampered.body?.verification?.status));
    sql(`UPDATE decision_evidence SET body = ${tag}${m}${tag} WHERE hash = '${r.body.commitment}'`);
    const restored = await api(AGENT, `/v1/agents/${privateId}/decisions/${d1}/evidence`);
    check('and verifies again once restored', restored.body?.verification?.status === 'verified');
  });

  // ============================================================== 6. one way
  await section('Visibility moves one way, and the database is what says so', async () => {
    const e1 = refused(`UPDATE agents SET visibility = 'private' WHERE id = '${publicId}'`);
    check('public cannot become private', !!e1 && /cannot become private/.test(e1), e1 ?? 'the UPDATE succeeded');
    const e2 = refused(`UPDATE agents SET visibility = 'public' WHERE id = '${privateId}'`);
    check('private cannot become public without a recorded disclosure', !!e2 && /disclosure record/.test(e2), e2 ?? 'the UPDATE succeeded');
    const e3 = refused(`INSERT INTO agents (creator_id, name, version, parent_agent_id, risk_profile, asset_universe, status, visibility, provenance)
                        VALUES ('${creatorId}', 'verify_child_${RUN}', 2, '${privateId}', '{}'::jsonb, 'us_equities', 'draft', 'public', 'verification')`);
    check('a version of a private agent cannot start public', !!e3 && /starts private/.test(e3), e3 ?? 'the INSERT succeeded');

    const noConfirm = await api(AGENT, `/v1/agents/${privateId}/disclose`, { method: 'POST', auth: true, body: { confirm: false } });
    check('making it public without confirming is refused', noConfirm.status === 400, `status ${noConfirm.status}`);
    const done = await api(AGENT, `/v1/agents/${privateId}/disclose`, { method: 'POST', auth: true, body: { confirm: true } });
    check('with confirmation the owner makes it public', done.status === 200, `status ${done.status} ${JSON.stringify(done.body)}`);
    const a = await api(AGENT, `/v1/agents/${privateId}`);
    check('its mandate is readable now', a.body?.mandate === CANARY.mandate && a.body?.intelligence?.disclosed_at);
    const ev2 = await api(AGENT, `/v1/agents/${privateId}/decisions/${d2}/evidence`);
    check('including the evidence behind decisions made while it was private, verified',
      ev2.body?.verification?.status === 'verified' && (ev2.body?.prompt?.body ?? '').includes(CANARY.mandate));
    const e4 = refused(`UPDATE agents SET visibility = 'private' WHERE id = '${privateId}'`);
    check('and it can never go back', !!e4 && /cannot become private/.test(e4), e4 ?? 'the UPDATE succeeded');
  });

  // ============================================================== 7. public agents
  await section('A public agent lost nothing', async () => {
    const a = await api(AGENT, `/v1/agents/${publicId}`);
    check('its mandate is still public', a.body?.mandate === PUBLIC_MANDATE, String(a.body?.mandate));
    const ev = await api(AGENT, `/v1/agents/${publicId}/decisions/${decisions.public[0]}/evidence`);
    check('its prompt and raw response are still public', !!ev.body?.prompt?.body && !!ev.body?.response?.body);
    check('and now come with a verified commitment as well', ev.body?.verification?.status === 'verified');
    const list = await api(AGENT, `/v1/agents/${publicId}/decisions?page_size=10`);
    const row = list.body?.decisions?.[0];
    check('its decision rows still carry thesis and model', row?.thesis && row?.model?.model && row?.intelligence === 'public');
  });
} catch (e) {
  check('the run completed', false, String(e?.stack ?? e));
}

const code = report();
if (code !== 0) process.exit(code);
console.log('private-agent-verify: private intelligence stayed private, and the proof of it held.');
// EXIT, DON'T DRAIN. The mock provider and the engine's pipes keep the event
// loop alive, so a passing run used to sit until run-all's timeout killed it —
// reported as a pass, five minutes late, with the engine left running.
process.exit(0);
