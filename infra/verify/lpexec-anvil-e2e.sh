#!/usr/bin/env bash
# lpexec-anvil-e2e.sh — prove the ARMED LP executor end to end, with real
# contracts and no real money.
#
# THE CHAIN IS A FORK OF ROBINHOOD CHAIN AT ITS CURRENT BLOCK. That matters: the
# NonfungiblePositionManager, USDG, the stock token and the pool are the REAL
# deployed contracts with their real state, so the transaction the executor
# signs is exercised against the bytecode it will meet in production — not
# against a mock that agrees with whatever this file believes.
#
# WHAT IT DOES, in order:
#   1. a scratch database, migrated to head (the real migrations);
#   2. anvil forked from the live chain, chain id 4663;
#   3. a test signer on a throwaway seed, real shipped allowlist, RPC = anvil;
#   4. fund the signer's derived wallet from the real pool (impersonated on the
#      fork) with USDG + the stock token, and gas;
#   5. SETUP: mint an out-of-range position owned by the agent — the same act
#      the owner performs by hand for the first real position. Its approvals
#      are set to exactly what that mint consumes, so the executor's own
#      approval path has to run;
#   6. a temporary arbitrage instance against the fork (no background loops);
#   7. a registry row + a `proposed` rebalance action, exactly the shapes the
#      loop writes — stamped by a creator who has NOT switched arbitrage on;
#  7b. the OPT-IN GATE at the executor: the armed run refuses that action, the
#      log says why, the wallet's nonce does not move, and the action stays
#      `proposed` (nothing was signed for a disabled agent);
#  7c. the OPT-IN GATE at the loop: one pass reads the chain, computes
#      `rebalance`, and supersedes the standing proposal instead of leaving it;
#  7d. the creator switches it on through the machine-tier endpoint (and the
#      same call without the key is refused), the next pass proposes a fresh
#      rebalance — the enabled path, proven on the same fork;
#   8. lpexec in PLAN mode: four intents, in the contract's order;
#   9. lpexec in EXECUTE mode: approve×2, decrease, collect, burn, mint —
#      signed by the signer, broadcast, receipts read, recorded;
#  10. the database: action executed, six steps mined, each with a tx hash;
#  11. the chain: the old NFT is gone, the new one exists, is owned by the
#      agent, has liquidity and is in range;
#  12. a second armed run: nothing left to execute, no second transaction.
#
# NOTHING HERE TOUCHES THE PRODUCTION SERVICES OR THE LIVE CHAIN'S STATE. The
# fork is a separate anvil process; the scratch database is dropped on exit.
#
# Usage: lpexec-anvil-e2e.sh   (no arguments; every address is the deployed one)
set -uo pipefail

export PATH="/home/ubuntu/.foundry/bin:$PATH"
REPO="${REPO:-/home/ubuntu/arcana}"
RPC_UP="${RPC_UP:-https://rpc.mainnet.chain.robinhood.com}"
ANVIL_PORT="${ANVIL_PORT:-8547}"
SIGNER_PORT="${SIGNER_PORT:-8093}"
ARB_PORT="${ARB_PORT:-8090}"
DB="${DB:-arcana_lpexec_e2e}"
PGADMIN="postgres://arcana:arcana@localhost:5432/postgres"
PGTEST="postgres://arcana:arcana@localhost:5432/${DB}"
ANVIL_URL="http://127.0.0.1:${ANVIL_PORT}"
SIGNER_URL="http://127.0.0.1:${SIGNER_PORT}"
ARB_URL="http://127.0.0.1:${ARB_PORT}"
KEY="e2e-internal-key"

NPM=0x73991a25c818bf1f1128deaab1492d45638de0d3
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
NVDA=0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
POOL=0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3 # NVDA/USDG 0.05%, holds both legs

AGENT="$(cat /proc/sys/kernel/random/uuid)"
WORK="$(mktemp -d)"
PIDS=""
PASS=0
FAIL=0
FAILURES=""

