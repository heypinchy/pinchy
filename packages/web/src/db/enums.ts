// Single source of truth for the enum-like `text` columns whose allowed values
// the database enforces via CHECK constraints (migration 0044, #259) and that
// the application assumes when it writes rows.
//
// Keeping the values here — instead of as string literals scattered across the
// schema, route handlers, and Zod validators — lets three things share one
// list:
//
//   1. `db/schema.ts` derives each CHECK's `IN (...)` SQL from the const, so the
//      constraint and this file can never drift.
//   2. The columns are `.$type<…>()`-typed from these unions, so any Drizzle
//      insert/update with an out-of-set value is a compile-time error.
//   3. The drift guard in `schema-hardening.integration.test.ts` reads the live
//      CHECK constraint back from Postgres and asserts it equals the const —
//      catching the one gap the two mechanisms above can't: a const change that
//      forgot to ship a migration (or vice versa).
//
// To add a value: extend the array here AND run `pnpm db:generate` to emit a
// migration that widens the corresponding CHECK. The drift guard fails loudly
// if the two get out of sync.

export const USER_ROLES = ["admin", "member"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const AGENT_VISIBILITIES = ["restricted", "all"] as const;
export type AgentVisibility = (typeof AGENT_VISIBILITIES)[number];

export const INVITE_ROLES = ["admin", "member"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export const INVITE_TYPES = ["invite", "reset"] as const;
export type InviteType = (typeof INVITE_TYPES)[number];

// Connection types the app writes today (`odoo`, `web-search`, `google`) plus
// the recognised email types (`microsoft`, `imap`). Expand via a new migration
// as integrations land — the plugin-first architecture means this list grows.
export const INTEGRATION_CONNECTION_TYPES = [
  "odoo",
  "web-search",
  "google",
  "microsoft",
  "imap",
] as const;
export type IntegrationConnectionType = (typeof INTEGRATION_CONNECTION_TYPES)[number];

export const INTEGRATION_CONNECTION_STATUSES = ["active", "pending", "auth_failed"] as const;
export type IntegrationConnectionStatus = (typeof INTEGRATION_CONNECTION_STATUSES)[number];

// Inbox Agent (#139). Status domains for the email-workflow tables. Enforced at
// the DB with CHECK constraints (see schema.ts) so untyped callers in later
// slices (dispatcher/route) can't write an out-of-domain status.
export const EMAIL_WORKFLOW_STATUSES = ["pending", "active", "error"] as const;
export type EmailWorkflowStatus = (typeof EMAIL_WORKFLOW_STATUSES)[number];

export const PROCESSED_EMAIL_STATUSES = ["processing", "done", "no_action", "failed"] as const;
export type ProcessedEmailStatus = (typeof PROCESSED_EMAIL_STATUSES)[number];
