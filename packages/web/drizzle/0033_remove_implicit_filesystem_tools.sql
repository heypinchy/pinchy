-- Remove `pinchy_ls` and `pinchy_read` from allowed_tools on every agent that
-- still has them. These tools were previously explicit entries in the tool
-- registry but are now implicit (always available) — keeping them in
-- allowed_tools causes them to appear as selectable toggles in the agent
-- settings UI, which is misleading.
--
-- Idempotent: re-running on an already-clean row is a no-op because the WHERE
-- clause only matches rows that contain one of the two legacy entries.

UPDATE agents
SET allowed_tools = (
  SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
  FROM jsonb_array_elements_text(allowed_tools::jsonb) AS t
  WHERE t NOT IN ('pinchy_ls', 'pinchy_read')
)
WHERE allowed_tools::jsonb @> '["pinchy_ls"]'::jsonb
   OR allowed_tools::jsonb @> '["pinchy_read"]'::jsonb;