say() { echo; echo "== $* =="; }
ok()  { PASS=$((PASS+1)); echo "  PASS  $1"; }
no()  { FAIL=$((FAIL+1)); FAILURES="$FAILURES
  - $1 (${2:-})"; echo "  FAIL  $1 — ${2:-}"; }
lower() { echo "$1" | tr 'A-Z' 'a-z'; }

cleanup() {
  for p in $PIDS; do kill "$p" 2>/dev/null; done
  sleep 1
  psql "$PGADMIN" -q -c "DROP DATABASE IF EXISTS ${DB}" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- 1. scratch database ------------------------------------------------------
say "1. scratch database (real migrations)"
psql "$PGADMIN" -q -c "DROP DATABASE IF EXISTS ${DB}" -c "CREATE DATABASE ${DB}" || { echo "cannot create ${DB}"; exit 1; }
if (cd "$REPO/packages/db-migrations" && /usr/local/bin/migrate -path ./migrations -database "${PGTEST}?sslmode=disable" up >/dev/null 2>&1); then
  ok "migrations applied to ${DB}"
else
  no "migrations applied to ${DB}"; exit 1
fi

# --- 2. anvil fork -----------------------------------------------------------
say "2. anvil fork of Robinhood Chain"
anvil --fork-url "$RPC_UP" --chain-id 4663 --port "$ANVIL_PORT" --silent >"$WORK/anvil.log" 2>&1 &
PIDS="$PIDS $!"
FORKED=0
for _ in $(seq 1 90); do
  if cast chain-id --rpc-url "$ANVIL_URL" >/dev/null 2>&1; then FORKED=1; break; fi
  sleep 1
done
if [ "$FORKED" = 1 ]; then ok "fork is answering"; else no "fork is answering" "$(tail -3 "$WORK/anvil.log")"; exit 1; fi
[ "$(cast chain-id --rpc-url "$ANVIL_URL")" = "4663" ] && ok "fork reports chain id 4663" || no "fork reports chain id 4663"

# --- 3. test signer ----------------------------------------------------------
say "3. test signer (throwaway seed, shipped allowlist, fork RPC)"
openssl rand -hex 32 >"$WORK/seed.key"
chmod 0400 "$WORK/seed.key"
env -i PATH="$PATH" HOME=/home/ubuntu \
  SIGNER_MASTER_SEED_FILE="$WORK/seed.key" \
  SIGNER_ALLOWLIST_FILE="$REPO/services/signer/allowlist/robinhood-mainnet.json" \
  SIGNER_RPC_URLS="$ANVIL_URL" \
  SIGNER_SIGNATURE_COUNT_FILE="$WORK/signatures.json" \
  SIGNER_CHAIN_CACHE_TTL_MS=1 \
  INTERNAL_API_KEY="$KEY" PORT="$SIGNER_PORT" \
  /usr/local/bin/arcana-signer >"$WORK/signer.log" 2>&1 &
PIDS="$PIDS $!"
SIGNER_UP=0
for _ in $(seq 1 60); do
  if curl -s -m 2 "$SIGNER_URL/healthz" | grep -q '"status":"ok"'; then SIGNER_UP=1; break; fi
  sleep 0.5
done
[ "$SIGNER_UP" = 1 ] && ok "signer boots against the fork" || { no "signer boots against the fork"; tail -5 "$WORK/signer.log"; exit 1; }
curl -s -m 5 "$SIGNER_URL/healthz" | grep -q '"signer_configured":true' \
  && ok "signer reports a configured keyring" || no "signer reports a configured keyring"
AGENT_ADDR="$(curl -s -m 5 -H "X-Internal-Key: $KEY" "$SIGNER_URL/internal/v1/signer/wallets/$AGENT" | jq -r .address)"
[ -n "$AGENT_ADDR" ] && [ "$AGENT_ADDR" != "null" ] && ok "agent wallet derived: $AGENT_ADDR" || { no "agent wallet derived"; exit 1; }

# THE WALLET ROW agent-service WRITES. The LP loop verifies ownership by looking
# the chain's owner up in this table — without it a pass skips every position
# with "no agent wallets to check ownership against", which is what made the
# pass-side half of the opt-in gate untestable here until 2026-10-20.
psql "${PGTEST}?sslmode=disable" -q -v ON_ERROR_STOP=1 \
  -c "INSERT INTO agents (id, name, risk_profile, asset_universe) VALUES ('$AGENT', 'lpexec e2e', '{}'::jsonb, 'stock_tokens') ON CONFLICT (id) DO NOTHING;" \
  -c "INSERT INTO agent_wallets (agent_id, address, provenance) VALUES ('$AGENT', '$(lower "$AGENT_ADDR")', 'derived') ON CONFLICT (agent_id) DO UPDATE SET address = EXCLUDED.address;" \
  >/dev/null 2>"$WORK/agent-row.err" \
  && ok "the agent and its wallet are in the database the loop reads" \
  || no "agent wallet row" "$(tail -2 "$WORK/agent-row.err")"

# --- 4. fund the agent wallet ------------------------------------------------
say "4. fund the agent wallet on the fork"
cast rpc anvil_setBalance "$AGENT_ADDR" 0x8ac7230489e80000 --rpc-url "$ANVIL_URL" >/dev/null
cast rpc anvil_impersonateAccount "$POOL" --rpc-url "$ANVIL_URL" >/dev/null
cast rpc anvil_setBalance "$POOL" 0x8ac7230489e80000 --rpc-url "$ANVIL_URL" >/dev/null
cast send --unlocked --from "$POOL" "$USDG" "transfer(address,uint256)" "$AGENT_ADDR" 500000000 --rpc-url "$ANVIL_URL" >/dev/null \
  && ok "transferred 500 USDG from the pool (impersonated on the fork)" || no "USDG transfer"
cast send --unlocked --from "$POOL" "$NVDA" "transfer(address,uint256)" "$AGENT_ADDR" 2000000000000000000 --rpc-url "$ANVIL_URL" >/dev/null \
  && ok "transferred 2 NVDA" || no "NVDA transfer"
cast rpc anvil_stopImpersonatingAccount "$POOL" --rpc-url "$ANVIL_URL" >/dev/null

TOKEN0="$(cast call "$POOL" "token0()(address)" --rpc-url "$ANVIL_URL")"
TOKEN1="$(cast call "$POOL" "token1()(address)" --rpc-url "$ANVIL_URL")"
POOL_FEE="$(cast call "$POOL" "fee()(uint24)" --rpc-url "$ANVIL_URL")"
CUR_TICK="$(cast call --json "$POOL" "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" --rpc-url "$ANVIL_URL" | jq -r '.[1]')"
echo "    pool tokens: token0=$TOKEN0 token1=$TOKEN1 fee=$POOL_FEE tick=$CUR_TICK"

# --- 5. setup position, out of range ----------------------------------------
# A range BELOW the current tick holds only token1. It is minted with
# amount0 = 0 and amount1 = exactly what the position needs, and the approval
# is for exactly that amount — so when the executor rebalances, the allowance
# is gone and its own approve steps have to run.
say "5. setup: mint an out-of-range position (the owner's first deposit, by hand)"
T1L="$(lower "$TOKEN1")"
if [ "$T1L" = "$(lower "$USDG")" ]; then AMT1=100000000; else AMT1=100000000000000000; fi
TL=$(( (CUR_TICK - 6000) / 10 * 10 ))
TU=$(( TL + 1000 ))
DEADLINE=$(( $(date +%s) + 900 ))

cast rpc anvil_impersonateAccount "$AGENT_ADDR" --rpc-url "$ANVIL_URL" >/dev/null
cast send --unlocked --from "$AGENT_ADDR" "$TOKEN1" "approve(address,uint256)" "$NPM" "$AMT1" --rpc-url "$ANVIL_URL" >/dev/null \
  && ok "approved exactly the setup mint's amount1 to the NPM" || no "setup approval"
MINT_JSON="$(cast send --json --unlocked --from "$AGENT_ADDR" "$NPM" \
  "mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))" \
  "($TOKEN0,$TOKEN1,$POOL_FEE,$TL,$TU,0,$AMT1,0,0,$AGENT_ADDR,$DEADLINE)" \
  --rpc-url "$ANVIL_URL")"
MINT_STATUS="$(echo "$MINT_JSON" | jq -r .status)"
[ "$MINT_STATUS" = "0x1" ] && ok "setup mint mined (range [$TL,$TU], below tick $CUR_TICK)" || { no "setup mint" "$MINT_STATUS"; echo "$MINT_JSON" | head -c 400; exit 1; }
OLD_ID_HEX="$(echo "$MINT_JSON" | jq -r --arg npm "$(lower "$NPM")" \
  '.logs[] | select((.address|ascii_downcase)==$npm) | select((.topics[0]|ascii_downcase)=="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") | .topics[3]' | head -1)"
