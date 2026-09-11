-- 0031_mandate_source.up.sql
-- Free prompts: say where a mandate came from, because now there are three answers.
--
-- 0029 recorded HOW a mandate was produced, on the reasoning that six months
-- from now nobody can tell a rendered template from a paragraph somebody
-- pasted. That reasoning is why this column has to exist the moment free text
-- is accepted: mandate_template IS NULL currently means "predates templates",
-- and it would silently start also meaning "the user wrote this themselves".
-- Two different facts under one NULL is exactly the ambiguity 0029 was written
-- to prevent.
--
-- WHY FREE TEXT IS NOW ALLOWED AT ALL. Phase 6 refused it because a prompt can
-- be jailbroken. That was the right call when the prompt was the only thing
-- standing between a user and the money. It is no longer where the defence is:
--
--   - the decider returns an INTENT, never a trade; buyableQty() and
--     applyIntent() sit between it and any position
--   - the signer accepts two named transaction shapes and no calldata, so a
--     raw transfer is not refused, it is unsayable
--   - every token must be in a reviewed allowlist; absent means refused
--   - position size, caps, the fee floor and the cadence are all outside the
--     model's reach
--
-- So the worst prompt anybody can write commands a swap between allowlisted
-- tokens within limits somebody else set. What it can damage is that user's
-- own capital, which is theirs to risk.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS mandate_source VARCHAR(16);

-- Backfill from what is already knowable, rather than defaulting everything to
-- one value and losing the distinction this column exists to keep.
UPDATE agents SET mandate_source = 'template'
 WHERE mandate_source IS NULL AND mandate_template IS NOT NULL;

UPDATE agents SET mandate_source = 'legacy'
 WHERE mandate_source IS NULL AND mandate IS NOT NULL AND mandate <> '';

ALTER TABLE agents
  ADD CONSTRAINT agents_mandate_source_check
  CHECK (mandate_source IS NULL OR mandate_source IN ('template', 'free', 'legacy'));

COMMENT ON COLUMN agents.mandate_source IS
  'Where agents.mandate came from. template = rendered by ARCANA from '
  'mandate_template and mandate_params, and no user string reached the model. '
  'free = the user wrote it, bounded by length and fenced structurally in the '
  'prompt. legacy = predates both, kept so NULL never has to mean two things.';
