#!/usr/bin/env bash
# arcana-execution-watchdog.sh — is the money actually moving, or just burning?
#
# WHAT THE OTHER WATCHDOG CANNOT SEE
#
# arcana-decision-watchdog asks "has anything decided anything lately?". Under
# a cadence that is exactly the wrong question for the failure this exists for:
# the agent decides on time, every time, the transaction reverts, gas burns,
# and four hours later it does it again. Decisions are being recorded, so the
# decision watchdog is correct to stay quiet. What is draining is ETH, and
# nothing is watching that.
#
# The pool-fee bug was precisely this shape. EVERY sell reverted for about
# 30,000 gas, and it was found only because a person was looking. Under a
# cadence nobody is looking.
#
# TWO QUESTIONS, because there are two ways this goes silent:
#
#   1. Are trades failing REPEATEDLY? One revert is ordinary — a pool moves
#      between the quote and the send, and the slippage floor does its job. A
#      pattern is not ordinary, and a pattern is what a bug looks like.
#
#   2. Can the wallet still pay for gas? A wallet with tokens and no ETH signs
#      perfectly valid transactions that no block will contain. From the
#      outside that is indistinguishable from an agent choosing to do nothing,
#      which is the most expensive way for a system to look healthy.
#
# THRESHOLDS, AND WHY THESE ONES
#
# Three failures, not one. At a four-hour cadence three failures is twelve
# hours: long enough that a single unlucky revert never wakes anyone, short
# enough that a broken direction cannot run for days in silence. Two would fire
# on coincidence; five would let a fully broken path burn for a day.
#
# Three failures of a reverted swap cost about 0.00001 ETH between them. That
# is the price of NOT alerting on the first one, and it is worth paying.
#
# The gas floor is not a number somebody liked. It is the broker's own
# precondition: it refuses to sign unless the wallet holds
# 2 x maxFee x gasLimit, because an approve and a swap each reserve that much
# up front under EIP-1559. Below it the agent is already unable to trade, so
# that is CRITICAL. Four times it is the warning, which at measured burn rates
# is many days of notice.
#
# READ-ONLY. It reads the database and the chain and writes nothing, for the
# same reason the decision watchdog does not open ticks.
#
# Exit codes: 0 = the check ran (healthy, or alerted). 1 = the check could NOT
# be performed, which OnFailure= turns into its own alert. Never 0 for "I could
# not tell" — that is the failure mode this whole alerting layer exists to
# avoid.

set -uo pipefail

ARCANA_DIR="${ARCANA_DIR:-/home/ubuntu/arcana}"
NOTIFY="${ARCANA_NOTIFY:-${ARCANA_DIR}/infra/alerting/arcana-notify.sh}"
PG_CONTAINER="${PG_CONTAINER:-arcana-postgres}"
PG_USER="${PG_USER:-arcana}"
PG_DB="${PG_DB:-arcana}"
RPC_URL="${EXECUTION_RPC_URL:-https://robinhood-rpc.publicnode.com}"

# How many failures inside the window count as a pattern, and how wide the
# window is. Settable so a different cadence can be watched by the same script.
FAIL_THRESHOLD="${FAIL_THRESHOLD:-3}"
FAIL_WINDOW_HOURS="${FAIL_WINDOW_HOURS:-24}"

# The broker's own reserve, mirrored here. If these ever diverge from the
# broker the alarm stops describing the thing it is watching, so they are named
# rather than folded into a single magic number.
MAX_FEE_WEI="${EXECUTION_MAX_FEE_WEI:-1000000000}"
GAS_LIMIT="${EXECUTION_GAS_LIMIT:-250000}"
WARN_MULTIPLE="${GAS_WARN_MULTIPLE:-4}"

# Test hooks. Used by the verification rig to prove each branch alarms; never
# set in the installed unit.
FORCE_FAILS="${WATCHDOG_FORCE_FAILS:-}"      # pretend this many recent failures
FORCE_BALANCE="${WATCHDOG_FORCE_BALANCE:-}"  # pretend this wei balance
FORCE_NONCE_GAP="${WATCHDOG_FORCE_NONCE_GAP:-}" # pretend this many unrecorded transactions
FORCE_CUSTODY="${WATCHDOG_FORCE_CUSTODY:-}"     # pretend this custody, so BOTH branches can be fired
DRY_RUN="${WATCHDOG_DRY_RUN:-0}"

psql() {
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc "$1" 2>/dev/null
}