OLD_ID="$(cast to-dec "$OLD_ID_HEX")"
[ -n "$OLD_ID" ] && ok "position tokenId $OLD_ID owned by the agent" || { no "position tokenId"; exit 1; }
cast rpc anvil_stopImpersonatingAccount "$AGENT_ADDR" --rpc-url "$ANVIL_URL" >/dev/null

# --- 6. temporary arbitrage against the fork --------------------------------
say "6. temporary arbitrage reader against the fork (no loops)"
# The harvest threshold is lowered for the test: a $300 swap is a real but tiny
# fraction of this pool, and the assertion is about the MECHANISM (exact fees →
# proposal → collect), not about the reviewed production threshold.
jq '.lp_harvest_min_usd = 0.000001' \
  "$REPO/services/arbitrage/config/robinhood-arbitrage.json" >"$WORK/arb-config.json"
env -i PATH="$PATH" HOME=/home/ubuntu \
  DATABASE_URL="${PGTEST}?sslmode=disable" PORT="$ARB_PORT" \
  ARBITRAGE_ALLOWLIST_FILE="$REPO/services/signer/allowlist/robinhood-mainnet.json" \
  ARBITRAGE_CONFIG_FILE="$WORK/arb-config.json" \
  ARBITRAGE_RPC_URLS="$ANVIL_URL" SCAN_INTERVAL=0 LP_SYNC_INTERVAL=0 INTERNAL_API_KEY="$KEY" \
  "$REPO/scheduler-bin/arbitrage" >"$WORK/arb.log" 2>&1 &
PIDS="$PIDS $!"
ARB_UP=0
for _ in $(seq 1 60); do
  if curl -s -m 2 "$ARB_URL/healthz" | grep -q '"status":"ok"'; then ARB_UP=1; break; fi
  sleep 0.5
done
[ "$ARB_UP" = 1 ] && ok "arbitrage reader boots" || { no "arbitrage reader boots"; tail -5 "$WORK/arb.log"; exit 1; }
POS_JSON="$(curl -s -m 30 "$ARB_URL/v1/arbitrage/lp/position?token_id=${OLD_ID}")"
echo "$POS_JSON" | jq -e '.position.in_range == false' >/dev/null \
  && ok "the position reads out of range" || { no "position out of range" "$(echo "$POS_JSON" | head -c 200)"; exit 1; }
POS_LIQ="$(echo "$POS_JSON"  | jq -r '.position.liquidity')"
POS_A0="$(echo "$POS_JSON"   | jq -r '.position.amount0')"
POS_A1="$(echo "$POS_JSON"   | jq -r '.position.amount1')"
POS_TICK="$(echo "$POS_JSON" | jq -r '.position.current_tick')"
POS_TL="$(echo "$POS_JSON"   | jq -r '.position.tick_lower')"
POS_TU="$(echo "$POS_JSON"   | jq -r '.position.tick_upper')"
[ "$POS_LIQ" != "0" ] && ok "the position has liquidity $POS_LIQ" || no "position liquidity"

# --- 7. registry row + proposed action --------------------------------------
# PROVENANCE IS 'live', NOT 'verification', AND THAT IS THE POINT OF THIS SUITE
# NOW: the pass only manages rows it believes are real (OpenLPPositions filters
# provenance = 'live'), so a verification-stamped row would make the loop gate
# in 7c and 7d untestable here. The loop runs nowhere else in this harness —
# LP_SYNC_INTERVAL=0, and every pass below is triggered explicitly.
say "7. registry row and a proposed rebalance, in the shapes the loop writes"
PLAN_JSON="$(curl -s -m 30 "$ARB_URL/v1/arbitrage/lp/plan?symbol=NVDA&size_usd=100&range_pct=0.05")"
echo "$PLAN_JSON" | jq -e '.plan.tick_lower < .plan.tick_upper' >/dev/null \
  && ok "a mint plan is available for the rebalance" || { no "mint plan" "$(echo "$PLAN_JSON" | head -c 200)"; exit 1; }
DETAIL="$(echo "$PLAN_JSON" | jq -c '{plan: .plan, slippage_bps: 50}')"

psql "${PGTEST}?sslmode=disable" -q -v ON_ERROR_STOP=1 <<SQL || { no "insert registry/action"; exit 1; }
INSERT INTO lp_positions
  (position_manager, token_id, agent_id, wallet, pool, token0, token1, fee_tier,
   tick_lower, tick_upper, liquidity, tokens_owed0, tokens_owed1,
   current_tick, in_range, amount0, amount1, recommendation, status, provenance)
VALUES
  ('$NPM', '$OLD_ID', '$AGENT', '$(lower "$AGENT_ADDR")', '$POOL', '$(lower "$TOKEN0")', '$(lower "$TOKEN1")', $POOL_FEE,
   $POS_TL, $POS_TU, '$POS_LIQ', '0', '0',
   $POS_TICK, false, '$POS_A0', '$POS_A1', 'rebalance', 'open', 'live');

INSERT INTO lp_position_actions (position_manager, token_id, agent_id, recommendation, detail)
VALUES ('$NPM', '$OLD_ID', '$AGENT', 'rebalance', '$DETAIL'::jsonb);
SQL
ACTION_ID="$(psql "${PGTEST}?sslmode=disable" -Atc "SELECT max(id) FROM lp_position_actions")"
[ -n "$ACTION_ID" ] && ok "action $ACTION_ID proposed" || { no "action proposed" "the insert wrote no row"; exit 1; }

# --- 7b. the opt-in gate, at the executor ------------------------------------
# THE AGENT HAS NO SETTINGS ROW AT ALL, which is the documented default: OFF.
# The action below was inserted straight into the database — exactly the "stale
# queue" case the executor's own check exists for — and it must NOT be signed.
say "7b. the executor refuses a rebalance for an agent whose creator has not switched it on"
NO_SETTING="$(curl -s -m 10 "$ARB_URL/v1/arbitrage/agents/$AGENT/settings" | jq -c .setting)"
[ "$(echo "$NO_SETTING" | jq -r .exists)" = "false" ] && [ "$(echo "$NO_SETTING" | jq -r .enabled)" = "false" ] \
  && ok "an agent nobody has switched reads enabled=false, exists=false" || no "default setting" "$NO_SETTING"
