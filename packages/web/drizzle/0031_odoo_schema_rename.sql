-- Rename odoo_schema → odoo_describe_model and add odoo_list_models to any
-- agent that previously had odoo_schema in its allowed_tools. Idempotent:
-- re-running on a migrated row leaves it unchanged because the WHERE clause
-- filters out already-migrated agents.

UPDATE agents
SET allowed_tools = (allowed_tools - 'odoo_schema')
  || '["odoo_list_models", "odoo_describe_model"]'::jsonb
WHERE allowed_tools @> '["odoo_schema"]'::jsonb
  AND NOT (allowed_tools @> '["odoo_describe_model"]'::jsonb);

-- Second pass: agents that have both odoo_schema and odoo_describe_model
-- (e.g. they were edited by a UI that auto-added the new names) — drop the
-- legacy entry but don't re-add the new ones.
UPDATE agents
SET allowed_tools = allowed_tools - 'odoo_schema'
WHERE allowed_tools @> '["odoo_schema"]'::jsonb;
