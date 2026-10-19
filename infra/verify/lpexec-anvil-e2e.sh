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
#      loop writes;
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
say "7. registry row and a proposed rebalance, in the shapes the loop writes"
PLAN_JSON="$(curl -s -m 30 "$ARB_URL/v1/arbitrage/lp/plan?symbol=NVDA&size_usd=100&range_pct=0.05")"
echo "$PLAN_JSON" | jq -e '.plan.tick_lower < .plan.tick_upper' >/dev/null \
  && ok "a mint plan is available for the rebalance" || { no "mint plan" "$(echo "$PLAN_JSON" | head -c 200)"; exit 1; }
DETAIL="$(echo "$PLAN_JSON" | jq -c '{plan: .plan, slippage_bps: 50}')"

psql "${PGTEST}?sslmode=disable" -q <<SQL || { no "insert registry/action"; exit 1; }
INSERT INTO lp_positions
  (position_manager, token_id, agent_id, wallet, pool, token0, token1, fee_tier,
   tick_lower, tick_upper, liquidity, tokens_owed0, tokens_owed1,
   current_tick, in_range, amount0, amount1, recommendation, status, provenance)
VALUES
  ('$NPM', '$OLD_ID', '$AGENT', '$(lower "$AGENT_ADDR")', '$POOL', '$(lower "$TOKEN0")', '$(lower "$TOKEN1")', $POOL_FEE,
   $POS_TL, $POS_TU, '$POS_LIQ', '0', '0',
   $POS_TICK, false, '$POS_A0', '$POS_A1', 'rebalance', 'open', 'verification');

INSERT INTO lp_position_actions (position_manager, token_id, agent_id, recommendation, detail)
VALUES ('$NPM', '$OLD_ID', '$AGENT', 'rebalance', '$DETAIL'::jsonb);
SQL
ACTION_ID="$(psql "${PGTEST}?sslmode=disable" -Atc "SELECT max(id) FROM lp_position_actions")"
ok "action $ACTION_ID proposed"

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
VALUES ('$AGENT', 'lpexec e2e', '{}'::jsonb, 'stock_tokens');
INSERT INTO agent_wallets (agent_id, address, provenance)
VALUES ('$AGENT', '$(lower "$AGENT_ADDR")', 'derived');
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

# --- verdict -----------------------------------------------------------------
echo
echo "========================================"
echo "  PASS: $PASS   FAIL: $FAIL"
echo "========================================"
if [ "$FAIL" -gt 0 ]; then
  echo "$FAILURES"
  exit 1
fi
echo "lpexec-anvil-e2e: the armed executor rebalanced a real position on a fork of"
echo "Robinhood Chain: two approvals, decrease, collect, burn, mint — all mined,"
echo "all recorded, and the chain agrees."
