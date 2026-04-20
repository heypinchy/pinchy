# Changelog

All notable changes to Pinchy are documented here.

## v0.5.0 — 2026-04-20

### Added
- OpenAI ChatGPT subscription support via OAuth Device Code Flow. Admins can now connect a Plus/Pro subscription in Settings → Providers → OpenAI. See docs/guides/connect-chatgpt-subscription.
- `@pinchy/openai-subscription-oauth` workspace package (framework-agnostic OAuth 2.1 primitives).
- Auto-migration of agent models on auth-method switch (openai/* ↔ openai-codex/*).
- Proactive token refresh (every 15 min; refreshes tokens expiring within 30 min).

### Changed
- Provider configuration now supports `authMethods` in addition to `authType`.
