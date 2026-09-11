/**
 * subscription-chain-verify.mjs — check a fan-out that really happened.
 *
 * WHAT THIS IS FOR. subscription-verify proves the mechanism without the chain:
 * who is traded for, who is not, what a buyer can reach, whose wallet a level
 * watches. This one reads the record of ONE decision that reached SEVERAL
 * wallets and checks that every claim the design makes about it is true of the
 * rows — and true of the transactions, read back from the node rather than from
 * the database that claims them.
 *
 * IT DOES NOT CAUSE THE FAN-OUT. Same rule as guard-chain-verify: manufacturing
 * the event would prove something about the manufacture. Run it with no
 * arguments to check the most recent decision that reached more than one wallet,
 * or pass a decision id.
 *
 * It REFUSES rather than passes when there is nothing to check. A verification
 * that reports success because it found no data is the failure this project
 * keeps writing down.
 *
 * THE HARDEST CLAIM IS THE LAST SECTION. "A subscriber's execution does not
 * move the agent's score, DNA or Autopsy" cannot be proved by comparing before
 * and after a tick — the tick itself adds a decision, which legitimately moves
 * them. So it is proved by an A/B: add one more subscriber execution row,
 * recompute all three, compare every number, and remove the row again. If any
 * reader counted customer executions, that row would move it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REPO = process.env.REPO || '/home/ubuntu/arcana';
const PG = process.env.PG_CONTAINER || 'arcana-postgres';
const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const RPC = process.env.EXECUTION_RPC_URL || 'https://robinhood-rpc.publicnode.com';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

const env = Object.fromEntries(
  readFileSync(`${REPO}/.env.auth`, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

let pass = 0, fail = 0;
const failures = [];
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; failures.push(`${n} — ${d}`); console.log(`  FAIL  ${n} — ${d}`); }
};
const psql = (s) => execFileSync('docker', ['exec', PG, 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc', s],
  { encoding: 'utf8' }).trim();
const one = (s) => psql(s).split(/\r?\n/)[0].trim();
const rpc = async (method, params) => {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await r.json()).result;
};

// THE SUBJECT IS THE DECISION. One decision, N executions: that is the whole
// shape of the thing, so the decision is what this is keyed on.
const want = process.argv[2];
const decID = want || one(
  `SELECT decision_id FROM executions
    WHERE subscription_id IS NOT NULL AND decision_id IS NOT NULL AND status = 'mined'
    ORDER BY id DESC LIMIT 1`);

if (!decID) {
  console.log('subscription-chain-verify: NO FAN-OUT TO CHECK.');
  console.log('This is not a pass. A subscription has to be funded and a decision has to reach it.');
  process.exit(2);
}

const drow = one(`SELECT agent_id || '|' || coalesce(symbol,'') || '|' || coalesce(action,'') || '|' ||
                         coalesce(decider,'') || '|' || ts::text
                    FROM decisions WHERE id = ${decID}`);
const [agentID, symbol, action, decider, when] = drow.split('|');
console.log(`=== decision ${decID}: ${decider} ${action} ${symbol} at ${when} ===\n`);

// --- 1. One decision, several wallets --------------------------------------
console.log('=== One decision reached more than one wallet ===');
const rows = psql(
  `SELECT id || '|' || coalesce(on_behalf_of,'') || '|' || coalesce(wallet,'') || '|' ||
          coalesce(subscription_id::text,'') || '|' || status || '|' || coalesce(tx_hash,'') || '|' ||
          coalesce(amount_in::text,'') || '|' || coalesce(filled_out::text,'') || '|' ||
          coalesce(slippage_bps::text,'') || '|' || coalesce(gas_cost_usd::text,'') || '|' ||
          coalesce(pool_fee_usd::text,'') || '|' || intent_action
     FROM executions WHERE decision_id = ${decID} ORDER BY id`)
  .split(/\r?\n/).filter(Boolean)
  .map((l) => {
    const [id, behalf, wallet, sub, status, tx, amountIn, filled, slip, gas, fee, intent] = l.split('|');
    return { id, behalf, wallet, sub, status, tx, amountIn, filled, slip, gas, fee, intent };
  });

const swaps = rows.filter((r) => r.intent === action);
const creator = swaps.filter((r) => r.behalf === 'creator');
const subscriber = swaps.filter((r) => r.behalf === 'subscriber');

check('there is exactly one creator leg', creator.length === 1,
  `${creator.length} rows say on_behalf_of='creator'`);
check('and at least one subscriber leg', subscriber.length >= 1,
  'no execution row names a subscriber. One decision reaching one wallet is not a fan-out');
check('every execution says whose funds moved',
  swaps.every((r) => r.behalf === 'creator' || r.behalf === 'subscriber'),
  `one or more rows have no on_behalf_of: ${swaps.filter((r) => !r.behalf).map((r) => r.id).join(', ')}`);
check('every execution names the wallet it moved funds in',
  swaps.every((r) => /^0x[0-9a-f]{40}$/i.test(r.wallet)),
  'a row that cannot name its own account is one nobody can reconcile against a balance');
check('the creator leg carries no subscription id', creator[0] && creator[0].sub === '',
  `creator row ${creator[0] && creator[0].id} has subscription_id=${creator[0] && creator[0].sub}`);
check('every subscriber leg carries one', subscriber.every((r) => r.sub !== ''),
  'a subscriber execution with no subscription id belongs to nobody');

const wallets = new Set(swaps.map((r) => r.wallet.toLowerCase()));
check('the wallets are different addresses', wallets.size === swaps.length,
  `${swaps.length} legs across ${wallets.size} distinct wallets — two legs in one account is not a fan-out`);

// --- 2. The transactions are real ------------------------------------------
console.log('\n=== Each leg is a transaction on chain, in its own wallet ===');
for (const r of swaps.filter((x) => x.status === 'mined')) {
  check(`${r.behalf} leg ${r.id} carries a transaction hash`, /^0x[0-9a-f]{64}$/.test(r.tx), r.tx);
  const rcpt = await rpc('eth_getTransactionReceipt', [r.tx]);
  check(`${r.behalf} leg ${r.id} is a real receipt`, !!rcpt, 'the node does not know this transaction');
  if (!rcpt) continue;
  check(`${r.behalf} leg ${r.id} succeeded on chain`, rcpt.status === '0x1', `status ${rcpt.status}`);
  check(`${r.behalf} leg ${r.id} was sent BY the wallet the row names`,
    rcpt.from.toLowerCase() === r.wallet.toLowerCase(),
    `the receipt says ${rcpt.from}, the row says ${r.wallet}. A row naming the wrong account is ` +
    'worse than one naming none');
  check(`${r.behalf} leg ${r.id} records its own fill`,
    r.filled !== '' && BigInt(r.filled) > 0n, `filled_out=${r.filled}`);
  check(`${r.behalf} leg ${r.id} records its own slippage`, r.slip !== '', `slippage_bps=${r.slip}`);
  check(`${r.behalf} leg ${r.id} records its own gas`, Number(r.gas) > 0, `gas_cost_usd=${r.gas}`);
}

// Each wallet paid its OWN gas: the receipts' senders are the wallets, checked
// above, and this states the corollary rather than leaving it implied.
const gasPayers = new Set(swaps.filter((r) => r.status === 'mined').map((r) => r.wallet.toLowerCase()));
check('no wallet paid another wallet\'s gas', gasPayers.size === swaps.filter((r) => r.status === 'mined').length,
  'two mined legs share a sender');

// --- 3. The sizes are each wallet's own ------------------------------------
console.log('\n=== Each wallet sized the position against its own book ===');
if (creator[0] && subscriber[0] && creator[0].status === 'mined' && subscriber[0].status === 'mined') {
  check('the two legs are different sizes',
    creator[0].amountIn !== subscriber[0].amountIn,
    `both spent ${creator[0].amountIn} base units. The creator chooses direction and each wallet ` +
    'sizes it against its OWN capital under its OWN limits — identical amounts would mean one ' +
    'profile was applied to both books');
  console.log(`      creator spent ${(Number(creator[0].amountIn) / 1e6).toFixed(6)} USDG, ` +
    `subscriber ${(Number(subscriber[0].amountIn) / 1e6).toFixed(6)} USDG`);
}

// --- 4. A wallet that could not act was refused on its own ------------------
console.log('\n=== A wallet that could not act was refused on its own, and recorded ===');
{
  const blocked = psql(
    `SELECT coalesce(subscription_id::text,'') || '|' || coalesce(refusal_code,'') || '|' ||
            coalesce(left(note, 120),'')
       FROM executions
      WHERE agent_id = '${agentID}' AND subscription_id IS NOT NULL AND status = 'blocked'
      ORDER BY id DESC LIMIT 5`).split(/\r?\n/).filter(Boolean);
  check('at least one wallet has a recorded refusal of its own', blocked.length > 0,
    'every subscriber succeeded, so this section proves nothing. Fund one wallet and leave ' +
    'another empty, then run a tick: the empty one must produce a ROW, not just a log line');
  for (const b of blocked.slice(0, 3)) {
    const [sub, code, note] = b.split('|');
    check(`refusal for ${sub.slice(0, 8)} names a reason`, code !== '' || note !== '',
      'a blocked row with neither a code nor a note says only that something went wrong');
    console.log(`      ${sub.slice(0, 8)}: ${code || '(no code)'} — ${note}`);
  }
  check('a refused wallet did not stop the others',
    subscriber.some((r) => r.status === 'mined'),
    'no subscriber leg mined on this decision, so "one wallet failing does not fail the others" ' +
    'is untested here');
}

// --- 5. Custody reconciles in every wallet ---------------------------------
console.log('\n=== Custody: what the record says each wallet holds is what it holds ===');
{
  const drift = one(`SELECT count(*) FROM custody_drift
                      WHERE agent_id = '${agentID}' AND detected_at > '${when}'::timestamptz`);
  check('no custody drift on the creator wallet since the decision', drift === '0',
    `${drift} drift row(s) after ${when}`);

  for (const r of subscriber.filter((x) => x.status === 'mined')) {
    const snap = one(`SELECT holdings::text FROM subscription_snapshots
                       WHERE subscription_id = '${r.sub}' ORDER BY ts DESC LIMIT 1`);
    const held = JSON.parse(snap || '{}')[symbol] || 0;
    const tok = one(`SELECT coalesce(token_out,'') FROM executions WHERE id = ${r.id}`);
    const onChain = await rpc('eth_call',
      [{ to: tok, data: '0x70a08231' + r.wallet.slice(2).toLowerCase().padStart(64, '0') }, 'latest']);
    const units = BigInt(onChain || '0x0');
    const recorded = BigInt(Math.round(held * 1e18));
    // A tenth of a percent, because the snapshot stores shares as a float and
    // the chain stores base units as an integer.
    const tol = recorded / 1000n + 1n;
    const diff = units > recorded ? units - recorded : recorded - units;
    check(`subscription ${r.sub.slice(0, 8)} holds what its book says`, diff <= tol,
      `the book says ${held} ${symbol} (${recorded} base units) and the wallet holds ${units}`);

    const cashHex = await rpc('eth_call',
      [{ to: USDG, data: '0x70a08231' + r.wallet.slice(2).toLowerCase().padStart(64, '0') }, 'latest']);
    const cashUnits = Number(BigInt(cashHex || '0x0')) / 1e6;
    const bookCash = Number(one(`SELECT cash::text FROM subscription_snapshots
                                  WHERE subscription_id = '${r.sub}' ORDER BY ts DESC LIMIT 1`));
    check(`subscription ${r.sub.slice(0, 8)} cash reconciles`, Math.abs(cashUnits - bookCash) < 0.01,
      `the book says $${bookCash} and the wallet holds $${cashUnits.toFixed(6)}`);
  }
}

// --- 6. The agent's record stayed the agent's ------------------------------
console.log('\n=== The agent counted ONE decision, not one per wallet ===');
{
  const decisions = one(`SELECT count(*) FROM decisions WHERE agent_id = '${agentID}' AND ts = '${when}'::timestamptz`);
  check('one decision row for this tick', decisions === '1',
    `${decisions} decision rows share this timestamp — the record would count an agent's customers ` +
    'as its judgement');
  const snaps = one(`SELECT count(*) FROM portfolio_snapshots ps JOIN portfolios p ON p.id = ps.portfolio_id
                      WHERE p.agent_id = '${agentID}' AND ps.ts = '${when}'::timestamptz`);
  check('one portfolio snapshot, the creator\'s', snaps === '1', `${snaps} snapshots at ${when}`);
  const subSnaps = one(`SELECT count(*) FROM subscription_snapshots WHERE decision_id = ${decID}`);
  check('and each buyer\'s book was marked separately', Number(subSnaps) >= 1,
    `${subSnaps} subscription snapshots for this decision`);
  const leaked = one(`SELECT count(*) FROM portfolio_snapshots ps JOIN portfolios p ON p.id = ps.portfolio_id
                       WHERE p.agent_id = '${agentID}' AND ps.holdings::text LIKE '%${subscriber[0] ? subscriber[0].wallet : 'nothing'}%'`);
  check('no subscriber wallet appears in the agent\'s NAV series', leaked === '0', leaked);
}

// --- 7. THE A/B: a customer's execution moves none of the agent's numbers ---
console.log('\n=== A customer\'s execution moves no number the agent is judged on ===');
{
  const KEY = env.INTERNAL_API_KEY;
  const recompute = async () => {
    await fetch(`${AGENT}/internal/v1/agents/dna/compute`, {
      method: 'POST', headers: { 'X-Internal-Key': KEY },
    });
    const out = {};
    for (const what of ['dna', 'autopsy', 'passport']) {
      const r = await fetch(`${AGENT}/v1/agents/${agentID}/${what}`);
      out[what] = await r.json();
    }
    return out;
  };
  // Timestamps move on every recompute and are not numbers anybody is judged
  // on. Everything else must be identical.
  const strip = (v) => JSON.stringify(v, (k, val) =>
    (k === 'computed_at' || k === 'generated_at' || k === 'as_of' ? undefined : val));

  const MARK = 'subscription-chain-verify A/B row';
  const sub0 = subscriber[0] && subscriber[0].sub;
  if (!sub0) {
    check('there is a subscription to run the A/B with', false, 'no subscriber leg on this decision');
  } else {
    const v1 = await recompute();
    try {
      psql(`INSERT INTO executions (agent_id, subscription_id, ts, intent_action, symbol,
                                    token_in, token_out, amount_in, filled_out, slippage_bps,
                                    status, gas_cost_wei, gas_cost_usd, pool_fee_usd,
                                    wallet, on_behalf_of, note)
            VALUES ('${agentID}', '${sub0}', now(), 'buy', '${symbol}', '0xa', '0xb',
                    5000000, 9900000000000000, 42.5, 'mined', '30000000000000', 0.099, 0.015,
                    '${subscriber[0].wallet}', 'subscriber', '${MARK}')`);
      const v2 = await recompute();
      for (const what of ['dna', 'autopsy', 'passport']) {
        check(`${what} is unchanged by a customer's execution`,
          strip(v1[what]) === strip(v2[what]),
          'a customer execution moved a number the agent is judged on. An agent whose score ' +
          'changed because it gained customers would be measuring its sales, not its trading');
      }
    } finally {
      psql(`DELETE FROM executions WHERE note = '${MARK}'`);
    }
    const left = one(`SELECT count(*) FROM executions WHERE note = '${MARK}'`);
    check('the A/B row was removed again', left === '0',
      `${left} synthetic row(s) survived. A verification that leaves fixtures behind has changed ` +
      'the thing it measured');
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('subscription-chain-verify: one decision, several wallets, one record each.');