# alert <title> <body>
#
# Body on STDIN, title as an argument: that is arcana-notify's interface. The
# decision watchdog's alarm path was broken from the moment it was written
# because this was guessed rather than read, and it would have stayed broken
# until the day it mattered. Same interface, written the same way, and proved
# by firing it on purpose.
alert() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "execution-watchdog: WOULD ALERT: $1"
    printf '%s\n' "$2" | sed 's/^/    /'
    return
  fi
  if [ ! -x "$NOTIFY" ]; then
    echo "execution-watchdog: NOTIFY MISSING at $NOTIFY" >&2
    echo "execution-watchdog: $1 — $2" >&2
    return
  fi
  printf '%s\n' "$2" | "$NOTIFY" alert high "$1" || true
}

verdict() { echo "execution-watchdog: VERDICT=$1 REASON=$2"; }

# --- is there anything to watch? --------------------------------------------
#
# No chain-backed agent means no executions and no gas to run out of. A system
# that has not reached phase 8 is not a broken one.
WALLETS=$(psql "SELECT count(*) FROM agent_wallets w JOIN agents a ON a.id = w.agent_id WHERE a.status = 'active'")
if [ -z "$WALLETS" ]; then
  echo "execution-watchdog: cannot reach the database; the check was NOT performed" >&2
  exit 1
fi
if [ "$WALLETS" = "0" ]; then
  verdict healthy "no active agent holds a wallet, so nothing can execute or run out of gas"
  exit 0
fi

