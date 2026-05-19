# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **Startup warning when Domain Lock is configured but `BETTER_AUTH_URL` is unset.** Better Auth's own `baseURL` detection does not read Pinchy's Domain Lock value (verified on staging v0.5.4 — Better Auth still logged `Base URL could not be determined`). A Domain-Locked deployment without `BETTER_AUTH_URL` silently sends password-reset and email-verification links pointing at the wrong host. Pinchy now logs `⚠ Domain Lock is configured (<domain>) but BETTER_AUTH_URL is unset…` on every startup of such a deployment, with the exact env-var assignment to copy-paste. The existing `BETTER_AUTH_URL is set` warning is retained, but is now emitted after `bootInits()` so both arms share a single call site. (#352)

### Fixed

- **Pinchy-Odoo: `odoo_read`, `odoo_count`, `odoo_aggregate` now accepted by OpenAI's strict function-calling validator.** The `filters` parameter schema declared a nested array (`type: "array"` of `type: "array"`) without an inner `items` definition. OpenAI rejected the request with `400 Invalid schema for function 'odoo_aggregate': In context=('properties','filters','items'), array schema missing items.`, surfaced in the UI as `OpenClaw error chunk: LLM request failed: provider rejected the request schema or tool payload`. Anthropic and Ollama accept the looser schema, so the regression was invisible on those providers. A new drift-guard test (`openai-schema-compat`) walks every Pinchy-Odoo tool schema and fails the build if any `type: array` is missing `items`.

### Breaking Changes

- **Pinchy-Odoo: opaque self-refs on every record.** `odoo_create` now returns `{id, _pinchy_ref}` (was `{id}`), and every record from `odoo_read` gains a `_pinchy_ref` field. Read-write operator templates (Bookkeeper, Warehouse Operator, HR Operator, Project Manager, Production Operator, Approval Manager) can now chain `odoo_create` → `odoo_attach_file` directly: pass the returned `_pinchy_ref` as `targetRef`. The previous behaviour — `odoo_create` returning only a raw integer `id` with no path for the LLM to obtain a valid encrypted ref — made `odoo_attach_file` unreachable in fresh-create flows. The field is named `_pinchy_ref` (not `ref`) to avoid shadowing Odoo's own `ref` field on `account.move` / `account.payment` etc. Old downstream tools that accept raw `ids` (`odoo_write`, `odoo_delete`, etc.) are unchanged.

- **Pinchy-Odoo: read-write operator templates now request all foreign-key lookup models they need.** Bookkeeper-style agents previously could not enumerate `account.account` (chart of accounts) when posting bills, because the template only listed write targets (`account.move`, `account.move.line`) and not the read-only models referenced by their foreign keys (`account_id`, `currency_id`, …). Same fix applied to CRM Assistant, Procurement Agent, Project Manager, Production Operator and Approval Manager. The Odoo sync probe list now also includes `res.users` so manager assignments work without a manual "Add model" step. A new drift-guard test (`agent-templates-fk-deps`) keeps the requiredModels list in sync with realistic FK dependencies for future template changes. Existing Odoo connections need a re-sync (Settings → Integrations → Odoo → ⋯ → Sync now) to pick up the new models.

- **Pinchy-Odoo: integration-ref encryption key now auto-provisioned through pinchy-web.** Before %%PINCHY_VERSION%%, `odoo_attach_file` and related write tools could fail with "Invalid integration reference" on freshly upgraded deployments because the `PINCHY_REF_TOKEN_KEY` env var was not set and the in-container `/app/secrets` fallback directory didn't exist in the OpenClaw image. pinchy-web now generates a key on first `regenerateOpenClawConfig()` call, persists it in the settings DB (alongside `openclaw_gateway_token`), and materialises it into the shared `secrets.json` bundle so the OC-side `pinchy-odoo` plugin can read it. No customer action required; the key is created automatically on the next pinchy startup after upgrade. Setting `PINCHY_REF_TOKEN_KEY` as an env-var override is still respected for dev/test.

- **Pinchy-Odoo `odoo_schema` tool replaced.** Splits into `odoo_list_models` (lists permitted models — cheap discovery) and `odoo_describe_model` (compact-by-default field schema with optional `fields` filter, `limit`, and `verbose` parameters). Existing agents are auto-migrated on next startup: any agent with `odoo_schema` in its allowed-tools list gets `odoo_list_models` + `odoo_describe_model` instead. Reduces typical schema-call context cost by ~90 % and unblocks Bookkeeper-style flows on response-format-sensitive models (`ollama-cloud/gemini-3-flash-preview`). The old `odoo_schema` tool name is kept as a deprecated alias so existing `AGENTS.md` files that reference it (Bookkeeper, HR Operator, Warehouse Operator, etc. created before v0.5.4) keep working — calls through the alias now use the compact format too. The alias is slated for removal in v0.6.x.

- chat: Open chats keep running in the background while you navigate within Pinchy. A pulse dot in the sidebar shows active agents; a red dot indicates an error on the last turn. (#199)
