-- 0048_decision_anchors.down.sql
-- Destructive: the local record of every anchor goes. The roots stay on chain,
-- where no migration can reach them — which is the point of putting them there.
DROP TRIGGER IF EXISTS decision_anchor_leaves_fixed ON decision_anchor_leaves;
DROP FUNCTION IF EXISTS decision_anchor_leaf_is_fixed();
DROP TRIGGER IF EXISTS decision_anchors_forward ON decision_anchors;
DROP FUNCTION IF EXISTS decision_anchor_moves_forward();
DROP TABLE IF EXISTS decision_anchor_leaves;
DROP TABLE IF EXISTS decision_anchors;