FINDINGS=0
BODY=""
add() { BODY="${BODY}$1
"; FINDINGS=$(( FINDINGS + 1 )); }

# --- 1. repeated failures ---------------------------------------------------
#
# Counted PER AGENT. A platform-wide count would let one broken agent hide
# among many healthy ones, and would also alarm on a chain-wide incident that
# is nobody's bug in particular.
#
# 'blocked' is excluded deliberately: it means nothing was sent, so nothing was
# spent, and the commonest cause is a wallet that is simply out of funds --
# which the gas check below reports properly instead of twice.
FAIL_ROWS=$(psql "
  SELECT a.name || '|' || e.agent_id || '|' || count(*) || '|' ||
         string_agg(DISTINCT e.status, ',') || '|' ||
         COALESCE(sum(e.gas_cost_wei)::text, '0')
    FROM executions e JOIN agents a ON a.id = e.agent_id
   WHERE e.status IN ('reverted','unresolved','refused','quote_failed')
     AND e.ts > now() - interval '${FAIL_WINDOW_HOURS} hours'
   GROUP BY a.name, e.agent_id
  HAVING count(*) >= ${FAIL_THRESHOLD}")

# The hook injects a COUNT and lets the same threshold decide, rather than
# injecting a finding. Injecting the finding would make "one failure stays
# quiet" untestable, and that check is the one that stops this alarm becoming
# noise -- as important as the ones that fire.
if [ -n "$FORCE_FAILS" ]; then
  if [ "$FORCE_FAILS" -ge "$FAIL_THRESHOLD" ]; then
    FAIL_ROWS="forced-test-agent|00000000-0000-0000-0000-000000000000|${FORCE_FAILS}|reverted|${FORCE_FAILS}0000000000000"
  else
    FAIL_ROWS=""
  fi
fi

if [ -n "$FAIL_ROWS" ]; then
  while IFS='|' read -r name agent n statuses wei; do
    [ -z "$name" ] && continue
    add "[FAILING] ${name} (${agent})
     ${n} executions failed in the last ${FAIL_WINDOW_HOURS}h — statuses: ${statuses}
     gas burned on them: ${wei} wei
     One revert is ordinary. ${n} is a pattern, and a pattern is what a bug
     looks like. The pool-fee bug failed EVERY sell for 30k gas each and was
     found only because somebody looked."
  done <<< "$FAIL_ROWS"
fi

# --- 2. gas ------------------------------------------------------------------
FLOOR=$(( MAX_FEE_WEI * GAS_LIMIT * 2 ))
WARN=$(( FLOOR * WARN_MULTIPLE ))

ADDRS=$(psql "
  SELECT a.name || '|' || w.address || '|' || w.key_custody || '|' || a.id
    FROM agent_wallets w JOIN agents a ON a.id = w.agent_id
   WHERE a.status = 'active'")
if [ -z "$ADDRS" ]; then
  echo "execution-watchdog: could not list agent wallets; the check was NOT performed" >&2
  exit 1
fi

while IFS='|' read -r name addr custody agent; do
  [ -z "$addr" ] && continue
  [ -n "$FORCE_CUSTODY" ] && custody="$FORCE_CUSTODY"
  if [ -n "$FORCE_BALANCE" ]; then
    BAL_DEC="$FORCE_BALANCE"
  else
    BAL_HEX=$(curl -s --max-time 20 -X POST "$RPC_URL" \
      -H 'content-type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"${addr}\",\"latest\"]}" \
      | grep -oP '(?<="result":")[^"]*')
    if [ -z "$BAL_HEX" ]; then
      # AN UNREADABLE BALANCE IS NOT A HEALTHY ONE. Refusing to report is the
      # only honest answer, and exit 1 makes OnFailure= say so out loud.
      echo "execution-watchdog: could not read the balance of ${addr}; the check was NOT performed" >&2
      exit 1
    fi
    BAL_DEC=$(( BAL_HEX ))
  fi

  ETH=$(awk -v w="$BAL_DEC" 'BEGIN{printf "%.8f", w/1e18}')
  if [ "$BAL_DEC" -lt "$FLOOR" ]; then
    add "[NO GAS] ${name} (${addr})
     holds ${ETH} ETH; the broker requires ${FLOOR} wei before it will sign.
     This agent CANNOT TRADE and will look like one choosing to do nothing.
     Top it up, or retire it deliberately."
  elif [ "$BAL_DEC" -lt "$WARN" ]; then
    add "[LOW GAS] ${name} (${addr})
     holds ${ETH} ETH, under ${WARN_MULTIPLE}x the ${FLOOR} wei the broker
     reserves per pair of transactions. It still trades; it will stop soon."
  fi

  # --- 3. is every transaction this wallet sent accounted for? --------------
  #
  # The nonce is how many transactions the wallet has EVER sent, and ARCANA
  # should hold a row for each one. When it does not, something was broadcast
  # and its cost was discarded — which is exactly what happened to the ERC-20
  # approval: the swap's receipt overwrote the gas fields, and 26% of one
  # agent's gas spend had no row anywhere. Nothing alarmed, because nothing was
  # asking this question.
  #
  # Gas is an operating cost rather than a trading result, so it stays out of
  # NAV and out of the score. An operating cost still has to be ACCOUNTABLE:
  # one that is not recorded cannot be budgeted, and the first symptom of that
  # is a wallet which has quietly stopped being able to trade.
  #
  # ON A SHARED-CUSTODY WALLET this is reported, not alarmed at. The owner holds
  # the key too and is entitled to send their own transactions, which raise the
  # nonce and correctly have no ARCANA row.
  if [ -z "$FORCE_BALANCE" ]; then
    NONCE_HEX=$(curl -s --max-time 20 -X POST "$RPC_URL" \
      -H 'content-type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionCount\",\"params\":[\"${addr}\",\"latest\"]}" \
      | grep -oP '(?<="result":")[^"]*')
    if [ -z "$NONCE_HEX" ]; then
      echo "execution-watchdog: could not read the nonce of ${addr}; the check was NOT performed" >&2
      exit 1
    fi
    NONCE=$(( NONCE_HEX ))
    ROWS=$(psql "SELECT count(*) FROM executions WHERE agent_id = '${agent}' AND tx_hash IS NOT NULL")
    if [ -z "$ROWS" ]; then
      echo "execution-watchdog: could not count executions for ${agent}" >&2
      exit 1
    fi
    [ -n "$FORCE_NONCE_GAP" ] && NONCE=$(( ROWS + FORCE_NONCE_GAP ))
    if [ "$NONCE" -gt "$ROWS" ]; then
      GAP=$(( NONCE - ROWS ))
      if [ "$custody" = "shared" ]; then
        echo "execution-watchdog: ${name} sent ${NONCE} transactions and ARCANA recorded ${ROWS}; ${GAP} unrecorded, and the owner holds this key too, so they may be theirs."
      else
        add "[UNRECORDED SPEND] ${name} (${addr})
     the wallet has sent ${NONCE} transactions; ARCANA has rows for ${ROWS}.
     ${GAP} were broadcast with their cost discarded. Only ARCANA can sign for
     this wallet, so there is no other explanation."
      fi
    fi
  fi
done <<< "$ADDRS"

# --- report ------------------------------------------------------------------
if [ "$FINDINGS" = "0" ]; then
  verdict healthy "${WALLETS} funded agent(s): no failure pattern in ${FAIL_WINDOW_HOURS}h and gas above the floor"
  exit 0
fi

alert "ARCANA: ${FINDINGS} execution problem(s)" \
"The chain execution path is producing outcomes that need a person.

${BODY}
next:
  1. Look at the executions table. status and note say what happened, and
     tx_hash can be checked on chain:
       SELECT id, agent_id, status, symbol, tx_hash, gas_cost_wei, note
         FROM executions ORDER BY id DESC LIMIT 20;
  2. If the failures share a symbol or a direction, suspect the calldata
     rather than the market. That is what the pool-fee bug looked like.
  3. If gas is the problem, STOP the cadence before topping up, so the
     wallet is not spending while you are measuring it:
       sudo systemctl disable --now arcana-cadence.timer"

verdict alarm "${FINDINGS} finding(s)"
exit 0
