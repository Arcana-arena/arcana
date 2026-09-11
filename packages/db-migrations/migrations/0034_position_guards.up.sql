-- 0034_position_guards.up.sql
-- Take-profit and stop-loss: levels set when a position opens, watched by a
-- process that holds no model and spends no gas until one is actually crossed.
--
-- WHY THIS IS NOT JUST ANOTHER DECIDER. Everything that trades in this system
-- so far runs on the decision cadence: a tick opens, the agent is asked, an
-- answer is recorded. A stop loss cannot work that way. The whole value of one
-- is that it fires between ticks, and an agent on an hourly cadence with a 5%
-- stop is an agent with a 5%-plus-one-hour stop, which is not the thing its
-- owner asked for.
--
-- So this is a second author of executions, and the record has to say so. See
-- the `decider` note at the bottom: a protective exit is a DECISION with a
-- different author, not an execution with no decision. An agent that profited
-- because its stop loss worked and an agent that profited because its calls
-- were good are two different agents, and the Passport has to be able to tell
-- them apart.

-- --------------------------------------------------------------------------
-- 1. The levels.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS position_guards (
  id            BIGSERIAL PRIMARY KEY,
  agent_id      UUID        NOT NULL REFERENCES agents(id),
  symbol        VARCHAR(20) NOT NULL,

  -- ENTRY IS WHAT WAS PAID, not what was quoted. Derived from the execution:
  -- quote units spent divided by shares actually received, so a level set
  -- "5% below entry" is 5% below the price the agent really got, including the
  -- pool fee and whatever slippage the fill carried.
  entry_price   NUMERIC(20,8) NOT NULL CHECK (entry_price > 0),
  entry_qty     NUMERIC(20,8) NOT NULL CHECK (entry_qty > 0),

  -- Absolute levels in quote per share. Either may be NULL: an agent may set a
  -- stop without a target, or a target without a stop. At least one must exist,
  -- because a guard with neither would be a row that can never do anything.
  take_profit   NUMERIC(20,8) CHECK (take_profit IS NULL OR take_profit > 0),
  stop_loss     NUMERIC(20,8) CHECK (stop_loss   IS NULL OR stop_loss   > 0),
  CONSTRAINT position_guards_has_a_level CHECK (take_profit IS NOT NULL OR stop_loss IS NOT NULL),
  -- A stop above a target would fire both at once and the order would decide
  -- which, silently. Refused in the schema rather than resolved in code.
  CONSTRAINT position_guards_ordered CHECK (
    take_profit IS NULL OR stop_loss IS NULL OR stop_loss < take_profit),

  -- The percentages the agent actually asked for, kept beside the absolute
  -- levels they were turned into. Without them a level cannot be explained
  -- later, only restated.
  take_profit_pct NUMERIC(10,6),
  stop_loss_pct   NUMERIC(10,6),

  set_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  set_by_decision_id BIGINT,

  -- armed      watching
  -- triggered  a level was crossed and the exit was executed
  -- cleared    the position left by another route (the agent sold it itself)
  -- expired    the position is gone or below the dust floor; nothing to guard
  status        VARCHAR(20) NOT NULL DEFAULT 'armed',

  triggered_at    TIMESTAMPTZ,
  triggered_side  VARCHAR(12),   -- take_profit | stop_loss
  triggered_price NUMERIC(20,8),
  triggered_decision_id BIGINT,
  note          TEXT
);

-- ONE ARMED GUARD PER AGENT PER SYMBOL, enforced by the database rather than
-- by whoever writes the next caller. Two armed guards on one position are two
-- exits of a position that can only be exited once, and the second one would
-- spend gas discovering that.
CREATE UNIQUE INDEX IF NOT EXISTS uq_position_guards_armed
  ON position_guards (agent_id, symbol) WHERE status = 'armed';

CREATE INDEX IF NOT EXISTS idx_position_guards_armed
  ON position_guards (status) WHERE status = 'armed';

COMMENT ON TABLE position_guards IS
  'Take-profit and stop-loss levels, set when a position opens and watched '
  'between decision ticks. A guard spends nothing until a level is crossed; '
  'reading a pool price is an eth_call.';

