-- Namespace existing plugin_config by plugin ID.
-- Transforms flat { allowed_paths: [...] } → { "pinchy-files": { allowed_paths: [...] } }
-- Only affects rows that have the old flat format (contain 'allowed_paths' key).
UPDATE agents
SET plugin_config = jsonb_build_object('pinchy-files', plugin_config)
WHERE plugin_config IS NOT NULL
  AND plugin_config ? 'allowed_paths';