NO_KEY_STATUS="$(curl -s -o /dev/null -m 10 -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -d '{"enabled":true,"actor":"0xe2e"}' "$ARB_URL/internal/v1/arbitrage/agents/$AGENT/settings")"
[ "$NO_KEY_STATUS" = "403" ] && ok "the switch is machine-tier: without the key it is refused" || no "unauthorised switch" "$NO_KEY_STATUS"

NONCE_BEFORE_GATE="$(cast nonce "$AGENT_ADDR" --rpc-url "$ANVIL_URL")"
env -i PATH="$PATH" HOME=/home/ubuntu \
  ARBITRAGE_URL="$ARB_URL" LP_EXECUTE=1 \
  DATABASE_URL="${PGTEST}?sslmode=disable" \
  SIGNER_URL="$SIGNER_URL" INTERNAL_API_KEY="$KEY" \
  EXECUTION_RPC_URLS="$ANVIL_URL" \
  EXECUTION_ALLOWLIST_FILE="$REPO/services/signer/allowlist/robinhood-mainnet.json" \
  "$REPO/scheduler-bin/lpexec" >"$WORK/gate.json" 2>"$WORK/gate.log"
GATE_RC=$?
[ "$GATE_RC" = 0 ] && ok "the refused run still exits 0 (a refusal is a recorded fact, not a fault)" \
  || no "refused run exit" "$GATE_RC: $(tail -3 "$WORK/gate.log")"
grep -q 'arbitrage is not enabled for this agent' "$WORK/gate.log" \
  && ok "and it says why: arbitrage is not enabled for this agent" || no "refusal reason" "$(tail -3 "$WORK/gate.log")"
[ "$(jq -r '.executions | length' "$WORK/gate.json" 2>/dev/null)" = "0" ] \
  && ok "nothing was signed or broadcast" || no "executions on a refused run" "$(jq -c '.executions' "$WORK/gate.json" 2>/dev/null)"
NONCE_AFTER_GATE="$(cast nonce "$AGENT_ADDR" --rpc-url "$ANVIL_URL")"
[ "$NONCE_BEFORE_GATE" = "$NONCE_AFTER_GATE" ] \
  && ok "the agent wallet's nonce did not move (no transaction reached the chain)" \
  || no "nonce moved on a refused run" "$NONCE_BEFORE_GATE -> $NONCE_AFTER_GATE"
[ "$(psql "${PGTEST}?sslmode=disable" -Atc "SELECT status FROM lp_position_actions WHERE id = $ACTION_ID")" = "proposed" ] \
  && ok "the action is left as proposed for the switch to decide" || no "action status after refusal"

# --- 7c. the opt-in gate, at the loop ----------------------------------------
# The pass reads the chain, computes `rebalance` for this out-of-range position,
# and must supersede the standing proposal instead of leaving it for the
# executor — the same rule 7b just exercised from the other side.
say "7c. the pass supersedes a rebalance for a disabled agent and proposes nothing"
curl -s -m 90 -X POST -H "X-Internal-Key: $KEY" "$ARB_URL/internal/v1/arbitrage/lp/sync" >"$WORK/sync-disabled.json"
jq -e '.enabled == 0' "$WORK/sync-disabled.json" >/dev/null \
  && ok "the pass reports zero enabled agents" || no "enabled count" "$(jq -c . "$WORK/sync-disabled.json")"
[ "$(psql "${PGTEST}?sslmode=disable" -Atc "SELECT status FROM lp_position_actions WHERE id = $ACTION_ID")" = "superseded" ] \
  && ok "the standing rebalance was superseded by the pass" || no "superseded by the pass"
LEFT="$(psql "${PGTEST}?sslmode=disable" -Atc "SELECT count(*) FROM lp_position_actions WHERE token_id = '$OLD_ID' AND status = 'proposed'")"
[ "$LEFT" = "0" ] && ok "and nothing was proposed in its place" || no "proposals left" "$LEFT"

# --- 7d. the creator switches it on ------------------------------------------
say "7d. the creator switches it on, and the same pass now proposes"
ENABLE_JSON="$(curl -s -m 15 -X POST -H "X-Internal-Key: $KEY" -H 'content-type: application/json' \
  -d '{"enabled":true,"actor":"0xe2e-creator"}' "$ARB_URL/internal/v1/arbitrage/agents/$AGENT/settings")"
[ "$(echo "$ENABLE_JSON" | jq -r '.setting.enabled')" = "true" ] \
  && ok "the switch is on, with the actor recorded" || no "enable" "$(echo "$ENABLE_JSON" | head -c 200)"
[ "$(echo "$ENABLE_JSON" | jq -r '.setting.updated_by')" = "0xe2e-creator" ] \
  && ok "the audit trail names who flipped it" || no "actor recorded" "$ENABLE_JSON"
curl -s -m 90 -X POST -H "X-Internal-Key: $KEY" "$ARB_URL/internal/v1/arbitrage/lp/sync" >"$WORK/sync-enabled.json"
jq -e '.enabled == 1' "$WORK/sync-enabled.json" >/dev/null \
  && ok "the pass reports one enabled agent" || no "enabled count after switch" "$(jq -c . "$WORK/sync-enabled.json")"
NEW_ACTION="$(psql "${PGTEST}?sslmode=disable" -Atc "SELECT max(id) FROM lp_position_actions WHERE token_id = '$OLD_ID' AND status = 'proposed'")"
NEW_REC="$(psql "${PGTEST}?sslmode=disable" -Atc "SELECT recommendation FROM lp_position_actions WHERE id = ${NEW_ACTION:-0}")"
if [ -n "$NEW_ACTION" ] && [ "$NEW_REC" = "rebalance" ]; then
  ok "an enabled agent gets a fresh rebalance proposal (action $NEW_ACTION)"
  ACTION_ID="$NEW_ACTION"
else
  no "a proposal after enabling" "action=${NEW_ACTION:-none} recommendation=${NEW_REC:-none} $(jq -c . "$WORK/sync-enabled.json")"
