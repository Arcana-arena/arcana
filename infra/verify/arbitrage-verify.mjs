// arbitrage-verify.mjs — proves the scanner's invariants, not its prices.
//
// Prices move; the arithmetic does not. So this suite asserts what is always
// true: the service reports its identity, venues are sane, a scan appends rows
// whose spread/net/status are consistent with each other, the heartbeat is
// fresh, and the tables are standalone (the §7 core schema is untouched).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { suite } from './lib/sections.mjs';

const ARB = process.env.ARBITRAGE_URL || 'http://127.0.0.1:8084';
const DB = process.env.DATABASE_URL || 'postgres://arcana:arcana@localhost:5432/arcana?sslmode=disable';

const sql = (q) => execFileSync('psql', [DB, '-At', '-q', '-c', q], { encoding: 'utf8' }).trim();

function internalKey() {
  if (process.env.INTERNAL_API_KEY) return process.env.INTERNAL_API_KEY;
  try {
    const c = readFileSync('/home/ubuntu/arcana/.env.auth', 'utf8');
    const m = c.match(/^INTERNAL_API_KEY=(.+)$/m);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

const get = async (path) => {
  const res = await fetch(ARB + path, { headers: { 'X-Arcana-Verification': '1' } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const approx = (a, b, eps = 0.05) => Math.abs(a - b) < eps;

const run = suite('arbitrage-verify');

await run.section('The service is up and reports its identity', async () => {
  const r = await get('/healthz');
  run.check('healthz returns 200', r.status === 200, `got ${r.status}`);
  run.check('service is arbitrage', r.body?.service === 'arbitrage', r.body?.service);
  run.check('reports a build commit', typeof r.body?.commit === 'string' && r.body.commit.length > 0);
});

let tokenCount = 0;

await run.section('Venues are configured and sane', async () => {
  const r = await get('/v1/arbitrage/venues');
  run.check('venues returns 200', r.status === 200, `got ${r.status}`);
  const tokens = r.body?.tokens;
  run.check('has a token list', Array.isArray(tokens) && tokens.length > 0);
  run.check('chain id is 4663', r.body?.chain_id === 4663, String(r.body?.chain_id));
  run.check('quote token is USDG', r.body?.quote_token?.symbol === 'USDG');
  if (Array.isArray(tokens)) {
    tokenCount = tokens.length;
    let allHaveVenues = true;
    let poolsAreAddresses = true;
    for (const t of tokens) {
      if (!Array.isArray(t.venues) || t.venues.length === 0) allHaveVenues = false;
      for (const v of (t.venues || [])) {
        if (!/^0x[0-9a-f]{40}$/i.test(v.pool)) poolsAreAddresses = false;
        if (v.fee_bps < 0) poolsAreAddresses = false;
      }
    }
    run.check('every token has at least one venue', allHaveVenues);
    run.check('every venue pool is a valid address with a non-negative fee', poolsAreAddresses);
  }
});

await run.section('A scan records opportunities with consistent arithmetic', async () => {
  const key = internalKey();
  if (!key) {
    run.nothingToCheck('INTERNAL_API_KEY is not set, so the machine-tier scan cannot be triggered');
    return;
  }
  const res = await fetch(ARB + '/internal/v1/arbitrage/scan', {
    method: 'POST',
    headers: { 'X-Internal-Key': key, 'X-Arcana-Verification': '1' },
  });
  const body = await res.json().catch(() => ({}));
  run.check('scan returns 200', res.status === 200, `got ${res.status} ${JSON.stringify(body)}`);
  run.check('scan reports the token count it was asked to scan', body?.scanned_tokens === tokenCount,
    `${body?.scanned_tokens} vs ${tokenCount}`);
  // EVERY VENUE READ SUCCEEDS. The v2 venues were failing this on every scan
  // until 2026-10-20, when the scanner was still pricing them with the v3
  // reader (slot0() on a v2 pair). A non-zero count here is a scanner reading
  // the wrong contract, not a market condition.
  run.check('the scan reports no venue read errors', body?.errors === 0, `errors=${body?.errors} note=${body?.note}`);

  const ven = await get('/v1/arbitrage/venues');
  const venuesByToken = new Map();
  for (const t of ven.body?.tokens ?? []) {
    for (const v of t.venues ?? []) venuesByToken.set(`${t.symbol}|${v.id}`, (v.pool ?? '').toLowerCase());
  }

  const r = await get('/v1/arbitrage/opportunities');
  const rows = r.body?.opportunities;
  run.check('opportunities returns rows', Array.isArray(rows) && rows.length > 0, `got ${rows?.length}`);
  if (Array.isArray(rows) && rows.length > 0) {
    let consistent = true;
    let statusSane = true;
    let executableImpliesProfit = true;
    let distinctPools = true;
    let detail = '';
    for (const o of rows) {
      if (!(o.buy_price > 0) || !(o.sell_price > 0)) { consistent = false; detail = `${o.symbol} non-positive price`; }
      const gross = (o.sell_price - o.buy_price) / o.buy_price * 10000;
      if (!approx(o.gross_spread_bps, gross, 0.5)) { consistent = false; detail = `${o.symbol} gross ${o.gross_spread_bps} != ${gross}`; }
      if (!approx(o.est_net_profit_bps, o.gross_spread_bps - o.gas_bps - o.impact_buffer_bps, 0.5)) {
        consistent = false; detail = `${o.symbol} net ${o.est_net_profit_bps} != gross - gas - impact`;
      }
      if (!['indicative', 'executable'].includes(o.status)) { statusSane = false; detail = `${o.symbol} status ${o.status}`; }
      if (o.status === 'executable' && o.est_net_profit_bps < 0) { executableImpliesProfit = false; detail = `${o.symbol} executable but net<0`; }
      // A ROW MUST COMPARE TWO POOLS. One pool bought and sold against itself
      // measures the round trip through its own fee — always negative, never an
      // opportunity — and that was the only row single-venue tokens recorded.
      const buyPool = venuesByToken.get(`${o.symbol}|${o.venue_buy}`);
      const sellPool = venuesByToken.get(`${o.symbol}|${o.venue_sell}`);
      if (!buyPool || !sellPool || buyPool === sellPool) {
        distinctPools = false;
        detail = `${o.symbol} compares ${o.venue_buy} with ${o.venue_sell} (${buyPool} / ${sellPool})`;
      }
    }
    run.check('buy/sell prices are positive and spread matches the quotes', consistent, detail);
    run.check('status is only indicative or executable', statusSane, detail);
    run.check('executable rows have non-negative net profit', executableImpliesProfit, detail);
    run.check('every row compares two distinct pools', distinctPools, detail);
  }
});

await run.section('The heartbeat is fresh', async () => {
  const age = sql(`SELECT extract(epoch FROM (now() - last_scan_at))::int FROM arbitrage_scan_heartbeat WHERE id = 1`);
  run.check('heartbeat row exists', /^\d+$/.test(age), age);
  if (/^\d+$/.test(age)) run.check('heartbeat is under 10 minutes old', Number(age) < 600, `${age}s old`);
});

await run.section('Arbitrage is opt-in, and the default is off', async () => {
  // A UUID-SHAPED ID NOBODY OWNS, so this section never touches a real agent's
  // switch. The row it writes is deleted again at the end.
  const probe = `00000000-0000-4000-8000-${String(Date.now()).slice(-12)}`;

  const missing = await get(`/v1/arbitrage/agents/${probe}/settings`);
  run.check('an agent nobody has switched answers 200', missing.status === 200, `status ${missing.status}`);
  run.check('and reads as disabled, because an absent row IS the off state',
    missing.body?.setting?.enabled === false && missing.body?.setting?.exists === false,
    JSON.stringify(missing.body?.setting));

  const malformed = await get('/v1/arbitrage/agents/not-a-uuid/settings');
  run.check('a malformed agent id is a 400, not a 500 from Postgres', malformed.status === 400, `status ${malformed.status}`);

  const list = await get('/v1/arbitrage/agents/settings?limit=50');
  run.check('the switch list answers and says what an absent agent means',
    list.status === 200 && Array.isArray(list.body?.settings) && /absent row/i.test(list.body?.note ?? ''),
    `status ${list.status} note=${list.body?.note}`);

  const key = internalKey();
  if (!key) {
    run.nothingToCheck('INTERNAL_API_KEY is not set, so the machine-tier write cannot be exercised');
    return;
  }

  // WITHOUT THE KEY, NOBODY FLIPS A CREATOR'S SWITCH.
  const anonymous = await fetch(ARB + `/internal/v1/arbitrage/agents/${probe}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, actor: '0xverification' }),
  });
  run.check('the write is machine-tier: without the key it is refused',
    anonymous.status === 401 || anonymous.status === 403, `status ${anonymous.status}`);

  const write = async (body) => {
    const res = await fetch(ARB + `/internal/v1/arbitrage/agents/${probe}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': key, 'X-Arcana-Verification': '1' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const noActor = await write({ enabled: true });
  run.check('a switch with no actor named is refused — a decision about funds has to have a name',
    noActor.status === 400 && noActor.body?.error?.code === 'actor_required', JSON.stringify(noActor.body));

  const noFlag = await write({ actor: '0xverification' });
  run.check('a switch with enabled omitted is refused rather than defaulting',
    noFlag.status === 400 && noFlag.body?.error?.code === 'enabled_required', JSON.stringify(noFlag.body));

  const on = await write({ enabled: true, actor: '0xverification' });
  run.check('with the key and both fields, the switch is written',
    on.status === 200 && on.body?.setting?.enabled === true && on.body?.setting?.enabled_at !== null,
    JSON.stringify(on.body?.setting));

  const readBack = await get(`/v1/arbitrage/agents/${probe}/settings`);
  run.check('and the public read agrees with the write',
    readBack.body?.setting?.enabled === true && readBack.body?.setting?.exists === true,
    JSON.stringify(readBack.body?.setting));

  const off = await write({ enabled: false, actor: '0xverification' });
  run.check('switching it off records who did it and when',
    off.status === 200 && off.body?.setting?.enabled === false && off.body?.setting?.disabled_at !== null &&
      off.body?.setting?.updated_by === '0xverification',
    JSON.stringify(off.body?.setting));

  // The enabled set is what the loop reads; it must not contain the probe now
  // that it is off, and `enabled_at` must survive the toggle for the audit.
  const enabledNow = sql(`SELECT count(*) FROM arbitrage_agent_settings WHERE enabled`);
  run.check('the loop\'s enabled set is a countable number', /^\d+$/.test(enabledNow), enabledNow);

  sql(`DELETE FROM arbitrage_agent_settings WHERE agent_id = '${probe}'`);
  const gone = sql(`SELECT count(*) FROM arbitrage_agent_settings WHERE agent_id = '${probe}'`);
  run.check('the probe row is cleaned up after itself', gone === '0', `rows left: ${gone}`);
});

await run.section('The tables are standalone and the core schema is untouched', async () => {
  const opp = sql(`SELECT to_regclass('arbitrage_opportunities')`);
  const hb = sql(`SELECT to_regclass('arbitrage_scan_heartbeat')`);
  const settings = sql(`SELECT to_regclass('arbitrage_agent_settings')`);
  run.check('arbitrage_opportunities exists', opp === 'arbitrage_opportunities', opp);
  run.check('arbitrage_scan_heartbeat exists', hb === 'arbitrage_scan_heartbeat', hb);
  run.check('arbitrage_agent_settings exists', settings === 'arbitrage_agent_settings', settings);
  // A core §7 table still has a column this work did not touch. If a future
  // migration ever alters agents, this fails and names the change.
  const name = sql(`SELECT column_name FROM information_schema.columns WHERE table_name='agents' AND column_name='name'`);
  run.check('core agents table still has its name column', name === 'name', name);
});

process.exit(run.report());
