/**
 * anchor-verify.mjs — commitments are anchored on chain, and the anchors hold.
 *
 * WHAT IS CLAIMED, and what would falsify it:
 *
 *   1. The anchoring signer can say exactly one thing: a self-send carrying a
 *      root. Falsified by it accepting any other field, a malformed root, fees
 *      or gas past its caps, or a caller without the internal key — or by the
 *      one transaction it does sign decoding to anything else.
 *   2. The record is append-only. Falsified by the database accepting a changed
 *      root, a deleted anchor, or an edited leaf.
 *   3. Every mined anchor is what it says. Its leaves are recomputed HERE, with
 *      a third implementation of the tree, and the root is compared with the
 *      input of the transaction as the chain returns it — not as ARCANA stores it.
 *   4. Nothing sealed is left unanchored for long, and nothing is anchored
 *      suspiciously late — the shape a backdated decision would have.
 *   5. The public proof endpoint gives a proof that verifies.
 *
 * It signs one transaction (and never broadcasts it) to prove the shape, which
 * spends one of the signer's daily allowance. Nothing else is written.
 *
 *   node infra/verify/anchor-verify.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseTransaction, recoverTransactionAddress } from 'viem';
import { suite } from './lib/sections.mjs';

const REPO = process.env.REPO || '/home/ubuntu/arcana';
const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const SIGNER = process.env.ANCHOR_SIGNER_URL || 'http://127.0.0.1:8087';
const RPCS = (process.env.ANCHOR_RPC_URLS || 'https://rpc.mainnet.chain.robinhood.com,https://robinhood-rpc.publicnode.com').split(',');
const MAGIC = '415243414e410001';
const KEY = Object.fromEntries(
  readFileSync(`${REPO}/.env.auth`, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
).INTERNAL_API_KEY;

const { check, section, report } = suite('anchor-verify');

const sql = (q) =>
  execFileSync('docker', ['exec', 'arcana-postgres', 'psql', '-U', 'arcana', '-d', 'arcana', '-v', 'ON_ERROR_STOP=1', '-tAc', q],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const refused = (q) => { try { sql(q); return null; } catch (e) { return String(e.stderr || e.message); } };
const json = (q) => { const t = sql(q); return t ? JSON.parse(t) : null; };

// ---- a THIRD implementation of arcana-anchor/v1, independent of Go and of agent-service
const sha = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
const leaf = (c) => sha(Buffer.from([0]), Buffer.from(c, 'hex'));
const node = (l, r) => sha(Buffer.from([1]), l, r);
const root = (leaves) => {
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 === level.length ? level[i] : node(level[i], level[i + 1]));
    level = next;
  }
  return level[0];
};

const rpc = async (method, params) => {
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10000) });
      const b = await r.json();
      if ('result' in b) return b.result;
    } catch {}
  }
  throw new Error(`no RPC answered ${method}`);
};
const signer = async (path, init = {}) => {
  const r = await fetch(`${SIGNER}${path}`, {
    method: init.method ?? 'GET',
    headers: { ...(init.key === false ? {} : { 'X-Internal-Key': KEY }), ...(init.body ? { 'content-type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
};

let address = null;

await section('The anchoring signer can say one thing', async () => {
  const h = await signer('/healthz');
  check('the anchoring signer is running', h.status === 200, `status ${h.status}`);
  check('and holds its key', h.body?.configured === true, 'no anchoring key — create it deliberately with keygen');
  const a = await signer('/internal/v1/anchor/address');
  address = a.body?.address ?? null;
  check('it names its address', /^0x[0-9a-f]{40}$/.test(address ?? ''), JSON.stringify(a.body));
  if (!address) return;

  const good = { root: randomBytes(32).toString('hex'), nonce: 0, max_fee_wei: '200000000', tip_wei: '10000000', gas: 40000 };
  const noKey = await signer('/internal/v1/anchor/sign', { method: 'POST', body: good, key: false });
  check('a caller without the internal key is refused', noKey.status === 401 || noKey.status === 403, `status ${noKey.status}`);
  for (const [what, body] of [
    ['a request naming data', { ...good, data: '0xdeadbeef' }],
    ['a request naming a destination', { ...good, to: '0x000000000000000000000000000000000000dead' }],
    ['a request naming a value', { ...good, value: '1' }],
    ['a root that is not 64 lowercase hex', { ...good, root: good.root.toUpperCase() }],
    ['a short root', { ...good, root: good.root.slice(2) }],
    ['a fee past the cap', { ...good, max_fee_wei: '1000000000000' }],
    ['gas past the cap', { ...good, gas: 5000000 }],
    ['a missing nonce', { root: good.root, max_fee_wei: good.max_fee_wei, tip_wei: good.tip_wei, gas: good.gas }],
  ]) {
    const r = await signer('/internal/v1/anchor/sign', { method: 'POST', body });
    check(`${what} is refused`, r.status >= 400 && r.body?.refused === true, `status ${r.status} ${JSON.stringify(r.body)}`);
  }

  const s = await signer('/internal/v1/anchor/sign', { method: 'POST', body: good });
  check('a well-formed request is signed and NOT broadcast', s.status === 200 && s.body?.broadcast === false, `status ${s.status}`);
  if (s.status !== 200) return;
  const tx = parseTransaction(s.body.raw);
  const from = (await recoverTransactionAddress({ serializedTransaction: s.body.raw })).toLowerCase();
  check('the signed transaction is from the anchoring address', from === address.toLowerCase(), from);
  check('to itself', tx.to?.toLowerCase() === address.toLowerCase(), tx.to);
  check('with zero value', (tx.value ?? 0n) === 0n, String(tx.value));
  check('carrying exactly the marker and the root', tx.data?.toLowerCase() === `0x${MAGIC}${good.root}`, tx.data);
  check('on chain 4663', tx.chainId === 4663, String(tx.chainId));
});

await section('The anchor record is append-only', async () => {
  const mk = `WITH a AS (INSERT INTO decision_anchors (scheme, root, leaf_count, first_decision_id, last_decision_id, first_decision_ts, last_decision_ts, chain_id, sender, nonce, tx_hash, raw_tx, status)
              VALUES ('arcana-anchor/v1', repeat('a',64), 1, 1, 1, now(), now(), 4663, '0x${'0'.repeat(40)}', 0, '0x${randomBytes(32).toString('hex')}', '0x', 'signed') RETURNING id)`;
  // EVERY PROBE ROLLS BACK. A probe the database fails to refuse must not leave
  // a row behind: the rows it would leave are exactly the ones it cannot delete.
  const probe = (body) => refused(`BEGIN; ${body} ROLLBACK;`);
  const e1 = probe(`${mk} SELECT 1; UPDATE decision_anchors SET root = repeat('b',64) WHERE root = repeat('a',64) AND raw_tx = '0x';`);
  check('a root cannot be rewritten', !!e1 && /cannot be rewritten/.test(e1), e1 ?? 'the UPDATE succeeded');
  const e2 = probe(`${mk} SELECT 1; DELETE FROM decision_anchors WHERE root = repeat('a',64) AND raw_tx = '0x';`);
  check('an anchor cannot be deleted', !!e2 && /cannot be deleted/.test(e2), e2 ?? 'the DELETE succeeded');
  const e3 = probe(`${mk} SELECT 1; UPDATE decision_anchors SET status = 'mined' WHERE root = repeat('a',64) AND raw_tx = '0x'; UPDATE decision_anchors SET status = 'broadcast' WHERE root = repeat('a',64) AND raw_tx = '0x';`);
  check('a status cannot move backwards', !!e3 && /final|cannot move/.test(e3), e3 ?? 'the UPDATE succeeded');
  const e4 = probe(`${mk}, l AS (INSERT INTO decision_anchor_leaves (anchor_id, leaf_index, decision_id, decision_ts, agent_id, commitment)
                     SELECT id, 0, 1, now(), gen_random_uuid(), repeat('c',64) FROM a RETURNING anchor_id)
                     SELECT 1; UPDATE decision_anchor_leaves SET commitment = repeat('d',64) WHERE commitment = repeat('c',64);`);
  check('a leaf cannot be edited', !!e4 && /cannot change/.test(e4), e4 ?? 'the UPDATE succeeded');
  check('and none of those probes left a row behind', sql(`SELECT count(*) FROM decision_anchors WHERE raw_tx = '0x'`) === '0');
});

let mined = [];
await section('Every mined anchor is what it says, checked against the chain', async () => {
  mined = json(`SELECT coalesce(json_agg(x ORDER BY x.id DESC), '[]') FROM (
                  SELECT id, trim(root) AS root, trim(sender) AS sender, trim(tx_hash) AS tx_hash, chain_id, created_at, mined_at
                    FROM decision_anchors WHERE status = 'mined' ORDER BY id DESC LIMIT 25) x`) ?? [];
  const ever = sql(`SELECT count(*) FROM decision_anchors WHERE status = 'mined'`);
  check('anchoring has written at least one root to the chain', Number(ever) > 0,
    `no mined anchor — the anchoring wallet ${address ?? '(unknown)'} may be unfunded, or the job has not run`);
  for (const a of mined) {
    const leaves = json(`SELECT json_agg(trim(commitment) ORDER BY leaf_index) FROM decision_anchor_leaves WHERE anchor_id = ${a.id}`) ?? [];
    check(`anchor ${a.id}: its leaves recompute to its root`, leaves.length > 0 && root(leaves.map(leaf)).toString('hex') === a.root);
    const drift = sql(`SELECT count(*) FROM decision_anchor_leaves l JOIN decisions d ON d.id = l.decision_id AND d.ts = l.decision_ts
                        WHERE l.anchor_id = ${a.id} AND trim(d.commitment) <> trim(l.commitment)`);
    check(`anchor ${a.id}: no anchored decision's commitment has changed since`, drift === '0', `${drift} changed`);
    let tx = null, receipt = null;
    try { [tx, receipt] = await Promise.all([rpc('eth_getTransactionByHash', [a.tx_hash]), rpc('eth_getTransactionReceipt', [a.tx_hash])]); } catch (e) {
      check(`anchor ${a.id}: the chain can be read`, false, e.message);
      continue;
    }
    check(`anchor ${a.id}: the chain has the transaction, and it succeeded`, receipt?.status === '0x1', receipt?.status);
    check(`anchor ${a.id}: sent by the anchoring address to itself`,
      tx?.from?.toLowerCase() === a.sender && tx?.to?.toLowerCase() === a.sender, `${tx?.from} → ${tx?.to}`);
    check(`anchor ${a.id}: the input on chain is the marker and this root`, tx?.input?.toLowerCase() === `0x${MAGIC}${a.root}`, tx?.input);
  }
});

await section('Nothing sealed waits long, and nothing is anchored suspiciously late', async () => {
  if (mined.length === 0) {
    check('coverage can be judged', false, 'no anchor has ever been mined, so every sealed decision is waiting');
    return;
  }
  const late = sql(`SELECT count(*) FROM decisions d -- raw-by-design: anchoring covers every sealed row
                     JOIN agents a ON a.id = d.agent_id AND a.provenance = 'live'
                    WHERE d.commitment IS NOT NULL AND d.ts < now() - interval '45 minutes'
                      AND NOT EXISTS (SELECT 1 FROM decision_anchor_leaves l JOIN decision_anchors x ON x.id = l.anchor_id
                                       WHERE l.decision_id = d.id AND l.decision_ts = d.ts AND x.status = 'mined')`);
  check('every sealed decision older than 45 minutes is in a mined anchor', late === '0', `${late} are not`);
  const backdated = sql(`WITH first AS (SELECT min(created_at) AS t FROM decision_anchors WHERE status = 'mined')
                          SELECT count(*) FROM decision_anchor_leaves l JOIN decision_anchors a ON a.id = l.anchor_id, first
                           WHERE a.status = 'mined' AND l.decision_ts > first.t AND a.created_at - l.decision_ts > interval '2 hours'`);
  check('no decision recorded after anchoring began was anchored more than two hours after it was recorded', backdated === '0',
    `${backdated} leaf/leaves — the shape a backdated insert would have`);
});

await section('The public proof verifies', async () => {
  const sample = json(`SELECT json_build_object('agent', l.agent_id, 'decision', l.decision_id, 'root', trim(a.root))
                         FROM decision_anchor_leaves l JOIN decision_anchors a ON a.id = l.anchor_id
                         JOIN decisions d ON d.id = l.decision_id AND d.ts = l.decision_ts
                        WHERE a.status = 'mined' ORDER BY a.id DESC, l.leaf_index DESC LIMIT 1`);
  if (!sample) {
    check('there is an anchored decision to prove', false, 'no mined anchor');
    return;
  }
  const r = await fetch(`${AGENT}/v1/agents/${sample.agent}/decisions/${sample.decision}/anchor`);
  const b = await r.json();
  check('the proof endpoint answers', r.status === 200, `status ${r.status}`);
  check('and says the decision is anchored', b.status === 'anchored', b.status);
  let cur = leaf(b.commitment);
  for (const s of b.proof ?? []) cur = s.position === 'left' ? node(Buffer.from(s.sibling, 'hex'), cur) : node(cur, Buffer.from(s.sibling, 'hex'));
  check('its proof, walked here, reaches the anchored root', cur.toString('hex') === sample.root);
  check('every check it lists passed', (b.checks ?? []).length > 0 && b.checks.every((c) => c.ok), JSON.stringify((b.checks ?? []).filter((c) => !c.ok)));
});

await section('It runs on its own', async () => {
  const en = (u) => { try { return execFileSync('systemctl', ['is-enabled', u], { encoding: 'utf8' }).trim(); } catch (e) { return String(e.stdout || '').trim(); } };
  check('arcana-anchor.timer is enabled', en('arcana-anchor.timer') === 'enabled');
  check('arcana-anchor-signer is enabled', en('arcana-anchor-signer.service') === 'enabled');
});

const code = report();
if (code !== 0) process.exit(code);
console.log('anchor-verify: commitments are on chain, and the record agrees with it.');
