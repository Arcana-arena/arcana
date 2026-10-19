/**
 * ARCANA signer KMS (option B) verification.
 *
 * WHAT IS PROVED, and why a fake KMS is the honest way to prove it:
 *
 * Option B seals the master seed with a KMS key and unseals it at boot. The
 * one thing a test without a cloud account must not do is SKIP the parts that
 * talk to the provider, because those are exactly the parts that have never
 * run. So this suite stands up a LOCAL KMS endpoint that implements the API
 * calls this project actually uses, and then drives the real signer binary
 * through it:
 *
 *   - the sealed blob boots the signer, and it reports option B (not a file);
 *   - the SAME seed loaded through the sealed path derives the SAME wallet as
 *     the plaintext path — the swap is the whole point, so it is measured, not
 *     assumed;
 *   - the Decrypt request that arrives is a properly SigV4-signed call, and
 *     the signature is RECOMPUTED here, in a second implementation, rather
 *     than taken on trust. (The Go signer's SigV4 is anchored separately on
 *     AWS's published test vectors; this checks the request as actually sent.)
 *   - a REFUSED decrypt stands the signer down — it boots, refuses every
 *     signature, and does not fall back to the plaintext seed;
 *   - missing configuration stands down, an unknown source is fatal, and a
 *     sealed blob the world can read is refused before it is decrypted.
 *
 * WHAT IS NOT PROVED: that AWS's real service behaves identically. That is a
 * contract question, not a code one — the API shape here is the documented
 * one, and the runbook is in docs/signer.md.
 */
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto';

const REPO = process.env.REPO || '/home/ubuntu/arcana';
const PORT = Number(process.env.TEST_KMS_SIGNER_PORT || 8094);
const GO = process.env.GO_BIN || '/usr/local/go/bin/go';
const AKID = 'AKIDEXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const REGION = 'us-east-1';
const KEY_ID = 'arn:aws:kms:us-east-1:111122223333:key/verify';

let pass = 0;
const failures = [];
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${n}`); }
  else { failures.push(`${n} — ${d}`); console.log(`  FAIL  ${n} — ${d}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

// --- the fake module's "hardware key" and its two calls ----------------------
const KMS_KEY = randomBytes(32);
const seal = (buf) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KMS_KEY, iv);
  return Buffer.concat([iv, c.getAuthTag(), c.update(buf), c.final()]);
};
const unseal = (blob) => {
  const d = createDecipheriv('aes-256-gcm', KMS_KEY, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
};

const kmsLog = [];
let kmsMode = 'ok'; // 'ok' | 'refuse'

/**
 * Recompute the SigV4 signature over the request AS IT ARRIVED.
 *
 * Deliberately a second implementation, in another language: the Go signer's
 * version is anchored on AWS's own vectors, and this checks that the bytes on
 * the wire are signed over the same way. Two independent implementations
 * agreeing on a request is the strongest statement available without an
 * account.
 */
function verifySigV4(headers, rawBody) {
  const authz = headers['authorization'] || '';
  const m = authz.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/);
  if (!m) return { ok: false, why: `malformed authorization: ${authz.slice(0, 60)}` };
  const [, akid, date, region, service, signedHeaders, signature] = m;
  const names = signedHeaders.split(';');
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n] ?? '').trim()}\n`).join('');
  const payloadHash = createHash('sha256').update(rawBody).digest('hex');
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', headers['x-amz-date'], scope,
    createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const h = (k, d) => createHmac('sha256', k).update(d).digest();
  const kSigning = h(h(h(h(`AWS4${SECRET}`, date), region), service), 'aws4_request');
  const expected = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    ok: akid === AKID && expected === signature,
    why: `credential ${akid}, expected ${expected}, got ${signature}`,
  };
}

const kms = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const target = req.headers['x-amz-target'] || '';
    const entry = { target };
    kmsLog.push(entry);
    const sig = verifySigV4(req.headers, raw);
    entry.sigOk = sig.ok;
    entry.sigWhy = sig.why;

    const reply = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/x-amz-json-1.1' });
      res.end(JSON.stringify(body));
    };
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return reply(400, { __type: 'SerializationException', message: 'not json' }); }

    if (kmsMode === 'refuse') {
      entry.outcome = 'refused';
      return reply(400, { __type: 'AccessDeniedException', message: 'User is not authorized to perform kms:Decrypt' });
    }
    if (target === 'TrentService.Decrypt') {
      try {
        const plain = unseal(Buffer.from(body.CiphertextBlob, 'base64'));
        entry.outcome = 'decrypted';
        return reply(200, { Plaintext: plain.toString('base64') });
      } catch {
        entry.outcome = 'bad-ciphertext';
        return reply(400, { __type: 'InvalidCiphertextException', message: 'ciphertext is not decryptable' });
      }
    }
    if (target === 'TrentService.Encrypt') {
      entry.outcome = 'encrypted';
      return reply(200, { CiphertextBlob: seal(Buffer.from(body.Plaintext, 'base64')).toString('base64') });
    }
    entry.outcome = 'unknown-target';
    return reply(400, { __type: 'UnknownOperationException', message: target });
  });
});
await new Promise((r) => kms.listen(0, '127.0.0.1', r));
const KMS_PORT = kms.address().port;
const KMS_URL = `http://127.0.0.1:${KMS_PORT}`;