fi

# --- 8. plan mode ------------------------------------------------------------
say "8. PLAN mode: the four intents, in the contract's order"
env -i PATH="$PATH" HOME=/home/ubuntu ARBITRAGE_URL="$ARB_URL" \
  "$REPO/scheduler-bin/lpexec" >"$WORK/plan.json" 2>"$WORK/plan.log"
PLAN_ORDER="$(jq -c '.plans[0].intents | map(.intent)' "$WORK/plan.json" 2>/dev/null)"
if [ "$PLAN_ORDER" = '["lp_decrease","lp_collect","lp_burn","lp_mint"]' ]; then
  ok "the plan is decrease → collect → burn → mint"
else
  no "the plan order" "$PLAN_ORDER $(tail -2 "$WORK/plan.log")"
fi

# --- 9. armed execution ------------------------------------------------------
say "9. EXECUTE mode: sign, broadcast, receipts"
env -i PATH="$PATH" HOME=/home/ubuntu \
  ARBITRAGE_URL="$ARB_URL" LP_EXECUTE=1 \
  DATABASE_URL="${PGTEST}?sslmode=disable" \
  SIGNER_URL="$SIGNER_URL" INTERNAL_API_KEY="$KEY" \
  EXECUTION_RPC_URLS="$ANVIL_URL" \
  EXECUTION_ALLOWLIST_FILE="$REPO/services/signer/allowlist/robinhood-mainnet.json" \
  "$REPO/scheduler-bin/lpexec" >"$WORK/armed.json" 2>"$WORK/armed.log"
ARMED_RC=$?
[ "$ARMED_RC" = 0 ] && ok "the armed run exits 0" || no "armed run exit" "$ARMED_RC: $(tail -3 "$WORK/armed.log")"
jq -e '.executions[0].status == "executed"' "$WORK/armed.json" >/dev/null \
  && ok "the action executed" || no "execution status" "$(jq -c '.executions[0] | {status,error}' "$WORK/armed.json" 2>/dev/null)"
STEP_INTENTS="$(jq -c '.executions[0].steps | map(.intent)' "$WORK/armed.json" 2>/dev/null)"
if [ "$STEP_INTENTS" = '["approve","approve","lp_decrease","lp_collect","lp_burn","lp_mint"]' ]; then
  ok "six steps: two approvals derived at execution time, then the sequence"
else
  no "executed steps" "$STEP_INTENTS"
fi
STEPS_ALL_MINED="$(jq -r '[.executions[0].steps[] | select(.status != "mined")] | length' "$WORK/armed.json" 2>/dev/null)"
[ "$STEPS_ALL_MINED" = "0" ] && ok "every step's receipt says mined" || no "steps mined" "$(jq -c '.executions[0].steps' "$WORK/armed.json" 2>/dev/null)"
HASHES_MISSING="$(jq -r '[.executions[0].steps[] | select((.tx_hash // "") == "")] | length' "$WORK/armed.json" 2>/dev/null)"
[ "$HASHES_MISSING" = "0" ] && ok "every step records its transaction hash" || no "step hashes" "$HASHES_MISSING missing"
MINT_TX="$(jq -r '.executions[0].steps[] | select(.intent == "lp_mint") | .tx_hash' "$WORK/armed.json")"

# --- 10. database ------------------------------------------------------------
say "10. the database says what happened"
DB_STATUS="$(psql "${PGTEST}?sslmode=disable" -Atc "SELECT status FROM lp_position_actions WHERE id = $ACTION_ID")"
[ "$DB_STATUS" = "executed" ] && ok "action status is 'executed'" || no "action status" "$DB_STATUS"
DB_STEPS="$(psql "${PGTEST}?sslmode=disable" -Atc "SELECT count(*) FROM lp_execution_steps WHERE action_id = $ACTION_ID AND status = 'mined'")"
[ "$DB_STEPS" = "6" ] && ok "six mined steps recorded" || no "mined steps in the database" "$DB_STEPS"
DB_TIMES="$(psql "${PGTEST}?sslmode=disable" -Atc "SELECT (started_at IS NOT NULL AND finished_at IS NOT NULL)::text FROM lp_position_actions WHERE id = $ACTION_ID")"
[ "$DB_TIMES" = "true" ] && ok "started_at and finished_at are set" || no "timestamps" "$DB_TIMES"

# --- 11. the chain -----------------------------------------------------------
say "11. the chain is the final answer"
if cast call "$NPM" "ownerOf(uint256)(address)" "$OLD_ID" --rpc-url "$ANVIL_URL" >/dev/null 2>&1; then
  no "the old position is burned" "ownerOf still answers"
else
  ok "the old position is burned (ownerOf reverts)"
fi
NEW_ID_HEX="$(cast receipt "$MINT_TX" --json --rpc-url "$ANVIL_URL" | jq -r --arg npm "$(lower "$NPM")" \
  '.logs[] | select((.address|ascii_downcase)==$npm) | select((.topics[0]|ascii_downcase)=="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") | .topics[3]' | head -1)"
NEW_ID="$(cast to-dec "$NEW_ID_HEX")"
NEW_OWNER="$(cast call "$NPM" "ownerOf(uint256)(address)" "$NEW_ID" --rpc-url "$ANVIL_URL" 2>/dev/null)"
[ "$(lower "$NEW_OWNER")" = "$(lower "$AGENT_ADDR")" ] && ok "the new position $NEW_ID is owned by the agent" || no "new position owner" "$NEW_OWNER"
NEW_LIQ="$(cast call --json "$NPM" "positions(uint256)(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)" "$NEW_ID" --rpc-url "$ANVIL_URL" | jq -r '.[7]')"
[ "$NEW_LIQ" != "0" ] && ok "the new position has liquidity $NEW_LIQ" || no "new position liquidity" "$NEW_LIQ"
PLAN_TL="$(jq -r '.plans[0].intents[] | select(.intent=="lp_mint") | .body.tick_lower' "$WORK/plan.json")"
PLAN_TU="$(jq -r '.plans[0].intents[] | select(.intent=="lp_mint") | .body.tick_upper' "$WORK/plan.json")"
NOW_TICK="$(cast call --json "$POOL" "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" --rpc-url "$ANVIL_URL" | jq -r '.[1]')"
if [ "$NOW_TICK" -ge "$PLAN_TL" ] && [ "$NOW_TICK" -lt "$PLAN_TU" ]; then
  ok "the new position is in range (tick $NOW_TICK in [$PLAN_TL,$PLAN_TU))"
