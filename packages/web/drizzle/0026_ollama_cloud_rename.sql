-- Rename ollama_api_key to ollama_cloud_api_key in settings table.
-- Safe: Ollama Cloud provider has not been released yet, so no production data affected.
UPDATE "settings" SET "key" = 'ollama_cloud_api_key' WHERE "key" = 'ollama_api_key';
