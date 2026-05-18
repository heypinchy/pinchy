# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Breaking Changes

- **Pinchy-Odoo: integration-ref encryption key now auto-provisioned through pinchy-web.** Before %%PINCHY_VERSION%%, `odoo_attach_file` and related write tools could fail with "Invalid integration reference" on freshly upgraded deployments because the `PINCHY_REF_TOKEN_KEY` env var was not set and the in-container `/app/secrets` fallback directory didn't exist in the OpenClaw image. pinchy-web now generates a key on first `regenerateOpenClawConfig()` call, persists it in the settings DB (alongside `openclaw_gateway_token`), and materialises it into the shared `secrets.json` bundle so the OC-side `pinchy-odoo` plugin can read it. No customer action required; the key is created automatically on the next pinchy startup after upgrade. Setting `PINCHY_REF_TOKEN_KEY` as an env-var override is still respected for dev/test.

- **Pinchy-Odoo `odoo_schema` tool replaced.** Splits into `odoo_list_models` (lists permitted models — cheap discovery) and `odoo_describe_model` (compact-by-default field schema with optional `fields` filter, `limit`, and `verbose` parameters). Existing agents are auto-migrated on next startup: any agent with `odoo_schema` in its allowed-tools list gets `odoo_list_models` + `odoo_describe_model` instead. Reduces typical schema-call context cost by ~90 % and unblocks Bookkeeper-style flows on response-format-sensitive models (`ollama-cloud/gemini-3-flash-preview`). The old `odoo_schema` tool name is kept as a deprecated alias so existing `AGENTS.md` files that reference it (Bookkeeper, HR Operator, Warehouse Operator, etc. created before v0.5.4) keep working — calls through the alias now use the compact format too. The alias is slated for removal in v0.6.x.

- chat: Open chats keep running in the background while you navigate within Pinchy. A pulse dot in the sidebar shows active agents; a red dot indicates an error on the last turn. (#199)