else
  no "new position in range" "tick $NOW_TICK not in [$PLAN_TL,$PLAN_TU)"
fi

# --- 12. idempotency ---------------------------------------------------------
say "12. a second armed run does nothing"
env -i PATH="$PATH" HOME=/home/ubuntu \
  ARBITRAGE_URL="$ARB_URL" LP_EXECUTE=1 \
  DATABASE_URL="${PGTEST}?sslmode=disable" \
  SIGNER_URL="$SIGNER_URL" INTERNAL_API_KEY="$KEY" \
  EXECUTION_RPC_URLS="$ANVIL_URL" \
  EXECUTION_ALLOWLIST_FILE="$REPO/services/signer/allowlist/robinhood-mainnet.json" \
  "$REPO/scheduler-bin/lpexec" >"$WORK/second.json" 2>"$WORK/second.log"
SECOND_RC=$?
SECOND_PROPOSALS="$(jq -r '.proposals' "$WORK/second.json" 2>/dev/null)"
[ "$SECOND_RC" = 0 ] && [ "$SECOND_PROPOSALS" = "0" ] \
  && ok "no proposals left: the executed action is not executed twice" \
  || no "second run" "rc=$SECOND_RC proposals=$SECOND_PROPOSALS"
DB_STEPS_AFTER="$(psql "${PGTEST}?sslmode=disable" -Atc "SELECT count(*) FROM lp_execution_steps WHERE action_id = $ACTION_ID")"
[ "$DB_STEPS_AFTER" = "6" ] && ok "the step record did not grow" || no "step record grew" "$DB_STEPS_AFTER"

# --- 13. generate fees -------------------------------------------------------
say "13. generate fees: a real swap through the pool on the fork"
ROUTER=0xcaf681a66d020601342297493863e78c959e5cb2
cast rpc anvil_impersonateAccount "$AGENT_ADDR" --rpc-url "$ANVIL_URL" >/dev/null
cast send --unlocked --from "$AGENT_ADDR" "$USDG" "approve(address,uint256)" "$ROUTER" 300000000 --rpc-url "$ANVIL_URL" >/dev/null
SWAP_JSON="$(cast send --json --unlocked --from "$AGENT_ADDR" "$ROUTER" \
  "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))" \
  "($USDG,$NVDA,500,$AGENT_ADDR,300000000,0,0)" --rpc-url "$ANVIL_URL")"
[ "$(echo "$SWAP_JSON" | jq -r .status)" = "0x1" ] \
  && ok "swap mined (300 USDG → NVDA through the 0.05% pool)" \
  || no "swap for fees" "$(echo "$SWAP_JSON" | head -c 300)"
cast rpc anvil_stopImpersonatingAccount "$AGENT_ADDR" --rpc-url "$ANVIL_URL" >/dev/null

# --- 14. the loop proposes a harvest ---------------------------------------
say "14. the loop sees the exact accrual and proposes a harvest"
POS2="$(curl -s -m 30 "$ARB_URL/v1/arbitrage/lp/position?token_id=${NEW_ID}")"
echo "$POS2" | jq -e '.position.in_range == true' >/dev/null \
  && ok "the position is still in range after the swap" \
  || { no "position in range after swap" "$(echo "$POS2" | jq -c '.position | {current_tick,tick_lower,tick_upper}')"; exit 1; }
POS2_LIQ="$(echo "$POS2" | jq -r '.position.liquidity')"
POS2_A0="$(echo "$POS2" | jq -r '.position.amount0')"
POS2_A1="$(echo "$POS2" | jq -r '.position.amount1')"
POS2_TICK="$(echo "$POS2" | jq -r '.position.current_tick')"
POS2_TL="$(echo "$POS2" | jq -r '.position.tick_lower')"
POS2_TU="$(echo "$POS2" | jq -r '.position.tick_upper')"

psql "${PGTEST}?sslmode=disable" -q <<SQL || { no "insert agent/registry for harvest"; exit 1; }
INSERT INTO agents (id, name, risk_profile, asset_universe)
VALUES ('$AGENT', 'lpexec e2e', '{}'::jsonb, 'stock_tokens')
ON CONFLICT (id) DO NOTHING;
INSERT INTO agent_wallets (agent_id, address, provenance)
VALUES ('$AGENT', '$(lower "$AGENT_ADDR")', 'derived')
ON CONFLICT (agent_id) DO NOTHING;
INSERT INTO lp_positions
  (position_manager, token_id, agent_id, wallet, pool, token0, token1, fee_tier,
   tick_lower, tick_upper, liquidity, tokens_owed0, tokens_owed1,
   current_tick, in_range, amount0, amount1, recommendation, status, provenance)
VALUES
  ('$NPM', '$NEW_ID', '$AGENT', '$(lower "$AGENT_ADDR")', '$POOL', '$(lower "$TOKEN0")', '$(lower "$TOKEN1")', $POOL_FEE,
   $POS2_TL, $POS2_TU, '$POS2_LIQ', '0', '0',
   $POS2_TICK, true, '$POS2_A0', '$POS2_A1', 'hold', 'open', 'live');
SQL
SYNC_JSON="$(curl -s -m 60 -X POST -H "X-Internal-Key: $KEY" "$ARB_URL/internal/v1/arbitrage/lp/sync")"
echo "$SYNC_JSON" | jq -e '.proposed == 1' >/dev/null \
  && ok "the sync proposed exactly one action" \
  || no "sync proposed a harvest" "$(echo "$SYNC_JSON" | head -c 300)"
HARVEST="$(curl -s -m 30 "$ARB_URL/v1/arbitrage/lp/actions" | jq -c --arg id "$NEW_ID" '.actions[] | select(.token_id == $id)')"
[ "$(echo "$HARVEST" | jq -r .recommendation)" = "harvest" ] \
  && ok "the proposal is a harvest" || no "harvest recommendation" "$HARVEST"
