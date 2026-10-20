-- 0068_lp_opens.down.sql
--
-- This history is not recoverable: the chain knows the position exists, but not
-- which plan or which cap the open was reviewed under. Dropping it moves no
-- money and loses the audit trail.
DROP TABLE IF EXISTS lp_opens;
