-- v0.5.4-compat: Re-add `odoo_schema` to `allowed_tools` for every agent that
-- went through migration 0031 (i.e. every agent that currently has
-- `odoo_describe_model`). The plugin re-registers `odoo_schema` as a
-- deprecated alias that routes to the new compact path — but the tool can
-- only be invoked if it is in the agent's allowed_tools list.
--
-- This is the cheaper half of the v0.5.4 compat story. The other half is
-- that the pinchy-odoo plugin registers `odoo_schema` as an alias tool;
-- without that, the alias call would 404. Without this migration, the
-- alias call would be rejected at the permission layer before reaching
-- the plugin.
--
-- Idempotent: re-running on a row that already has `odoo_schema` is a no-op.

UPDATE agents
SET allowed_tools = allowed_tools || '["odoo_schema"]'::jsonb
WHERE allowed_tools @> '["odoo_describe_model"]'::jsonb
  AND NOT (allowed_tools @> '["odoo_schema"]'::jsonb);