HARVEST_ID="$(echo "$HARVEST" | jq -r .id)"
FEES0="$(echo "$HARVEST" | jq -r '.detail.fees_owed0')"
FEES1="$(echo "$HARVEST" | jq -r '.detail.fees_owed1')"
if [ -n "$FEES0" ] && [ "$FEES0" != "null" ] && { [ "$FEES0" != "0" ] || [ "$FEES1" != "0" ]; }; then
  ok "the proposal carries the exact accrual (${FEES0}/${FEES1})"
else
  no "harvest accrual" "$HARVEST"
fi

# --- 15. armed harvest -------------------------------------------------------
say "15. EXECUTE the harvest: one collect, paying the accrual to the wallet"
USDG_BEFORE="$(cast call "$USDG" "balanceOf(address)(uint256)" "$AGENT_ADDR" --rpc-url "$ANVIL_URL" | awk '{print $1}')"
env -i PATH="$PATH" HOME=/home/ubuntu \
  ARBITRAGE_URL="$ARB_URL" LP_EXECUTE=1 \
  DATABASE_URL="${PGTEST}?sslmode=disable" \
  SIGNER_URL="$SIGNER_URL" INTERNAL_API_KEY="$KEY" \
  EXECUTION_RPC_URLS="$ANVIL_URL" \
  EXECUTION_ALLOWLIST_FILE="$REPO/services/signer/allowlist/robinhood-mainnet.json" \
  "$REPO/scheduler-bin/lpexec" >"$WORK/harvest.json" 2>"$WORK/harvest.log"
HARVEST_RC=$?
USDG_AFTER="$(cast call "$USDG" "balanceOf(address)(uint256)" "$AGENT_ADDR" --rpc-url "$ANVIL_URL" | awk '{print $1}')"
[ "$HARVEST_RC" = 0 ] && ok "the armed harvest exits 0" || no "harvest run exit" "$HARVEST_RC: $(tail -3 "$WORK/harvest.log")"
[ "$(jq -r '.executions[0].status' "$WORK/harvest.json" 2>/dev/null)" = "executed" ] \
  && ok "the harvest executed" || no "harvest execution" "$(jq -c '.executions[0] | {status,error}' "$WORK/harvest.json" 2>/dev/null)"
HARVEST_STEPS="$(jq -c '.executions[0].steps | map(.intent)' "$WORK/harvest.json" 2>/dev/null)"
[ "$HARVEST_STEPS" = '["lp_collect"]' ] && ok "one step: a single collect" || no "harvest steps" "$HARVEST_STEPS"
DELTA=$((USDG_AFTER - USDG_BEFORE))
[ "$DELTA" = "$FEES0" ] && ok "the wallet received exactly the proposed accrual ($DELTA base units)" \
  || no "collected amount" "wallet +$DELTA, proposal said $FEES0"
POS3="$(curl -s -m 30 "$ARB_URL/v1/arbitrage/lp/position?token_id=${NEW_ID}")"
[ "$(echo "$POS3" | jq -r '.position.fees_owed0')" = "0" ] && [ "$(echo "$POS3" | jq -r '.position.fees_owed1')" = "0" ] \
  && ok "the accrual resets to zero after the collect" \
  || no "post-harvest accrual" "$(echo "$POS3" | jq -c '.position | {fees_owed0,fees_owed1}')"
DB_HARVEST="$(psql "${PGTEST}?sslmode=disable" -Atc "SELECT status FROM lp_position_actions WHERE id = $HARVEST_ID")"
[ "$DB_HARVEST" = "executed" ] && ok "the harvest action is recorded as executed" || no "harvest action status" "$DB_HARVEST"

# --- 16. nothing left --------------------------------------------------------
say "16. a final armed run does nothing"
env -i PATH="$PATH" HOME=/home/ubuntu \
  ARBITRAGE_URL="$ARB_URL" LP_EXECUTE=1 \
  DATABASE_URL="${PGTEST}?sslmode=disable" \
  SIGNER_URL="$SIGNER_URL" INTERNAL_API_KEY="$KEY" \
  EXECUTION_RPC_URLS="$ANVIL_URL" \
  EXECUTION_ALLOWLIST_FILE="$REPO/services/signer/allowlist/robinhood-mainnet.json" \
  "$REPO/scheduler-bin/lpexec" >"$WORK/final.json" 2>"$WORK/final.log"
FINAL_RC=$?
FINAL_PROPOSALS="$(jq -r '.proposals' "$WORK/final.json" 2>/dev/null)"
[ "$FINAL_RC" = 0 ] && [ "$FINAL_PROPOSALS" = "0" ] \
  && ok "nothing left to execute" || no "final run" "rc=$FINAL_RC proposals=$FINAL_PROPOSALS"

# --- 17. open through the signer --------------------------------------------
say "17. open a position through the signer (the path the first deposit uses)"
env -i PATH="$PATH" HOME=/home/ubuntu \
  ARBITRAGE_URL="$ARB_URL" LP_EXECUTE=1 LP_MAX_OPEN_USD=100 \
  DATABASE_URL="${PGTEST}?sslmode=disable" \
  SIGNER_URL="$SIGNER_URL" INTERNAL_API_KEY="$KEY" \
  EXECUTION_RPC_URLS="$ANVIL_URL" \
  EXECUTION_ALLOWLIST_FILE="$REPO/services/signer/allowlist/robinhood-mainnet.json" \
  "$REPO/scheduler-bin/lpexec" --open --symbol NVDA --size-usd 50 --range-pct 0.05 --agent "$AGENT" \
  >"$WORK/open.json" 2>"$WORK/open.log"
