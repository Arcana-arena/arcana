/**
 * guard-chain-verify.mjs — check a protective exit that really happened.
 *
 * WHAT THIS IS FOR. guard-verify proves the mechanism without the chain: the
 * lease under a real race, the schema's refusals, the watchdog's four alarms.
 * This one reads the record of a level that was actually crossed and a
 * transaction that was actually mined, and checks that every claim the design
 * makes about it is true of the rows.
 *
 * IT DOES NOT CAUSE THE TRIGGER. A stop loss fires when the market crosses a
 * level; manufacturing that would mean either moving the level after the fact
 * or faking the price, and both would prove something about the fake. The
 * trigger comes from the live watcher on the live pool, and this reads what it
 * left behind.
 *
 * Run it with no arguments to check the most recent triggered guard, or pass a
 * guard id. It REFUSES rather than passes when there is nothing to check: a
 * verification that reports success because it found no data is the failure
 * this project keeps writing down.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REPO = process.env.REPO || '/home/ubuntu/arcana';
const PG = process.env.PG_CONTAINER || 'arcana-postgres';
const SIGNER = process.env.SIGNER_URL || 'http://127.0.0.1:8085';
const RPC = process.env.EXECUTION_RPC_URL || 'https://robinhood-rpc.publicnode.com';

const env = Object.fromEntries(
  readFileSync(`${REPO}/.env.auth`, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

let pass = 0, fail = 0;
const failures = [];
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; failures.push(`${n} — ${d}`); console.log(`  FAIL  ${n} — ${d}`); }
};
const psql = (s) => execFileSync('docker', ['exec', PG, 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc', s], { encoding: 'utf8' }).trim();
const rpc = async (method, params) => {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await r.json()).result;
};

// THE SUBJECT IS THE DECISION, not the guard row.
//
// A protective exit is a decision with a different author, and that row is the
// authoritative record of it: it exists whatever happens to the guard
// afterwards. The first version looked this up by status='triggered' — and the
// first two real exits could not be marked triggered at all, because CloseGuard
// carried a query Postgres refused. The exits happened, the transactions mined,
// and this suite would have reported "nothing to check".
//
// Pass a decision id to check a specific one.
const want = process.argv[2];
const decID = want || psql(
  `SELECT id FROM decisions
     WHERE decider = 'protective' AND action = 'sell'
     ORDER BY ts DESC LIMIT 1`);

if (!decID) {
  console.log('guard-chain-verify: NO PROTECTIVE EXIT TO CHECK.');
  console.log('This is not a pass. Arm a level, let the market cross it, then run this.');
  process.exit(2);
}

const drow = psql(`SELECT agent_id || '|' || coalesce(symbol,'') || '|' || coalesce(reason_code,'') || '|' || ts::text
                     FROM decisions WHERE id = ${decID}`);
const [agentID, symbol, side, tat] = drow.split('|');

// The guard that produced it, for context. None of the assertions below depend
// on that row surviving, which is the point of keying on the decision.
const gid = psql(`SELECT coalesce(max(id)::text,'') FROM position_guards
                   WHERE agent_id = '${agentID}' AND symbol = '${symbol}'`) || '-';
const grow = gid === '-' ? '||' : psql(
  `SELECT coalesce(stop_loss::text,'') || '|' || coalesce(take_profit::text,'') || '|' || coalesce(entry_price::text,'')
     FROM position_guards WHERE id = ${gid}`);
const [sl, tp, entry] = grow.split('|');

console.log(`=== decision ${decID}: ${side} on ${symbol} at ${tat} (guard ${gid}, entry ${entry}, stop ${sl}, target ${tp}) ===\n`);

// --- 1. The decision names its author -------------------------------------
console.log('=== The record says who decided ===');
{
  const d = psql(`SELECT coalesce(action,'') || '|' || coalesce(decider,'') || '|' ||
                         coalesce(reason_code,'') || '|' || coalesce(provider,'') || '|' ||
                         coalesce(model,'') || '|' || coalesce(thesis::text,'') || '|' ||
                         coalesce(prompt_hash,'') || '|' || coalesce(rationale,'')
                    FROM decisions WHERE id = ${decID}`);
  const [action, decider, reason, provider, model, thesis, promptHash, rationale] = d.split('|');

  check('it is recorded as a sell, because it was one', action === 'sell', `action=${action}`);
  check('the author is `protective`, not the model', decider === 'protective', `decider=${decider}`);
  check('the reason names which level fired', reason === side, `reason_code=${reason}, side=${side}`);
  check('and the two sides are distinguishable',
    reason === 'stop_loss' || reason === 'take_profit', `reason_code=${reason}`);

  // WHAT IT DOES NOT CLAIM. No model decided this, so every column that would
  // name one has to be empty. A protective decision carrying a provider would
  // be the record inventing an author.
  check('no provider is claimed', provider === '', `provider=${provider}`);
  check('no model is claimed', model === '', `model=${model}`);
  check('no thesis is claimed', thesis === '', `thesis=${thesis}`);
  check('no prompt is claimed', promptHash === '', `prompt_hash=${promptHash}`);

  check('the rationale says no one decided', /Decided by no one/.test(rationale), rationale.slice(0, 120));
  check('and says the snapshot ref was not the input',
    /was NOT the input/.test(rationale), rationale.slice(0, 200));
  check('it names the level it crossed', rationale.includes(side === 'stop_loss' ? 'stop loss' : 'take profit'),
    rationale.slice(0, 120));
  console.log(`      ${rationale.slice(0, 200)}`);
}

// --- 2. The transaction is real -------------------------------------------
console.log('\n=== The exit reached the chain ===');
let swapTx = '';
{
  const e = psql(`SELECT id || '|' || status || '|' || coalesce(tx_hash,'') || '|' ||
                         coalesce(amount_in::text,'') || '|' || coalesce(filled_out::text,'') || '|' ||
                         coalesce(gas_cost_usd::text,'') || '|' || coalesce(pool_fee_usd::text,'') || '|' ||
                         coalesce(decision_id::text,'')
                    FROM executions WHERE decision_id = ${decID} AND intent_action = 'sell'`);
  check('there is an execution row for the exit', !!e, 'no sell execution linked to the decision');
  const [eid, status, tx, amountIn, filled, gasUSD, feeUSD, linkedTo] = e.split('|');

  check('it is linked to the protective decision', linkedTo === decID, `decision_id=${linkedTo}`);
  check('it was mined', status === 'mined', `status=${status}`);
  check('it carries a transaction hash', /^0x[0-9a-f]{64}$/.test(tx), tx);
  swapTx = tx;

  const rcpt = await rpc('eth_getTransactionReceipt', [tx]);
  check('the hash is a real receipt on chain', !!rcpt, 'the node does not know this transaction');
  check('and the chain says it succeeded', rcpt?.status === '0x1', `receipt status ${rcpt?.status}`);
  console.log(`      tx ${tx} in block ${parseInt(rcpt?.blockNumber ?? '0', 16)}`);

  // THE COST METER GETS ITS DATA. A row with an exact wei cost and a NULL
  // dollar cost is read by the meter as an unreadable bill, which pauses the
  // agent and blames the price feed.
  check('the gas is priced in dollars', Number(gasUSD) > 0, `gas_cost_usd=${gasUSD}`);
  check('the pool fee is recorded separately', Number(feeUSD) > 0, `pool_fee_usd=${feeUSD}`);
  check('the fill was measured', Number(filled) > 0, `filled_out=${filled}`);
}

// --- 3. The approval is its own transaction -------------------------------
console.log('\n=== The approval has its own row, and its own price ===');
{
  const a = psql(`SELECT id || '|' || status || '|' || coalesce(tx_hash,'') || '|' ||
                         coalesce(gas_cost_usd::text,'') || '|' ||
                         CASE WHEN filled_out IS NULL THEN 'null' ELSE filled_out::text END
                    FROM executions
                   WHERE agent_id = '${agentID}' AND intent_action = 'approve'
                     AND ts >= '${tat}'::timestamptz - interval '2 minutes'
                   ORDER BY id DESC LIMIT 1`);
  check('the approval was recorded', !!a, 'no approval row near the exit');
  if (a) {
    const [aid, status, atx, agas, afilled] = a.split('|');
    check('with its own transaction hash', /^0x[0-9a-f]{64}$/.test(atx) && atx !== swapTx,
      `approve tx ${atx}`);
    check('and its own gas bill, in dollars', Number(agas) > 0, `gas_cost_usd=${agas}`);
    check('filled_out stays NULL: an approval moves nothing BY DESIGN',
      afilled === 'null', `filled_out=${afilled}`);
    const arcpt = await rpc('eth_getTransactionReceipt', [atx]);
    check('the approval is on chain too', arcpt?.status === '0x1', `receipt ${arcpt?.status}`);
  }
}

// --- 4. The position actually closed --------------------------------------
console.log('\n=== The exit emptied the position ===');
{
  const wallet = psql(`SELECT address FROM agent_wallets WHERE agent_id = '${agentID}'`);
  const alw = JSON.parse(readFileSync(
    process.env.EXECUTION_ALLOWLIST_FILE || `${REPO}/services/signer/allowlist/robinhood-mainnet.json`, 'utf8'));
  const tok = alw.tokens.find((t) => t.symbol === symbol);
  const bal = await rpc('eth_call', [{ to: tok.address, data: '0x70a08231' + '0'.repeat(24) + wallet.slice(2) }, 'latest']);
  const units = BigInt(bal);
  // NOT ZERO-OR-LESS: the claim is that nothing RECORDABLE is left. 1e-8 shares
  // of an 18-decimal token is 1e10 base units — the dust floor, in units.
  const floor = 10n ** BigInt(tok.decimals - 8);
  check('the wallet holds nothing recordable of it', units < floor,
    `${units} base units, floor ${floor}`);
  check('and exactly zero, because an exit sends the balance itself', units === 0n,
    `${units} base units left behind`);

  const holdings = psql(`SELECT coalesce(ps.holdings::text,'{}') FROM portfolio_snapshots ps
                           JOIN portfolios p ON p.id = ps.portfolio_id
                          WHERE p.agent_id = '${agentID}' ORDER BY ps.ts DESC LIMIT 1`);
  check('the snapshot written by the exit carries no residue for it',
    !new RegExp(`"${symbol}"`).test(holdings), holdings.slice(0, 160));
}

// --- 5. It went through the brakes ----------------------------------------
console.log('\n=== It counted against the brakes, rather than going around them ===');
{
  const day = psql(`SELECT round(sum(coalesce(gas_cost_usd,0) + coalesce(pool_fee_usd,0))::numeric, 6)
                      FROM executions WHERE agent_id = '${agentID}' AND ts >= now() - interval '24 hours'`);
  const thisExit = psql(`SELECT round((coalesce(gas_cost_usd,0) + coalesce(pool_fee_usd,0))::numeric, 6)
                           FROM executions WHERE decision_id = ${decID} AND intent_action = 'sell'`);
  check('the cost meter can see this exit in the window',
    Number(day) >= Number(thisExit) && Number(thisExit) > 0, `exit ${thisExit}, 24h total ${day}`);
  console.log(`      this exit cost $${thisExit}; the agent has spent $${day} in 24h`);

  // The signature counter is the signer's own file. It is only reachable once
  // the signer carrying it is deployed; say which, rather than passing quietly.
  let counts = null;
  try {
    const r = await fetch(`${SIGNER}/internal/v1/signer/signatures`, {
      headers: { 'X-Internal-Key': env.INTERNAL_API_KEY },
    });
    if (r.ok) counts = await r.json();
  } catch {}
  if (counts) {
    const n = counts?.counts?.[agentID] ?? null;
    check('the signer counted the signatures this exit needed',
      Number(n) >= 2, `the signer reports ${JSON.stringify(n)} for this agent today`);
  } else {
    console.log('  SKIP  the signer signature endpoint is not reachable on this build');
    console.log('        (the durable counter ships in the same deploy as this feature;');
    console.log('         re-run after deploying to check the cap saw these signatures)');
  }
}

// --- 6. One intent, one transaction ---------------------------------------
console.log('\n=== One crossing produced exactly one exit ===');
{
  const sells = psql(`SELECT count(*) FROM executions
                       WHERE agent_id = '${agentID}' AND intent_action = 'sell'
                         AND ts >= '${tat}'::timestamptz - interval '2 minutes'
                         AND ts <= '${tat}'::timestamptz + interval '5 minutes'`);
  check('exactly one sell was sent around the crossing', sells === '1', `${sells} sells`);
  const stillArmed = psql(`SELECT count(*) FROM position_guards
                            WHERE agent_id = '${agentID}' AND symbol = '${symbol}' AND status = 'armed'`);
  check('and the guard is not still armed over a position that is gone',
    stillArmed === '0', `${stillArmed} armed guards remain on ${symbol}`);
}

console.log('\n' + '='.repeat(40));
console.log(`  PASS: ${pass}   FAIL: ${fail}`);
console.log('='.repeat(40));
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log(`guard-chain-verify: guard ${gid} fired on a real crossing and the record holds up.`);
