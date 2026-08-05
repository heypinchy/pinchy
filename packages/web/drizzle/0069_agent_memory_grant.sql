-- Memory becomes its own permission (`pinchy_memory`) instead of a side effect
-- of the `pinchy_write` file-write grant. See
-- plans/2026-08-05-agent-permissions-by-zone-design.md.
--
-- Three rules, in this order. All three are idempotent: re-running on a row
-- that already carries the grant is a no-op.

-- 1. Agents that HAVE memory today keep it. NOT optional — these agents were
--    granted the memory paths through pinchy_write and may already have written
--    to MEMORY.md / memory/. Without this rule the split would silently revoke
--    their access to files they wrote.
UPDATE agents
SET allowed_tools = allowed_tools || '["pinchy_memory"]'::jsonb
WHERE allowed_tools @> '["pinchy_write"]'::jsonb
  AND NOT (allowed_tools @> '["pinchy_memory"]'::jsonb);

-- 2. Every agent created from a curated template, applying the new default
--    policy retroactively: templates are generous, a from-scratch agent starts
--    empty. `custom` is the from-scratch template and is excluded.
--
--    This is the rule that repairs the reported case: no template ever granted
--    pinchy_write, so template-created agents had memory_search/memory_get and
--    no memory to search (#755).
UPDATE agents
SET allowed_tools = allowed_tools || '["pinchy_memory"]'::jsonb
WHERE template_id IS NOT NULL
  AND template_id <> 'custom'
  AND NOT (allowed_tools @> '["pinchy_memory"]'::jsonb);

-- 3. Personal agents (Smithers) carry no template_id — they are created by
--    createSmithersAgent, not from a template — so rule 2 misses them. They are
--    the case where memory is least controversial: the docs call the personal
--    agent the user's own notebook.
UPDATE agents
SET allowed_tools = allowed_tools || '["pinchy_memory"]'::jsonb
WHERE is_personal = true
  AND NOT (allowed_tools @> '["pinchy_memory"]'::jsonb);
