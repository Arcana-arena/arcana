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
import { suite } from './lib/sections.mjs';

const REPO = process.env.REPO || '/home/ubuntu/arcana';
const PG = process.env.PG_CONTAINER || 'arcana-postgres';
const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:3001';
const RPC = process.env.EXECUTION_RPC_URL || 'https://robinhood-rpc.publicnode.com';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

// THE SYMBOL'S TOKEN ADDRESS COMES FROM THE ALLOWLIST.
//
// The first version read `token_out` off the execution row, which is the stock
// token on a BUY and the QUOTE token on a SELL — so the moment the newest
// fan-out happened to be a sell, the custody check compared the book's AMZN
// holding against a USDG balance and reported a discrepancy that did not exist.
// The symbol is the constant; the side of the trade is not.
// PARSED ONCE, AND A MISSING SYMBOL IS A FAILED CHECK RATHER THAN A DEAD RUN.
// The first version re-read and re-parsed the file on every call — once per
// subscriber inside section 5 — and threw when a symbol was absent. Nothing
// catches that throw, so a token retired from the allowlist would kill the
// process mid-suite: sections 6, 7 and 8 would never run and the Failures
// summary would never print. A verification that cannot report is worse than
// one that reports a failure.
const ALLOWLIST = JSON.parse(readFileSync(
  process.env.EXECUTION_ALLOWLIST_FILE ||
  `${REPO}/services/signer/allowlist/robinhood-mainnet.json`, 'utf8'));
const tokenOf = (sym) => (ALLOWLIST.tokens || []).find((x) => x.symbol === sym) || null;
const QUOTE_DECIMALS = (ALLOWLIST.quote_token && ALLOWLIST.quote_token.decimals) || 6;

// The dust floor in base units: a hundredth of a millionth of a share, at
// whatever precision the token is actually denominated in. NOT hardcoded to 18
// decimals — the quote token in this same allowlist is 6, so the day a listed
// stock token is not 18 a residue of ten thousand shares would read as empty.
// guard-chain-verify already derives it this way.
const dustFloor = (tok) => 10n ** BigInt(tok.decimals - 8);

