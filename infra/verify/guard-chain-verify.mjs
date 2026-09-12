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
import { suite } from './lib/sections.mjs';
import {
  makeRpc, chainReader, emptied, loadAllowlist, tokenOf as tokenIn,
} from './lib/chain.mjs';

const REPO = process.env.REPO || '/home/ubuntu/arcana';
const PG = process.env.PG_CONTAINER || 'arcana-postgres';
const SIGNER = process.env.SIGNER_URL || 'http://127.0.0.1:8085';
const RPC = process.env.EXECUTION_RPC_URL || 'https://robinhood-rpc.publicnode.com';

const env = Object.fromEntries(
  readFileSync(`${REPO}/.env.auth`, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

// THE COUNTERS, THE SECTION GUARD AND THE CHAIN READERS ARE SHARED NOW.
//
// This file and subscription-chain-verify had written the same two defects
// independently: an rpc() that turned a node error into `undefined` and then
// into a passing custody claim, and an "the exit emptied the position" check
// asserted against the balance at 'latest'. The second one had this suite RED
// for four false failures while the sibling was already fixed, and neither file
// could tell you the other one knew better. Both now come from lib/chain.mjs.
const { check, section, nothingToCheck, report } = suite('guard-chain-verify');
const psql = (s) => execFileSync('docker', ['exec', PG, 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc', s], { encoding: 'utf8' }).trim();
const rpc = makeRpc(RPC);
const chainRead = chainReader(check);
const ALLOWLIST = loadAllowlist(REPO);
const tokenOf = (sym) => tokenIn(ALLOWLIST, sym);

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

// THE GUARD THAT PRODUCED THIS EXIT, for context. None of the assertions below
// depend on that row surviving, which is the point of keying on the decision.
//
// It used to be max(id) for the agent and symbol, which is the NEWEST guard on
// that symbol — and since the agent re-buys what it sells, that is usually a
// guard over a later position. The banner named guard 265 while every check
// below was about guard 204. A header that names a different subject than the
// checks under it is how you read a green run and learn the wrong thing.
const gid = psql(`SELECT coalesce(
    (SELECT e.guard_id::text FROM executions e
      WHERE e.decision_id = ${decID} AND e.intent_action = 'sell' AND e.guard_id IS NOT NULL
      ORDER BY e.id DESC LIMIT 1),
    (SELECT id::text FROM position_guards WHERE triggered_decision_id = ${decID}
      ORDER BY id DESC LIMIT 1),
    '')`) || '-';
const grow = gid === '-' ? '||' : psql(
  `SELECT coalesce(stop_loss::text,'') || '|' || coalesce(take_profit::text,'') || '|' || coalesce(entry_price::text,'')
     FROM position_guards WHERE id = ${gid}`);
const [sl, tp, entry] = grow.split('|');

console.log(`=== decision ${decID}: ${side} on ${symbol} at ${tat} (guard ${gid}, entry ${entry}, stop ${sl}, target ${tp}) ===\n`);

// --- 1. The decision names its author -------------------------------------
await section("The record says who decided", async () => {
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
});

// --- 2. The transaction is real -------------------------------------------
let swapTx = '';
// Hoisted for section 4, which proves custody from THIS transaction rather than
// from whatever the wallet holds later. The wallet comes off the execution row,
// because that row is what names the account the funds actually moved in.
let exitWallet = '';
let exitRcpt = null;
let exitGuardID = '';
await section("The exit reached the chain", async () => {
  const e = psql(`SELECT id || '|' || status || '|' || coalesce(tx_hash,'') || '|' ||
                         coalesce(amount_in::text,'') || '|' || coalesce(filled_out::text,'') || '|' ||
                         coalesce(gas_cost_usd::text,'') || '|' || coalesce(pool_fee_usd::text,'') || '|' ||
                         coalesce(decision_id::text,'') || '|' || coalesce(wallet,'') || '|' ||
                         coalesce(guard_id::text,'')
                    FROM executions WHERE decision_id = ${decID} AND intent_action = 'sell'`);
  check('there is an execution row for the exit', !!e, 'no sell execution linked to the decision');
  const [eid, status, tx, amountIn, filled, gasUSD, feeUSD, linkedTo, wal, gidOfExit] = e.split('|');
  exitWallet = wal;
  exitGuardID = gidOfExit;

  check('it is linked to the protective decision', linkedTo === decID, `decision_id=${linkedTo}`);
  check('it was mined', status === 'mined', `status=${status}`);
  check('it carries a transaction hash', /^0x[0-9a-f]{64}$/.test(tx), tx);
  swapTx = tx;

  const rcpt = await chainRead('the hash is a real receipt on chain',
    () => rpc('eth_getTransactionReceipt', [tx]));
  exitRcpt = rcpt || null;
  if (rcpt !== undefined) {
    check('the hash is a real receipt on chain', !!rcpt, 'the node does not know this transaction');
    check('and the chain says it succeeded', rcpt?.status === '0x1', `receipt status ${rcpt?.status}`);
    console.log(`      tx ${tx} in block ${parseInt(rcpt?.blockNumber ?? '0', 16)}`);
  }

  // THE COST METER GETS ITS DATA. A row with an exact wei cost and a NULL
  // dollar cost is read by the meter as an unreadable bill, which pauses the
  // agent and blames the price feed.
  check('the gas is priced in dollars', Number(gasUSD) > 0, `gas_cost_usd=${gasUSD}`);
  check('the pool fee is recorded separately', Number(feeUSD) > 0, `pool_fee_usd=${feeUSD}`);
  check('the fill was measured', Number(filled) > 0, `filled_out=${filled}`);
});

// --- 3. The approval is its own transaction -------------------------------
await section("The approval has its own row, and its own price", async () => {
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
    const arcpt = await chainRead('the approval is on chain too',
      () => rpc('eth_getTransactionReceipt', [atx]));
    if (arcpt !== undefined) {
      check('the approval is on chain too', arcpt?.status === '0x1', `receipt ${arcpt?.status}`);
    }
  }
});

// --- 4. The position actually closed --------------------------------------
await section("The exit emptied the position", async () => {
  // PROVED FROM THE EXIT, NOT FROM THE PRESENT.
  //
  // This read the wallet's balance at 'latest' and asserted it was dust, and it
  // had this suite red on four checks at once. Decision 1968 sold NVDA at
  // 04:44:43; decision 1973 BOUGHT NVDA BACK at 05:09:16 and armed two fresh
  // guards over the new position. So the "residue" was a legitimate position
  // twenty-five minutes younger than the exit, the "snapshot written by the exit"
  // was the snapshot written by the re-entry, and the "guard still armed over a
  // position that is gone" was a guard armed over a position that is there.
  //
  // Nothing about that is fixable by reading at the exit's block: this endpoint
  // refuses historical state outright ("Archive requests require a personal
  // token"), 500 blocks back as surely as 200,000. Measured.
  //
  // The transaction's own Transfer logs need no archive and cannot be changed by
  // anything that happens afterwards. They say what left the wallet; the guard
  // says what was being protected. Emptied means those match.
  const tok = tokenOf(symbol);
  const g = exitGuardID
    ? psql(`SELECT entry_qty::text || '|' || status FROM position_guards WHERE id = ${exitGuardID}`)
    : psql(`SELECT entry_qty::text || '|' || status FROM position_guards
              WHERE triggered_decision_id = ${decID} ORDER BY id DESC LIMIT 1`);
  const [gQty, gStatus] = g.split('|');

  if (!tok) {
    check(`${symbol} is in the allowlist, so the exit can be read`, false,
      `${symbol} is not listed, so the shares that left the wallet cannot be identified`);
  } else if (!exitRcpt) {
    nothingToCheck('the exit transaction produced no receipt to read, which section 2 has ' +
      'already reported — there is nothing here to prove custody from');
  } else if (!gQty) {
    check('the exit names the guard it came from', false,
      `neither executions.guard_id nor position_guards.triggered_decision_id ties a guard to ` +
      `decision ${decID}, so there is no protected quantity to compare the transfer against`);
  } else {
    const e = emptied(exitRcpt, tok, exitWallet, gQty);
    check('the exit sent the whole guarded position, not part of it', e.ok,
      `the guard protected ${gQty} ${symbol} (${e.want} base units) and the transaction moved ` +
      `${e.sent} out of ${exitWallet}. An exit that leaves a residue leaves something four ` +
      'different readers have to be taught to ignore');
    console.log(`      the transaction moved ${e.sent} base units of ${symbol} out of the wallet`);
  }

  // THE SNAPSHOT THE EXIT WROTE, identified by the exit's own timestamp rather
  // than by being the most recent one. The check's name always claimed this; the
  // query did not.
  const holdings = psql(`SELECT coalesce(ps.holdings::text,'{}') FROM portfolio_snapshots ps
                           JOIN portfolios p ON p.id = ps.portfolio_id
                          WHERE p.agent_id = '${agentID}' AND ps.ts = '${tat}'::timestamptz`);
  if (!holdings) {
    check('the exit wrote a portfolio snapshot', false,
      `no portfolio_snapshots row for this agent at ${tat}, so what the exit recorded cannot be read`);
  } else {
    check('the snapshot written by the exit carries no residue for it',
      !new RegExp(`"${symbol}"`).test(holdings), holdings.slice(0, 160));
  }

  check('and the guard that fired is no longer armed', gStatus !== 'armed',
    `the guard behind this exit is still status=${gStatus}`);
});

// --- 5. It went through the brakes ----------------------------------------
await section("It counted against the brakes, rather than going around them", async () => {
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
});

// --- 6. One intent, one transaction ---------------------------------------
await section("One crossing produced exactly one exit", async () => {
  const sells = psql(`SELECT count(*) FROM executions
                       WHERE agent_id = '${agentID}' AND intent_action = 'sell'
                         AND ts >= '${tat}'::timestamptz - interval '2 minutes'
                         AND ts <= '${tat}'::timestamptz + interval '5 minutes'`);
  check('exactly one sell was sent around the crossing', sells === '1', `${sells} sells`);
  // NOT "no armed guard on this symbol". The agent re-buys the symbols it sells,
  // and a guard armed over the NEW position is correct, not a leak — counting
  // those is what had this check failing on a perfectly clean exit. The guard
  // that fired is asserted in section 4; what belongs here is that the crossing
  // produced one sell, which is the claim this section is named for.
  const armedOlder = psql(`SELECT count(*) FROM position_guards
                            WHERE agent_id = '${agentID}' AND symbol = '${symbol}'
                              AND status = 'armed' AND set_at < '${tat}'::timestamptz`);
  check('no guard armed BEFORE the exit is still armed over the position it closed',
    armedOlder === '0',
    `${armedOlder} guard(s) on ${symbol} armed before ${tat} are still armed, so the exit left ` +
    'a watcher over a position it had already closed');
});

const code = report();
if (code !== 0) process.exit(code);
console.log(`guard-chain-verify: guard ${gid} fired on a real crossing and the record holds up.`);
