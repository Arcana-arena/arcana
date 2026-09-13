-- 0048_decision_anchors.up.sql
-- Commitments, anchored on chain.
--
-- WHY. 0047 seals every decision with a commitment and the database refuses to
-- change a sealed row. That stops the APPLICATION from rewriting history. It
-- does not stop whoever holds the database: an operator with superuser can drop
-- the trigger, rewrite a row and its manifest, and put the trigger back. So
-- "public proof" meant "trust ARCANA's database" — the one thing this platform
-- exists to make unnecessary.
--
-- WHAT. Periodically, every sealed decision not yet anchored becomes a leaf in a
-- Merkle tree, and the tree's root is written into a transaction on Robinhood
-- Chain (4663). Once that transaction is mined, rewriting any anchored decision
-- — or deleting it, or inserting one backdated into the anchored range — breaks
-- a proof anyone can check against the chain without asking ARCANA.
--
-- THE CONSTRUCTION is arcana-anchor/v1:
--   leaf  = sha256(0x00 || commitment)          (32 raw bytes)
--   node  = sha256(0x01 || left || right)
--   odd   = the last node of a level is carried up unchanged
--   order = decision id ascending
--   tx    = a zero-value transaction from the anchoring address to itself whose
--           input is "ARCANA" 0x00 0x01 followed by the 32-byte root
-- Domain separation keeps a leaf from ever being passed off as a node.
--
-- See docs/anchoring.md, services/decision-engine/internal/store/merkle.go.

CREATE TABLE IF NOT EXISTS decision_anchors (
  id                      BIGSERIAL PRIMARY KEY,
  scheme                  VARCHAR(40)  NOT NULL,
  root                    CHAR(64)     NOT NULL,
  leaf_count              INT          NOT NULL CHECK (leaf_count > 0),
  first_decision_id       BIGINT       NOT NULL,
  last_decision_id        BIGINT       NOT NULL,
  first_decision_ts       TIMESTAMPTZ  NOT NULL,
  last_decision_ts        TIMESTAMPTZ  NOT NULL,
  chain_id                INT          NOT NULL,
  sender                  CHAR(42)     NOT NULL,
  nonce                   BIGINT       NOT NULL,
  tx_hash                 CHAR(66)     NOT NULL,
  -- The signed bytes, so an unmined transaction is rebroadcast rather than
  -- re-signed: the same bytes have the same hash, and a record that points at
  -- one hash cannot quietly come to mean another.
  raw_tx                  TEXT         NOT NULL,
  -- signed → broadcast → mined | reverted | dropped. reverted and dropped
  -- return their decisions to the queue; mined is final.
  status                  VARCHAR(12)  NOT NULL
                          CHECK (status IN ('signed', 'broadcast', 'mined', 'reverted', 'dropped')),
  block_number            BIGINT,
  gas_used                BIGINT,
  effective_gas_price_wei NUMERIC(40, 0),
  -- PLATFORM COST. Anchoring is infrastructure, paid by ARCANA, never by an
  -- agent's owner — and recorded, because a cost nobody can see is one nobody
  -- can check.
  gas_cost_wei            NUMERIC(40, 0),
  eth_usd                 NUMERIC(20, 8),
  gas_cost_usd            NUMERIC(20, 8),
  note                    TEXT,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  broadcast_at            TIMESTAMPTZ,
  mined_at                TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_decision_anchors_tx ON decision_anchors (tx_hash);
CREATE INDEX IF NOT EXISTS idx_decision_anchors_open
  ON decision_anchors (id) WHERE status IN ('signed', 'broadcast');

COMMENT ON TABLE decision_anchors IS
  'Merkle roots of decision commitments written on chain (arcana-anchor/v1). '
  'Append-only: a root, its range and its transaction never change; status only '
  'moves forward. Gas here is a platform cost.';

-- THE LEAVES, stored as they were anchored. The commitment is COPIED, not
-- joined: the root on chain is over these bytes, and a proof must be
-- reproducible from this table even if the decision row were ever tampered with
-- — that tampering is exactly what the proof exists to expose.
CREATE TABLE IF NOT EXISTS decision_anchor_leaves (
  anchor_id    BIGINT       NOT NULL REFERENCES decision_anchors(id),
  leaf_index   INT          NOT NULL CHECK (leaf_index >= 0),
  decision_id  BIGINT       NOT NULL,
  decision_ts  TIMESTAMPTZ  NOT NULL,
  agent_id     UUID         NOT NULL,
  commitment   CHAR(64)     NOT NULL,
  PRIMARY KEY (anchor_id, leaf_index)
);

CREATE INDEX IF NOT EXISTS idx_decision_anchor_leaves_decision
  ON decision_anchor_leaves (decision_id, decision_ts);

-- --------------------------------------------------------------------------
-- Append-only, enforced.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION decision_anchor_moves_forward() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'anchor % is a permanent record and cannot be deleted', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF (NEW.scheme, NEW.root, NEW.leaf_count, NEW.first_decision_id, NEW.last_decision_id,
      NEW.first_decision_ts, NEW.last_decision_ts, NEW.chain_id, NEW.sender, NEW.nonce,
      NEW.tx_hash, NEW.raw_tx, NEW.created_at)
     IS DISTINCT FROM
     (OLD.scheme, OLD.root, OLD.leaf_count, OLD.first_decision_id, OLD.last_decision_id,
      OLD.first_decision_ts, OLD.last_decision_ts, OLD.chain_id, OLD.sender, OLD.nonce,
      OLD.tx_hash, OLD.raw_tx, OLD.created_at) THEN
    RAISE EXCEPTION 'anchor % cannot be rewritten: its root, range and transaction are fixed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'signed'    AND NEW.status IN ('broadcast', 'mined', 'reverted', 'dropped'))
      OR (OLD.status = 'broadcast' AND NEW.status IN ('mined', 'reverted', 'dropped'))
    ) THEN
      RAISE EXCEPTION 'anchor % cannot move from % to %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.status IN ('mined', 'reverted', 'dropped') THEN
    RAISE EXCEPTION 'anchor % is % and final', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decision_anchors_forward ON decision_anchors;
CREATE TRIGGER decision_anchors_forward BEFORE UPDATE OR DELETE ON decision_anchors
  FOR EACH ROW EXECUTE FUNCTION decision_anchor_moves_forward();

CREATE OR REPLACE FUNCTION decision_anchor_leaf_is_fixed() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'anchor leaves are part of a root already written on chain and cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  -- A decision is anchored once. Only an anchor that failed to land returns its
  -- decisions to the queue.
  IF EXISTS (
       SELECT 1 FROM decision_anchor_leaves l
         JOIN decision_anchors a ON a.id = l.anchor_id
        WHERE l.decision_id = NEW.decision_id AND l.decision_ts = NEW.decision_ts
          AND l.anchor_id <> NEW.anchor_id
          AND a.status NOT IN ('reverted', 'dropped')) THEN
    RAISE EXCEPTION 'decision % is already in an anchor that has not failed', NEW.decision_id
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decision_anchor_leaves_fixed ON decision_anchor_leaves;
CREATE TRIGGER decision_anchor_leaves_fixed BEFORE INSERT OR UPDATE OR DELETE ON decision_anchor_leaves
  FOR EACH ROW EXECUTE FUNCTION decision_anchor_leaf_is_fixed();