COMMENT ON COLUMN position_guards.entry_price IS
  'Quote paid per share, measured from the execution (quote units in / shares '
  'filled), never from the intent. A level derived from an intended price would '
  'be a level relative to something that did not happen.';

-- --------------------------------------------------------------------------
-- 2. One agent, one actor at a time.
-- --------------------------------------------------------------------------
--
-- THE COLLISION THIS EXISTS FOR. The guard can cross a level in the same second
-- a decision cycle decides to sell the same position. Both read a position that
-- is there, both build a sell, both broadcast. One intent, two transactions —
-- the exact failure the "never retry an unresolved transaction" rule exists to
-- prevent, arriving from a different direction.
--
-- A LEASE, NOT A LOCK. An advisory lock lives in a session, and both writers
-- use pooled connections that they do not own for the length of an execution.
-- A row with an expiry survives a crash without a human, is visible to anyone
-- debugging, and cannot be held forever by a process that died mid-swap.
--
-- NOBODY WAITS. Whoever takes it acts; whoever does not, stands down and
-- records why. A stop loss five seconds late is still a stop loss. A position
-- sold twice cannot be un-sold.
CREATE TABLE IF NOT EXISTS agent_execution_leases (
  agent_id    UUID PRIMARY KEY REFERENCES agents(id),
  holder      TEXT        NOT NULL,   -- 'cycle' | 'guard', plus a run id
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  note        TEXT
);

COMMENT ON TABLE agent_execution_leases IS
  'Exclusive right to move one agent funds. Held by the decision cycle for the '
  'length of a tick and by the position guard for the length of an exit. '
  'Expires on its own so a crashed holder blocks nothing.';

-- --------------------------------------------------------------------------
-- 3. The watcher's own liveness.
-- --------------------------------------------------------------------------
--
-- A WATCHER THAT DIED MUST NOT LOOK LIKE A WATCHER WITH NOTHING TO REPORT.
-- docs/execution.md says exactly this, and this project has already shipped
-- three watchers that were believed alive and were not — one of them confirmed
-- with a `pgrep` that matched its own checking command.
--
-- So the guard writes a heartbeat on EVERY scan, including scans that found
-- nothing to do. Silence is then unambiguous: a stale row means the process is
-- not running, never "the market was quiet".
CREATE TABLE IF NOT EXISTS guard_heartbeat (
  id            INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_scan_at  TIMESTAMPTZ NOT NULL,
  scans         BIGINT      NOT NULL DEFAULT 0,
  armed_guards  INT         NOT NULL DEFAULT 0,
  triggers      BIGINT      NOT NULL DEFAULT 0,
  last_error    TEXT,
  last_error_at TIMESTAMPTZ,
  version       TEXT
);

COMMENT ON TABLE guard_heartbeat IS
  'Written on every scan, including empty ones, so a dead watcher is '
  'distinguishable from a quiet one. Staleness is the alarm condition.';

-- --------------------------------------------------------------------------
-- 4. Who decided.
-- --------------------------------------------------------------------------
--
-- `decisions.decider` already carried this axis: deterministic | llm | human.
-- A protective exit adds `protective` to it.
--
-- IT IS A DECISION, NOT AN EXECUTION WITHOUT ONE. The agent acted; something
-- decided; the record has to name it. An execution row with a NULL decision_id
-- would say nothing decided, which is the lie. And `executions` already joins
-- through `decision_id` — orphaning those rows would put a hole in the only
-- path that connects a transaction hash to a reason.
--
-- What a protective decision does NOT carry is equally load-bearing, and the
-- columns are already nullable for exactly this reason: no provider, no model,
-- no params, no prompt hash, no response hash, and no thesis. There was no
-- model and no forward claim. Leaving them NULL is the record refusing to
-- invent an author.
COMMENT ON COLUMN decisions.decider IS
  'Who produced this decision: deterministic (a coded strategy), llm (a model), '
  'human (the owner, through the manual endpoint), or protective (a take-profit '
  'or stop-loss level crossing, decided by no one at the time it fired). '
  'NULL on rows written before the distinction existed. Score, DNA, Autopsy and '
  'Passport all read this: an agent that profited because its stop loss worked '
  'is not the same agent as one whose calls were good.';