OPEN_RC=$?
[ "$OPEN_RC" = 0 ] && ok "the open exits 0" || no "open exit" "$OPEN_RC: $(tail -3 "$WORK/open.log")"
OPEN_ID="$(jq -r '.token_id // empty' "$WORK/open.json" 2>/dev/null)"
OPEN_TX="$(jq -r '.tx_hash // empty' "$WORK/open.json" 2>/dev/null)"
[ -n "$OPEN_ID" ] && ok "the open reports tokenId $OPEN_ID (tx ${OPEN_TX:0:18}…)" || no "open tokenId" "$(head -c 300 "$WORK/open.json" 2>/dev/null)"
OPEN_OWNER="$(cast call "$NPM" "ownerOf(uint256)(address)" "$OPEN_ID" --rpc-url "$ANVIL_URL" 2>/dev/null)"
[ "$(lower "$OPEN_OWNER")" = "$(lower "$AGENT_ADDR")" ] && ok "the opened position is owned by the agent" || no "open owner" "$OPEN_OWNER"
OPEN_LIQ="$(cast call --json "$NPM" "positions(uint256)(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)" "$OPEN_ID" --rpc-url "$ANVIL_URL" | jq -r '.[7]')"
[ "$OPEN_LIQ" != "0" ] && ok "the opened position has liquidity $OPEN_LIQ" || no "open liquidity" "$OPEN_LIQ"
OPEN_ROW="$(psql "${PGTEST}?sslmode=disable" -Atc "SELECT status || '|' || coalesce(token_id,'') FROM lp_opens WHERE token_id = '$OPEN_ID'")"
[ "$OPEN_ROW" = "executed|$OPEN_ID" ] && ok "lp_opens records the open as executed" || no "lp_opens row" "$OPEN_ROW"

# --- 18. the registry discovers it ------------------------------------------
say "18. the registry discovers the opened position from Transfer logs"
SYNC2="$(curl -s -m 60 -X POST -H "X-Internal-Key: $KEY" "$ARB_URL/internal/v1/arbitrage/lp/sync")"
[ "$(echo "$SYNC2" | jq -r '.discovered')" -ge 1 ] && ok "the sync discovered the new position" || no "discovery" "$(echo "$SYNC2" | head -c 200)"
DISC_ROW="$(psql "${PGTEST}?sslmode=disable" -Atc "SELECT status || '|' || provenance FROM lp_positions WHERE token_id = '$OPEN_ID'")"
[ "$DISC_ROW" = "open|live" ] && ok "the registry row is open and live" || no "registry row" "$DISC_ROW"

# --- 19. close path ----------------------------------------------------------
say "19. close path: a liquidity-drained position gets collect + burn"
# Drain the opened position directly, the way an operator tool would, leaving
# liquidity 0 and tokensOwed > 0 — the 'empty' verdict the loop reads.
DRAIN_LIQ="$(cast call --json "$NPM" "positions(uint256)(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)" "$OPEN_ID" --rpc-url "$ANVIL_URL" | jq -r '.[7]')"
DRAIN_DEADLINE=$(( $(date +%s) + 900 ))
cast rpc anvil_impersonateAccount "$AGENT_ADDR" --rpc-url "$ANVIL_URL" >/dev/null
DRAIN_JSON="$(cast send --json --unlocked --from "$AGENT_ADDR" "$NPM" \
  "decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))" \
  "($OPEN_ID,$DRAIN_LIQ,0,0,$DRAIN_DEADLINE)" --rpc-url "$ANVIL_URL")"
[ "$(echo "$DRAIN_JSON" | jq -r .status)" = "0x1" ] && ok "the position was drained to liquidity 0" || no "drain" "$(echo "$DRAIN_JSON" | head -c 200)"
cast rpc anvil_stopImpersonatingAccount "$AGENT_ADDR" --rpc-url "$ANVIL_URL" >/dev/null
curl -s -m 60 -X POST -H "X-Internal-Key: $KEY" "$ARB_URL/internal/v1/arbitrage/lp/sync" >/dev/null
CLOSE_PROP="$(curl -s -m 30 "$ARB_URL/v1/arbitrage/lp/actions" | jq -c --arg id "$OPEN_ID" '.actions[] | select(.token_id == $id)')"
[ "$(echo "$CLOSE_PROP" | jq -r .recommendation)" = "empty" ] && ok "the loop proposes a close" || no "close proposal" "$CLOSE_PROP"
CLOSE_ID="$(echo "$CLOSE_PROP" | jq -r .id)"
env -i PATH="$PATH" HOME=/home/ubuntu \
  ARBITRAGE_URL="$ARB_URL" LP_EXECUTE=1 \
  DATABASE_URL="${PGTEST}?sslmode=disable" \
  SIGNER_URL="$SIGNER_URL" INTERNAL_API_KEY="$KEY" \
  EXECUTION_RPC_URLS="$ANVIL_URL" \
  EXECUTION_ALLOWLIST_FILE="$REPO/services/signer/allowlist/robinhood-mainnet.json" \
  "$REPO/scheduler-bin/lpexec" >"$WORK/close.json" 2>"$WORK/close.log"
CLOSE_RC=$?
[ "$CLOSE_RC" = 0 ] && ok "the close exits 0" || no "close exit" "$CLOSE_RC: $(tail -3 "$WORK/close.log")"
[ "$(jq -r '.executions[0].status' "$WORK/close.json" 2>/dev/null)" = "executed" ] \
  && ok "the close executed" || no "close execution" "$(jq -c '.executions[0] | {status,error}' "$WORK/close.json" 2>/dev/null)"
[ "$(jq -c '.executions[0].steps | map(.intent)' "$WORK/close.json" 2>/dev/null)" = '["lp_collect","lp_burn"]' ] \
  && ok "close sequence: collect, then burn" || no "close steps" "$(jq -c '.executions[0].steps' "$WORK/close.json" 2>/dev/null)"
if cast call "$NPM" "ownerOf(uint256)(address)" "$OPEN_ID" --rpc-url "$ANVIL_URL" >/dev/null 2>&1; then
  no "the closed position is burned" "ownerOf still answers"
else
  ok "the closed position is burned (ownerOf reverts)"
fi
DB_CLOSE="$(psql "${PGTEST}?sslmode=disable" -Atc "SELECT status FROM lp_position_actions WHERE id = $CLOSE_ID")"
[ "$DB_CLOSE" = "executed" ] && ok "the close action is recorded as executed" || no "close action status" "$DB_CLOSE"

# --- verdict -----------------------------------------------------------------
echo
echo "========================================"
echo "  PASS: $PASS   FAIL: $FAIL"
echo "========================================"
if [ "$FAIL" -gt 0 ]; then
  echo "$FAILURES"
  exit 1
fi
echo "lpexec-anvil-e2e: the full LP path ran on a fork of Robinhood Chain:"
echo "open through the signer, discovery by the loop, rebalance (approve, decrease,"
echo "collect, burn, mint), harvest (exact accrual paid to the wallet), and close"
echo "(collect, burn) — every transaction mined, every step recorded, and the"
echo "chain agrees."