// --- fixtures ----------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'signer-kms-verify-'));
const AGENT = randomUUID();
const seedHex = randomBytes(32).toString('hex');
const seedPath = join(dir, 'master.key');
writeFileSync(seedPath, seedHex);
chmodSync(seedPath, 0o400);

// What `aws kms encrypt` of the seed file would produce: the file's bytes,
// sealed. Done through the same transform the fake's Encrypt endpoint uses.
const blobPath = join(dir, 'master.key.kms');
writeFileSync(blobPath, seal(Buffer.from(seedHex)));
chmodSync(blobPath, 0o400);
const exposedBlobPath = join(dir, 'master.key.exposed.kms');
writeFileSync(exposedBlobPath, seal(Buffer.from(seedHex)));
chmodSync(exposedBlobPath, 0o644);

const allowPath = `${REPO}/services/signer/allowlist/robinhood-mainnet.json`;
const BIN = `/tmp/signer-kms-verify-signer.${process.pid}`;
execFileSync(GO, ['build', '-o', BIN, './cmd/server'], { cwd: `${REPO}/services/signer`, stdio: 'inherit' });

let proc = null;
let logs = '';
function start(extra = {}) {
  logs = '';
  proc = spawn(BIN, [], {
    cwd: `${REPO}/services/signer`,
    env: {
      ...process.env,
      PORT: String(PORT),
      INTERNAL_API_KEY: 'kms-verify-key',
      SIGNER_ALLOWLIST_FILE: allowPath,
      SIGNER_RPC_URLS: 'http://127.0.0.1:1', // dead on purpose; nothing here needs the chain
      SIGNER_SIGNATURE_COUNT_FILE: join(dir, 'signatures.json'),
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => { logs += d.toString(); });
  proc.stderr.on('data', (d) => { logs += d.toString(); });
  return proc;
}
async function stop() {
  if (!proc) return;
  proc.kill('SIGKILL');
  try { execFileSync('bash', ['-lc', `fuser -k ${PORT}/tcp 2>/dev/null || true`]); } catch {}
  proc = null;
  await new Promise((r) => setTimeout(r, 800));
}
async function waitUp(ms = 25000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) return await r.json(); } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}
const wallets = async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/internal/v1/signer/wallets/${AGENT}`, {
    headers: { 'X-Internal-Key': 'kms-verify-key' },
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const flush = async () => {
  try { execFileSync('bash', ['-lc', `fuser -k ${PORT}/tcp 2>/dev/null || true`]); } catch {}
  await new Promise((r) => setTimeout(r, 400));
};
await flush();

const kmsEnv = {
  SIGNER_SEED_SOURCE: 'kms',
  SIGNER_SEED_KMS_FILE: blobPath,
  SIGNER_KMS_KEY_ID: KEY_ID,
  SIGNER_KMS_REGION: REGION,
  SIGNER_KMS_ACCESS_KEY_ID: AKID,
  SIGNER_KMS_SECRET_ACCESS_KEY: SECRET,
  SIGNER_KMS_ENDPOINT: KMS_URL,
};

// --- 1. the plaintext path, for the address to compare against ---------------
section('The reference wallet, from the file path');
let refAddress = '';
{
  start({ SIGNER_MASTER_SEED_FILE: seedPath });
  const health = await waitUp();
  check('the signer boots in file mode', !!health, 'healthz did not answer');
  check('file mode reports a configured signer', health?.signer_configured === true, JSON.stringify(health));
  const w = await wallets();
  refAddress = w.body.address || '';
  check('file mode derives the agent wallet', /^0x[0-9a-f]{40}$/.test(refAddress), JSON.stringify(w.body));
  await stop();
}

// --- 2. option B: the sealed blob boots and derives the same wallet ----------
section('The sealed seed boots, and derives the SAME wallet');
{
  kmsLog.length = 0;
  kmsMode = 'ok';
  start({ ...kmsEnv, SIGNER_MASTER_SEED_FILE: join(dir, 'never-used.key') });
  const health = await waitUp();
  check('the signer boots with SIGNER_SEED_SOURCE=kms', !!health, 'healthz did not answer');
  check('kms mode reports a configured signer', health?.signer_configured === true, JSON.stringify(health));
  check('the boot log names option B, not a file-backed seed',
    /KMS-sealed master seed \(option B\)/.test(logs), logs.split('\n').find((l) => l.includes('signer ACTIVE')) || '(no ACTIVE line)');
  const w = await wallets();
  check('the sealed seed derives the same address as the plaintext seed',
    w.body.address === refAddress && !!refAddress, `${w.body.address} vs ${refAddress}`);
  await stop();
}

// --- 3. the request on the wire is a signed Decrypt call ---------------------
section('The Decrypt call is SigV4-signed, checked by a second implementation');
{
  const decrypts = kmsLog.filter((e) => e.target === 'TrentService.Decrypt');
  check('a Decrypt call arrived at the KMS endpoint', decrypts.length >= 1, `${kmsLog.length} requests seen`);
  if (decrypts.length > 0) {
    check('its signature verifies when recomputed here', decrypts[0].sigOk === true, decrypts[0].sigWhy);
    check('it was answered (the signer got a plaintext back)', decrypts[0].outcome === 'decrypted', decrypts[0].outcome);
  }
}

// --- 4. a refused decrypt stands the signer down -----------------------------
section('A refused decrypt is a stand-down, never a fallback');
{
  kmsMode = 'refuse';
  start({ ...kmsEnv });
  const health = await waitUp();
  check('the signer still boots (visible stand-down, not a crash)', !!health, 'healthz did not answer');
  check('and reports an UNCONFIGURED signer', health?.signer_configured === false, JSON.stringify(health));
  check('the log names the KMS refusal',
    /signer INACTIVE: .*AccessDenied/.test(logs),
    logs.split('\n').find((l) => l.includes('signer INACTIVE')) || '(no INACTIVE line)');
  const w = await wallets();
  check('every wallet request is refused with signer_not_configured',
    w.body?.error?.code === 'signer_not_configured', JSON.stringify(w.body));
  await stop();
  kmsMode = 'ok';
}

// --- 5. incomplete configuration, and an unknown source ----------------------
section('Incomplete configuration stands down; an unknown source is fatal');
{
  const { SIGNER_KMS_KEY_ID: _drop, ...noKeyId } = kmsEnv;
  start({ ...noKeyId });
  const health = await waitUp();
  check('kms mode with no key id still boots', !!health, 'healthz did not answer');
  check('and stands down rather than guessing', health?.signer_configured === false, JSON.stringify(health));
  check('the log says what was missing', /AWS KMS: .*key id/.test(logs), logs.split('\n').find((l) => l.includes('signer INACTIVE')) || '');
  await stop();
}
{
  let code = 0;
  let out = '';
  try {
    execFileSync(BIN, [], {
      cwd: `${REPO}/services/signer`,
      env: { ...process.env, SIGNER_SEED_SOURCE: 'bogus', SIGNER_ALLOWLIST_FILE: allowPath },
      timeout: 10000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    code = e.status ?? -1;
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  check('an unknown SIGNER_SEED_SOURCE exits non-zero', code !== 0, `exit ${code}`);
  check('and names the sources it does know', /is not a source this signer knows.*"file".*"kms"/.test(out), out.slice(-160));
}

// --- 6. an exposed sealed blob is refused before it is decrypted -------------
section('A sealed blob anyone can read is refused');
{
  start({ ...kmsEnv, SIGNER_SEED_KMS_FILE: exposedBlobPath });
  const health = await waitUp();
  check('the signer boots but stands down', health?.signer_configured === false, JSON.stringify(health));
  check('and says the file mode is the problem',
    /sealed seed .* has mode 0644/.test(logs), logs.split('\n').find((l) => l.includes('signer INACTIVE')) || '');
  await stop();
}

// --- cleanup -----------------------------------------------------------------
kms.close();
rmSync(dir, { recursive: true, force: true });
try { rmSync(BIN, { force: true }); } catch {}

console.log('\n========================================');
console.log(`  PASS: ${pass}   FAIL: ${failures.length}`);
console.log('========================================');
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