// keccak256('Transfer(address,address,uint256)')
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const env = Object.fromEntries(
  readFileSync(`${REPO}/.env.auth`, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

// THE COUNTERS, THE CHECK HELPER AND THE SUMMARY NOW COME FROM lib/sections.mjs,
// which adds the one thing this file could not do for itself: a section that
// runs no checks and does not say why FAILS, rather than printing its header
// and moving on. Section 3 did exactly that, inside a run that reported
// 38 pass, 0 fail.
const { check, section, nothingToCheck, notYet, report } = suite('subscription-chain-verify');
const psql = (s) => execFileSync('docker', ['exec', PG, 'psql', '-U', 'arcana', '-d', 'arcana', '-tAc', s],
  { encoding: 'utf8' }).trim();
const one = (s) => psql(s).split(/\r?\n/)[0].trim();
// AN RPC FAILURE IS NOT AN ANSWER.
//
// This returned `(await r.json()).result`, which is `undefined` the moment the
// node replies with an error — and undefined then flowed into
// `BigInt(x || '0x0')` = 0n, which read as "the wallet holds nothing" and
// PASSED the custody claim. That is precisely the failure mode this file's own
// header refuses: reporting success because no data came back. Section 5 got
// away with it only because zero there degrades into a discrepancy and fails.
//
// `result: null` is a different thing and is preserved: it is a real answer,
// the node saying it does not know that transaction.
class RpcError extends Error {
  constructor(method, message, code) {
    super(`${method}: ${message}`);
    this.code = code;
  }
}
const rpc = async (method, params) => {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!r.ok) throw new RpcError(method, `HTTP ${r.status} from ${RPC}`, r.status);
  const j = await r.json();
  if (j.error) throw new RpcError(method, j.error.message || JSON.stringify(j.error), j.error.code);
  if (!('result' in j)) throw new RpcError(method, 'a reply carrying neither result nor error');
  return j.result;
};

// A balance nobody could read is not a balance of zero. The empty-wallet case is
// refused here too: ''.slice(2) padded is balanceOf(0x0), which answers 0 and
// would have read as an emptied position.
const balanceOf = async (token, wallet, block = 'latest') => {
  if (!/^0x[0-9a-f]{40}$/i.test(wallet || '')) {
    throw new Error(`${JSON.stringify(wallet)} is not an address, and balanceOf(0x0) answers 0`);
  }
  const hex = await rpc('eth_call',
    [{ to: token, data: '0x70a08231' + wallet.slice(2).toLowerCase().padStart(64, '0') }, block]);
  if (typeof hex !== 'string' || !/^0x[0-9a-f]*$/i.test(hex)) {
    throw new RpcError('eth_call', `balanceOf answered ${JSON.stringify(hex)}`);
  }
  return BigInt(hex === '0x' ? '0x0' : hex);
};

// A chain read that could not be performed becomes a FAILED CHECK rather than an
// exception. An uncaught throw kills the run before the summary prints, and the
// summary is the only part anybody reads. Returns undefined when the read failed
// — distinct from null, which is the node's own answer.
const chainRead = async (what, fn) => {
  try {
    return await fn();
  } catch (e) {
    check(what, false, `the chain could not be read: ${e.message}`);
    return undefined;
  }
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
//
// Section 1 reads the rows every later section works from, so these three are
// declared out here rather than inside it.
let swaps, creator, subscriber;
await section("One decision reached more than one wallet", async () => {
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

  swaps = rows.filter((r) => r.intent === action);
  creator = swaps.filter((r) => r.behalf === 'creator');
  subscriber = swaps.filter((r) => r.behalf === 'subscriber');

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
});

// --- 2. The transactions are real ------------------------------------------
await section("Each leg is a transaction on chain, in its own wallet", async () => {
  for (const r of swaps.filter((x) => x.status === 'mined')) {
    const hashOK = /^0x[0-9a-f]{64}$/.test(r.tx);
    check(`${r.behalf} leg ${r.id} carries a transaction hash`, hashOK, r.tx);
    // Nothing is asked of the node without a hash to ask it about.
    if (!hashOK) continue;
    const rcpt = await chainRead(`${r.behalf} leg ${r.id} is a real receipt`,
      () => rpc('eth_getTransactionReceipt', [r.tx]));
    if (rcpt === undefined) continue;
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
});

// --- 3. The sizes are each wallet's own ------------------------------------
await section("Each wallet sized the position against its own book", async () => {
  // THE MINED LEGS, NOT THE FIRST LEGS. This asked for creator[0] and
  // subscriber[0] and required both to be 'mined'. On the very decision it was
  // written for, subscriber[0] was a BLOCKED leg — a wallet correctly refused
  // for want of capital — so the condition was false, the body was stepped over,
  // and the section printed its header and nothing else while a mined subscriber
  // leg sat one row behind it. The data was there; the wrong row was asked.
  const cLeg = creator.find((r) => r.status === 'mined');
  const sLeg = subscriber.find((r) => r.status === 'mined');
  if (!cLeg || !sLeg) {
    nothingToCheck('this decision has no mined creator leg AND mined subscriber leg to compare, ' +
      'so there are no two sizes to hold against each other');
    return;
  }
  check('the two legs are different sizes',
    cLeg.amountIn !== sLeg.amountIn,
    `both spent ${cLeg.amountIn} base units. The creator chooses direction and each wallet ` +
    'sizes it against its OWN capital under its OWN limits — identical amounts would mean one ' +
    'profile was applied to both books');
  const q = 10 ** QUOTE_DECIMALS;
  console.log(`      creator spent ${(Number(cLeg.amountIn) / q).toFixed(6)} USDG, ` +
    `subscriber ${(Number(sLeg.amountIn) / q).toFixed(6)} USDG`);
});

// --- 4. A wallet that could not act was refused on its own ------------------
await section("A wallet that could not act was refused on its own, and recorded", async () => {
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
});

// --- 5. Custody reconciles in every wallet ---------------------------------
await section("Custody: what the record says each wallet holds is what it holds", async () => {
  const drift = one(`SELECT count(*) FROM custody_drift
                      WHERE agent_id = '${agentID}' AND detected_at > '${when}'::timestamptz`);
  check('no custody drift on the creator wallet since the decision', drift === '0',
    `${drift} drift row(s) after ${when}`);

  for (const r of subscriber.filter((x) => x.status === 'mined')) {
    const snap = one(`SELECT holdings::text FROM subscription_snapshots
                       WHERE subscription_id = '${r.sub}' ORDER BY ts DESC LIMIT 1`);
    const held = JSON.parse(snap || '{}')[symbol] || 0;
    const tok = tokenOf(symbol);
    if (!tok) {
      check(`${symbol} is in the allowlist, so a balance can be read for it`, false,
        `${symbol} is not listed, so there is no address to ask about its balance`);
      continue;
    }
    const units = await chainRead(`subscription ${r.sub.slice(0, 8)} holds what its book says`,
      () => balanceOf(tok.address, r.wallet));
    if (units === undefined) continue;
    const recorded = BigInt(Math.round(held * 10 ** tok.decimals));
    // A tenth of a percent, because the snapshot stores shares as a float and
    // the chain stores base units as an integer.
    const tol = recorded / 1000n + 1n;
    const diff = units > recorded ? units - recorded : recorded - units;
    check(`subscription ${r.sub.slice(0, 8)} holds what its book says`, diff <= tol,
      `the book says ${held} ${symbol} (${recorded} base units) and the wallet holds ${units}`);

    const cashRaw = await chainRead(`subscription ${r.sub.slice(0, 8)} cash reconciles`,
      () => balanceOf(USDG, r.wallet));
    if (cashRaw === undefined) continue;
    const cashUnits = Number(cashRaw) / 10 ** QUOTE_DECIMALS;
    const bookCash = Number(one(`SELECT cash::text FROM subscription_snapshots
                                  WHERE subscription_id = '${r.sub}' ORDER BY ts DESC LIMIT 1`));
    check(`subscription ${r.sub.slice(0, 8)} cash reconciles`, Math.abs(cashUnits - bookCash) < 0.01,
      `the book says $${bookCash} and the wallet holds $${cashUnits.toFixed(6)}`);
  }
});

// --- 6. The agent's record stayed the agent's ------------------------------
await section("The agent counted ONE decision, not one per wallet", async () => {
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
});

// --- 7. THE A/B: a customer's execution moves none of the agent's numbers ---
await section("A customer's execution moves no number the agent is judged on", async () => {
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
});

// --- 8. A LEVEL THAT FIRED IN A BUYER'S WALLET -----------------------------
//
// The last claim in the design with nothing on chain behind it: a stop or a
// target belonging to a SUBSCRIBER crossing, executing, and being recorded
// without touching the agent's competition record.
//
// IT IS NOT MANUFACTURED. Moving a level after the fact or faking a price would
// prove something about the fake — the same rule guard-chain-verify has always
// had. So this section reads what the watcher left behind, and when there is
// nothing it says so as a NOT-YET rather than passing on an empty result. A
// verification that reports success because it found no data is the failure
// this project keeps writing down.
await section("A protective level that fired in a buyer's wallet", async () => {
  // SCOPED TO THE AGENT UNDER REVIEW. Unscoped, a run given an explicit decision
  // id could pick an entirely unrelated agent's guard and fail on it while every
  // line of output above said "decision N" of this agent.
  const gid = one(
    `SELECT id FROM position_guards
      WHERE subscription_id IS NOT NULL AND status = 'triggered' AND agent_id = '${agentID}'
      ORDER BY triggered_at DESC LIMIT 1`);

  if (!gid) {
    console.log('  NOT YET  no subscriber guard of THIS agent has ever been triggered.');
    console.log('           Not a pass and not a failure. The mechanism is proved off chain');
    console.log('           (subscription-verify sections 5 and 6) and the ARMING is proved on');
    console.log('           chain above; what is missing is a market that crossed a level.');
    notYet(`no subscriber guard of agent ${agentID.slice(0, 8)} has been triggered on chain`);
  } else {
    const g = one(
      `SELECT subscription_id::text || '|' || symbol || '|' || coalesce(triggered_side,'') || '|' ||
              coalesce(triggered_price::text,'') || '|' || coalesce(triggered_decision_id::text,'') || '|' ||
              entry_price::text || '|' || entry_qty::text
         FROM position_guards WHERE id = ${gid}`).split('|');
    const [gsub, gsym, gside, gprice, gdec, gentry, gqty] = g;
    console.log(`  guard ${gid}: ${gside} on ${gsym} at ${gprice} (entry ${gentry}) for ${gsub.slice(0, 8)}`);

    check('it names which level fired', gside === 'stop_loss' || gside === 'take_profit', gside);
    check('and the price that crossed it', Number(gprice) > 0, gprice);

    // THE ONE THAT MATTERS MOST. A subscriber's protective exit must write NO
    // row in `decisions`: that table is the agent's competition record, and a
    // stop firing in one buyer's wallet at a price only that wallet crossed is
    // not something the agent decided.
    check('it wrote NO decision row', gdec === '',
      `the guard points at decision ${gdec}. A buyer's stop counted as one of the agent's ` +
      'decisions would inflate its record by the size of its customer list');

    const ex = one(
      `SELECT id || '|' || status || '|' || coalesce(tx_hash,'') || '|' || coalesce(on_behalf_of,'') || '|' ||
              coalesce(wallet,'') || '|' || coalesce(decision_id::text,'') || '|' ||
              coalesce(filled_out::text,'') || '|' || coalesce(slippage_bps::text,'') || '|' ||
              coalesce(subscription_id::text,'')
         FROM executions WHERE guard_id = ${gid} AND intent_action = 'sell' ORDER BY id DESC LIMIT 1`);
    check('an execution names the guard that caused it', !!ex,
      `no execution carries guard_id = ${gid}. The level is the only record of what decided, so ` +
      'an exit that cannot be traced back to it has lost its author');

    if (ex) {
      const [eid, estatus, etx, ebehalf, ewallet, edec, efill, eslip, esub] = ex.split('|');
      check('the exit was mined', estatus === 'mined', estatus);
      check('it is attributed to the subscriber', ebehalf === 'subscriber', ebehalf);
      check('in the subscription that owned the level', esub === gsub, `${esub} vs ${gsub}`);
      check('and carries no decision id', edec === '', `decision_id=${edec}`);
      check('it records its own fill and slippage', efill !== '' && eslip !== '', `${efill} / ${eslip}`);

      // THE RECEIPT IS ONLY ASKED FOR WHEN THERE IS A TRANSACTION TO ASK ABOUT.
      // An exit that did not mine carries an empty tx_hash, and
      // eth_getTransactionReceipt('') made the node error, left rcpt undefined,
      // skipped the sender check in silence and logged one confusing extra
      // failure that named nothing.
      const mined = estatus === 'mined' && /^0x[0-9a-f]{64}$/.test(etx);
      if (!mined) {
        check('the exit has a transaction to read back', false,
          `status=${estatus}, tx_hash=${etx || '(empty)'} — there is nothing on chain to verify yet`);
      } else {
        const rcpt = await chainRead('the transaction is real and succeeded',
          () => rpc('eth_getTransactionReceipt', [etx]));
        if (rcpt !== undefined) {
          check('the transaction is real and succeeded', !!rcpt && rcpt.status === '0x1', etx);
        }
        if (rcpt) {
          check('and was sent by the buyer\'s own wallet',
            rcpt.from.toLowerCase() === ewallet.toLowerCase(),
            `the receipt says ${rcpt.from}, the row says ${ewallet}`);

          // CUSTODY, PROVED FROM THE EXIT ITSELF RATHER THAN FROM A LATER BALANCE.
          //
          // This used to read the wallet's balance at 'latest' and assert it was
          // dust. Two things were wrong with that, and the second cannot be fixed
          // the obvious way.
          //
          // The fan-out re-buys the same symbols into the same wallet, and the
          // guard picked here is the most recent triggered one, which may be days
          // old — so any re-entry since made a perfectly clean exit read as
          // trimmed. And it cannot be repaired by reading at the exit's own
          // block: this endpoint refuses historical state outright ("Archive
          // requests require a personal token"), five hundred blocks back as
          // surely as two hundred thousand. Measured, not assumed.
          //
          // The transaction's own Transfer logs need no archive and are better
          // evidence anyway. They say what left the wallet; the guard says how
          // much was being guarded. Emptied means those are the same number.
          const tok = tokenOf(gsym);
          if (!tok) {
            check(`${gsym} is in the allowlist, so the exit can be read`, false,
              `${gsym} is not listed, so the shares that left the wallet cannot be identified`);
          } else {
            const from = '0x' + ewallet.slice(2).toLowerCase().padStart(64, '0');
            const sent = (rcpt.logs || [])
              .filter((l) => (l.address || '').toLowerCase() === tok.address.toLowerCase() &&
                             (l.topics || [])[0] === TRANSFER &&
                             ((l.topics || [])[1] || '').toLowerCase() === from)
              .reduce((a, l) => a + BigInt(l.data), 0n);
            const guarded = BigInt(Math.round(Number(gqty) * 10 ** tok.decimals));
            const tol = guarded / 1000n + dustFloor(tok);
            const diff = sent > guarded ? sent - guarded : guarded - sent;
            check('the exit sent the whole guarded position, not part of it',
              sent > 0n && diff <= tol,
              `the guard was on ${gqty} ${gsym} (${guarded} base units) and the transaction moved ` +
              `${sent} out of the wallet. An exit that leaves a residue leaves something four ` +
              'different readers have to be taught to ignore');
          }
        }
      }

      // THERE IS DELIBERATELY NO CHECK HERE that the agent recorded no decision
      // in a window around the exit. One was written and then removed, and the
      // reason belongs next to the gap so it is not written again.
      //
      // The claim it reached for — a buyer's protective exit is not one of the
      // agent's decisions — is already proved twice above, exactly, and without
      // reference to any clock: the guard carries no triggered_decision_id, and
      // the execution carries no decision_id. Those are the record itself.
      //
      // A time window could only ever measure something else: whether the agent
      // happened to tick nearby. persist() writes a decisions row on EVERY tick
      // including a hold — 69 of this agent's 84 decisions are holds — and the
      // guard scanner runs every fifteen seconds against a cadence floor of one
      // minute, so the scanner normally fires BETWEEN ticks.
      //
      // Measured on the live database rather than reasoned about: the median gap
      // between consecutive decisions is 15 seconds, 61 of 83 gaps are under a
      // minute, and 62 of 84 decisions already have another decision inside
      // their own ±30s window. And the check was run against a trigger placed
      // ten seconds after a real decision — what the scanner firing between two
      // ticks looks like — where it duly reported "1 decision row(s) sit within
      // 30 seconds of the trigger" and exited 1 with nothing whatsoever wrong.
      //
      // It is not certain to fail, which is worse than certain: it fails
      // whenever the agent happens to be trading, which is when a stop fires.
      //
      // That is the worst of the three kinds. A check that cannot pass is as
      // useless as one that cannot fail, and one that destroys the evidence it
      // exists to capture — turning the first real firing into a red suite
      // instead of a record — is worse than both.
    }
  }
});

const code = report();
if (code !== 0) process.exit(code);
console.log('subscription-chain-verify: one decision, several wallets, one record each.');
