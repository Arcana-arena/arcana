-- 0049_verifiable_reputation.down.sql
-- Removes seals, score inputs and multi-kind anchor leaves. Anchors that carry
-- non-decision leaves cannot be represented by 0048's schema, so their leaves
-- are removed with the trigger that protects them — the roots stay on chain.

DROP TRIGGER IF EXISTS decision_anchor_leaves_fixed ON decision_anchor_leaves;
DELETE FROM decision_anchor_leaves WHERE kind <> 'decision';
CREATE TRIGGER decision_anchor_leaves_fixed BEFORE INSERT OR UPDATE OR DELETE ON decision_anchor_leaves
  FOR EACH ROW EXECUTE FUNCTION decision_anchor_leaf_is_fixed();

CREATE OR REPLACE FUNCTION decision_anchor_leaf_is_fixed() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'anchor leaves are part of a root already written on chain and cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
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

DROP INDEX IF EXISTS idx_anchor_leaves_score;
DROP INDEX IF EXISTS idx_anchor_leaves_snapshot;
DROP INDEX IF EXISTS idx_anchor_leaves_commitment;
ALTER TABLE decision_anchor_leaves DROP CONSTRAINT IF EXISTS anchor_leaf_kind_shape;
ALTER TABLE decision_anchor_leaves
  DROP COLUMN IF EXISTS record_ts,
  DROP COLUMN IF EXISTS season_id,
  DROP COLUMN IF EXISTS portfolio_id,
  DROP COLUMN IF EXISTS kind;
ALTER TABLE decision_anchor_leaves ALTER COLUMN decision_id SET NOT NULL;
ALTER TABLE decision_anchor_leaves ALTER COLUMN decision_ts SET NOT NULL;

DROP TRIGGER IF EXISTS score_input_seals_fixed ON score_input_seals;
DROP FUNCTION IF EXISTS score_input_seal_is_fixed();
DROP TABLE IF EXISTS score_input_seals;

DROP TRIGGER IF EXISTS score_snapshots_sealed ON score_snapshots;
DROP FUNCTION IF EXISTS score_snapshot_is_sealed();
ALTER TABLE score_snapshots DROP COLUMN IF EXISTS seal_scheme, DROP COLUMN IF EXISTS seal;

DROP TRIGGER IF EXISTS portfolio_snapshots_sealed ON portfolio_snapshots;
DROP FUNCTION IF EXISTS portfolio_snapshot_is_sealed();
ALTER TABLE portfolio_snapshots DROP COLUMN IF EXISTS seal_scheme, DROP COLUMN IF EXISTS seal;
