# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Breaking Changes

- **Pinchy-Odoo `odoo_schema` tool replaced.** Splits into `odoo_list_models` (lists permitted models — cheap discovery) and `odoo_describe_model` (compact-by-default field schema with optional `fields` filter, `limit`, and `verbose` parameters). Existing agents are auto-migrated on next startup: any agent with `odoo_schema` in its allowed-tools list gets `odoo_list_models` + `odoo_describe_model` instead. Reduces typical schema-call context cost by ~90 % and unblocks Bookkeeper-style flows on response-format-sensitive models (`ollama-cloud/gemini-3-flash-preview`).

- chat: Open chats keep running in the background while you navigate within Pinchy. A pulse dot in the sidebar shows active agents; a red dot indicates an error on the last turn. (#199)
