import {
  pgTable,
  text,
  uuid,
  timestamp,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  serial,
  integer,
  bigint,
  numeric,
  pgEnum,
  pgView,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { isNull, sql, relations } from "drizzle-orm";
import {
  USER_ROLES,
  AGENT_VISIBILITIES,
  INVITE_ROLES,
  INVITE_TYPES,
  INTEGRATION_CONNECTION_TYPES,
  INTEGRATION_CONNECTION_STATUSES,
  type UserRole,
  type AgentVisibility,
  type InviteRole,
  type InviteType,
  type IntegrationConnectionType,
  type IntegrationConnectionStatus,
  EMAIL_WORKFLOW_STATUSES,
  type EmailWorkflowStatus,
  PROCESSED_EMAIL_STATUSES,
  type ProcessedEmailStatus,
  NOTIFICATION_STATUSES,
  type NotificationStatus,
  KB_INDEX_JOB_STATUSES,
  KB_INDEX_JOB_ACTIVE_STATUSES,
  type KbIndexJobStatus,
} from "./enums";
import type { EmailWorkflowFilter, ProcessedEmailOutcome } from "@/lib/email-workflows/types";
import type { IngestResult } from "@/lib/knowledge/ingest";
import { vector } from "./vector";

// Render `IN ('a', 'b')` from an enum const (db/enums.ts) so a CHECK constraint
// and its TypeScript source of truth can never drift. The values are enum-safe
// identifiers (no quotes or backslashes), so wrapping each in single quotes is
// sufficient. The drift guard in schema-hardening.integration.test.ts asserts
// the generated constraint matches the const against the live database.
const inEnum = (values: readonly string[]) =>
  sql.raw(`IN (${values.map((v) => `'${v}'`).join(", ")})`);

// ── JSON Column Types ───────────────────────────────────────────────────
//
// Defined inline (not imported from @/lib/audit) to avoid a circular import:
// @/lib/audit imports the auditLog table from this file.

/**
 * Per-agent plugin configuration, namespaced by plugin ID. Each plugin
 * stores its own config under its key. This allows multiple plugins
 * (pinchy-files, pinchy-web, etc.) to coexist in the same column.
 */
export type AgentPluginConfig = {
  "pinchy-files"?: {
    allowed_paths: string[];
    write_paths?: string[];
    allowed_extensions?: string[];
  };
  "pinchy-web"?: {
    allowedDomains?: string[];
    excludedDomains?: string[];
    language?: string;
    country?: string;
    freshness?: string;
  };
};

/**
 * Audit log detail payload. The shape varies per event type — the strict
 * shape is enforced at the appendAuditLog() call boundary via the
 * AuditLogEntry discriminated union in @/lib/audit. The base type here is
 * intentionally loose so the schema does not need to know every event
 * shape.
 */
export type AuditDetail = Record<string, unknown>;

// ── Better Auth tables ──────────────────────────────────────────────────

export const users = pgTable(
  "user",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    role: text("role").$type<UserRole>().notNull().default("member"),
    banned: boolean("banned").default(false),
    banReason: text("ban_reason"),
    banExpires: timestamp("ban_expires"),
    context: text("context"),
    // GDPR crypto-erasure pseudonym (EDPB 01/2025): appendAuditLog() substitutes
    // this random token for the raw user id when writing audit_log rows for
    // `actorType: "user"` events. The mapping lives in this mutable row, not in
    // the immutable, append-only audit_log — so deleting the user erases the
    // mapping, making all of that user's future-written audit rows
    // unlinkable, while the audit trail itself stays intact (Art. 17(3)).
    // Unrelated to `id`: a fresh random UUID, never derived from it.
    //
    // Both a DB-level DEFAULT and a Drizzle $defaultFn are set: $defaultFn
    // only fires for inserts that go through this Drizzle table object. Rows
    // inserted via a different path (Better Auth's own adapter queries, raw
    // SQL seeds, or any future non-Drizzle writer) would otherwise violate
    // the NOT NULL constraint. The DB default makes every insert path safe.
    auditPseudonym: text("audit_pseudonym")
      .default(sql`gen_random_uuid()::text`)
      .$defaultFn(() => crypto.randomUUID())
      .notNull()
      .unique(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [check("users_role_check", sql`${table.role} ${inEnum(USER_ROLES)}`)]
);

export const sessions = pgTable(
  "session",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)]
);

export const accounts = pgTable(
  "account",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    idToken: text("id_token"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("accounts_user_id_idx").on(table.userId)]
);

export const verification = pgTable("verification", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ── Application tables ─────────────────────────────────────────────────

export const agents = pgTable(
  "agents",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull().default("Smithers"),
    model: text("model").notNull(),
    templateId: text("template_id"),
    pluginConfig: jsonb("plugin_config").$type<AgentPluginConfig>(),
    allowedTools: jsonb("allowed_tools").$type<string[]>().notNull().default([]),
    // OpenClaw-native skill allowlist. Each entry is a Pinchy first-party
    // skill id (see KNOWN_SKILLS in src/lib/skills/index.ts). Emitted as
    // `agents.list[].skills` in openclaw.json; empty list correctly excludes
    // OC's 58 bundled desktop skills. See master issue #543.
    skills: jsonb("skills").$type<string[]>().notNull().default([]),
    ownerId: text("owner_id").references(() => users.id, { onDelete: "cascade" }),
    isPersonal: boolean("is_personal").notNull().default(false),
    visibility: text("visibility").$type<AgentVisibility>().notNull().default("restricted"),
    greetingMessage: text("greeting_message").notNull(),
    tagline: text("tagline"),
    // Per-agent starter prompts (#570): clickable suggestion chips shown in
    // the empty chat to lower the entry barrier for role-specific agents.
    // Empty array = no chips (the default).
    starterPrompts: jsonb("starter_prompts").$type<string[]>().notNull().default([]),
    avatarSeed: text("avatar_seed"),
    personalityPresetId: text("personality_preset_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("agents_owner_id_idx").on(table.ownerId),
    check("agents_visibility_check", sql`${table.visibility} ${inEnum(AGENT_VISIBILITIES)}`),
  ]
);

export const groups = pgTable("groups", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const userGroups = pgTable(
  "user_groups",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.groupId] }),
    index("user_groups_group_id_idx").on(table.groupId),
  ]
);

export const agentGroups = pgTable(
  "agent_groups",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.groupId] }),
    index("agent_groups_group_id_idx").on(table.groupId),
  ]
);

export const invites = pgTable(
  "invites",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tokenHash: text("token_hash").notNull().unique(),
    email: text("email"),
    role: text("role").$type<InviteRole>().notNull().default("member"),
    type: text("type").$type<InviteType>().notNull().default("invite"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    claimedAt: timestamp("claimed_at"),
    // `set null` (not cascade): deleting a user who claimed an invite keeps
    // the historical invite record (who was invited, by whom, when claimed)
    // and only nulls the claimer reference. Every other user-FK cascades, but
    // invites are audit-relevant history — cascading would lose the trail.
    claimedByUserId: text("claimed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    check("invites_role_check", sql`${table.role} ${inEnum(INVITE_ROLES)}`),
    check("invites_type_check", sql`${table.type} ${inEnum(INVITE_TYPES)}`),
    index("invites_created_by_idx").on(table.createdBy),
    index("invites_claimed_by_user_id_idx").on(table.claimedByUserId),
    index("invites_email_expires_at_idx").on(table.email, table.expiresAt),
  ]
);

export const inviteGroups = pgTable(
  "invite_groups",
  {
    inviteId: text("invite_id")
      .notNull()
      .references(() => invites.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.inviteId, table.groupId] })]
);

// ── Relations ───────────────────────────────────────────────────────────
//
// Declared so the Drizzle relational query builder (db.query.X.findMany)
// can fetch nested data with `with: { ... }` instead of manual leftJoin +
// post-hoc reshaping in route handlers.

export const usersRelations = relations(users, ({ many }) => ({
  userGroups: many(userGroups),
}));

export const groupsRelations = relations(groups, ({ many }) => ({
  userGroups: many(userGroups),
  inviteGroups: many(inviteGroups),
}));

export const userGroupsRelations = relations(userGroups, ({ one }) => ({
  user: one(users, { fields: [userGroups.userId], references: [users.id] }),
  group: one(groups, { fields: [userGroups.groupId], references: [groups.id] }),
}));

export const invitesRelations = relations(invites, ({ many }) => ({
  inviteGroups: many(inviteGroups),
}));

export const inviteGroupsRelations = relations(inviteGroups, ({ one }) => ({
  invite: one(invites, { fields: [inviteGroups.inviteId], references: [invites.id] }),
  group: one(groups, { fields: [inviteGroups.groupId], references: [groups.id] }),
}));

export const channelLinks = pgTable(
  "channel_links",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    channelUserId: text("channel_user_id").notNull(),
    linkedAt: timestamp("linked_at").notNull().defaultNow(),
  },
  (table) => [
    index("channel_links_user_id_idx").on(table.userId),
    uniqueIndex("channel_links_user_channel_uniq").on(table.userId, table.channel),
    uniqueIndex("channel_links_channel_user_id_uniq").on(table.channel, table.channelUserId),
  ]
);

/**
 * Durable per-channel conversation transcript owned by Pinchy (#541 follow-up).
 *
 * Pinchy captures inbound/outbound channel messages via the `pinchy-transcript`
 * OpenClaw plugin (message_received / message_sent hooks) and stores them here,
 * so the read-only conversation mirror renders from Pinchy's own record instead
 * of OpenClaw's session-scoped `chat.history`. That makes the mirror robust
 * against OpenClaw session semantics — `/new` resets, the 4 AM daily reset,
 * compaction, and id rotation no longer blank the view — and aligns the
 * conversation record with Pinchy's audit/governance model.
 *
 * `peerId` is the channel-side user id (e.g. the Telegram peer), lowercased to
 * match `channel_links.channelUserId` and the `agent:<id>:direct:<peer>`
 * session-key segment. `externalId` is the channel's own message id (or a
 * deterministic surrogate when the hook omits one) and is the idempotency key:
 * the capture endpoint upserts on (channel, agentId, peerId, direction,
 * externalId) so retries / duplicate hook fires never double-insert.
 */
export const channelMessages = pgTable(
  "channel_messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    peerId: text("peer_id").notNull(),
    direction: text("direction").notNull(),
    externalId: text("external_id").notNull(),
    content: text("content").notNull(),
    sentAt: timestamp("sent_at").notNull(),
    recordedAt: timestamp("recorded_at").notNull().defaultNow(),
  },
  (table) => [
    // Read path: one user's transcript for (agent, channel, peer), chronological.
    index("channel_messages_agent_channel_peer_idx").on(
      table.agentId,
      table.channel,
      table.peerId,
      table.sentAt
    ),
    // Idempotent capture: a given channel message is recorded once per direction.
    uniqueIndex("channel_messages_dedup_uniq").on(
      table.channel,
      table.agentId,
      table.peerId,
      table.direction,
      table.externalId
    ),
  ]
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  encrypted: boolean("encrypted").default(false),
});

// ── Audit Trail ──────────────────────────────────────────────────────

export const actorTypeEnum = pgEnum("actor_type", ["user", "agent", "system"]);

export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    eventType: text("event_type").notNull(),
    resource: text("resource"),
    detail: jsonb("detail").$type<AuditDetail>(),
    version: integer("version").notNull().default(1),
    outcome: text("outcome"), // 'success' | 'failure' | null (null only for v1)
    error: jsonb("error"), // { message: string } | null, only when outcome='failure'
    rowHmac: text("row_hmac").notNull(),
    // v3+ hash-chain link: the rowHmac of the immediately-preceding audit row
    // (null for the genesis row and for legacy v1/v2 rows). Binding each row to
    // its predecessor makes row deletion and reordering tamper-evident, not just
    // field tampering. See VERSIONING.md.
    prevHmac: text("prev_hmac"),
  },
  (table) => [
    index("idx_audit_timestamp").on(table.timestamp),
    index("idx_audit_actor").on(table.actorId),
    index("idx_audit_event").on(table.eventType),
    index("idx_audit_outcome").on(table.outcome),
    // Typical audit query: filter by resource, order by time descending. A
    // backward scan of this composite index serves it without a sort.
    index("idx_audit_resource_timestamp").on(table.resource, table.timestamp),
    check(
      "audit_log_v2_outcome_required",
      sql`${table.version} = 1 OR ${table.outcome} IS NOT NULL`
    ),
  ]
);

// ── Integration Connections ──────────────────────────────────────────

export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    type: text("type").$type<IntegrationConnectionType>().notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    credentials: text("credentials").notNull(), // AES-256-GCM encrypted JSON
    data: jsonb("data"), // Type-specific, Zod-validated (schema cache)
    status: text("status").$type<IntegrationConnectionStatus>().notNull().default("active"),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "integration_connections_type_check",
      sql`${table.type} ${inEnum(INTEGRATION_CONNECTION_TYPES)}`
    ),
    check(
      "integration_connections_status_check",
      sql`${table.status} ${inEnum(INTEGRATION_CONNECTION_STATUSES)}`
    ),
  ]
);

export const agentConnectionPermissions = pgTable(
  "agent_connection_permissions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    operation: text("operation").notNull(),
  },
  (table) => [
    uniqueIndex("uq_agent_conn_model_op").on(
      table.agentId,
      table.connectionId,
      table.model,
      table.operation
    ),
    index("idx_agent_conn_perms_agent").on(table.agentId),
    index("idx_agent_conn_perms_conn").on(table.connectionId),
  ]
);

// ── Inbox Agent: email workflows & processed-email ledger ────────────

// A workflow = a deterministic trigger+filter plus an agentic action, run by a
// specific agent against one or more mailboxes. See the design of record at
// docs/plans/2026-07-12-inbox-agent-design.md §5.
export const emailWorkflows = pgTable(
  "email_workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    filter: jsonb("filter").$type<EmailWorkflowFilter>().notNull(),
    action: text("action").notNull(),
    pollEvery: text("poll_every").notNull().default("5m"),
    sweepWindowDays: integer("sweep_window_days").notNull().default(14),
    enabled: boolean("enabled").notNull().default(false),
    status: text("status").$type<EmailWorkflowStatus>().notNull().default("pending"),
    openclawJobId: text("openclaw_job_id"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("email_workflows_agent_idx").on(table.agentId),
    // Partial index: the dispatcher only ever scans for enabled workflows, so
    // index just those rows (most workflows sit disabled) rather than the whole
    // low-cardinality boolean column.
    index("email_workflows_enabled_idx")
      .on(table.enabled)
      .where(sql`${table.enabled}`),
    check("email_workflows_status_check", sql`${table.status} ${inEnum(EMAIL_WORKFLOW_STATUSES)}`),
  ]
);

// One workflow can watch several mailboxes (design D9). `sinceTs` is the
// per-(workflow, connection) watermark set when a connection is added, so a new
// workflow never retroactively processes historical mail.
export const emailWorkflowConnections = pgTable(
  "email_workflow_connections",
  {
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => emailWorkflows.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    sinceTs: timestamp("since_ts").notNull(),
    addedAt: timestamp("added_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workflowId, table.connectionId] })]
);

// The ledger is the source of truth for processed-tracking. A claim is an atomic
// INSERT ... ON CONFLICT DO NOTHING on the unique key below (design D2/D3) —
// mirroring the channel_messages dedup pattern. An email is processed at most
// once per workflow, so a cursor-loss resync is safe (the sweep re-discovers,
// the ledger dedups). Real-world dedup ("does this invoice exist?") is the
// action layer's job, not the ledger's.
export const processedEmails = pgTable(
  "processed_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => emailWorkflows.id, { onDelete: "cascade" }),
    connectionId: text("connection_id").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    messageIdHeader: text("message_id_header"),
    status: text("status").$type<ProcessedEmailStatus>().notNull().default("processing"),
    outcome: jsonb("outcome").$type<ProcessedEmailOutcome>(),
    runId: text("run_id"),
    claimedAt: timestamp("claimed_at").notNull().defaultNow(),
    finalizedAt: timestamp("finalized_at"),
  },
  (table) => [
    // Atomic per-rule claim: an email is processed at most once per workflow.
    uniqueIndex("processed_emails_claim_uniq").on(
      table.workflowId,
      table.connectionId,
      table.providerMessageId
    ),
    index("processed_emails_status_idx").on(table.status),
    check(
      "processed_emails_status_check",
      sql`${table.status} ${inEnum(PROCESSED_EMAIL_STATUSES)}`
    ),
  ]
);

// One cursor per mailbox, shared by all workflows on it. The cursor is a
// performance optimization for "what's new"; the ledger + reconciliation sweep
// are the correctness layer. Advanced only after a tick's claims are durable.
export const emailConnectionCursors = pgTable("email_connection_cursors", {
  connectionId: text("connection_id")
    .primaryKey()
    .references(() => integrationConnections.id, { onDelete: "cascade" }),
  cursor: text("cursor").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ── Background Jobs: notifications / activity feed ────────────────────

// The output of a background run (Inbox Agent #139, Scheduled Briefings #138)
// lands here, never in chat (foundation #704). Deliberately source-agnostic:
// `sourceType` + `sourceId` reference the producing run / ledger row without a
// hard FK, so a notification survives deletion of its source (mirrors the
// ledger's FK-less connectionId) and either background feature can produce one
// without importing the other's run table. See the design of record at
// docs/plans/2026-07-13-slice-c-notifications-foundation.md.
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    title: text("title").notNull(),
    content: text("content").notNull(),
    status: text("status").$type<NotificationStatus>().notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("notifications_agent_created_idx").on(table.agentId, table.createdAt),
    check("notifications_status_check", sql`${table.status} ${inEnum(NOTIFICATION_STATUSES)}`),
  ]
);

// Per-user fan-out (foundation #704): one row per recipient, carrying that
// user's own read state (`readAt` null == unread). Written when the notification
// is created; the unread index powers the per-user activity-feed badge.
export const notificationRecipients = pgTable(
  "notification_recipients",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    deliveredAt: timestamp("delivered_at").notNull().defaultNow(),
    readAt: timestamp("read_at"),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.notificationId] }),
    index("notification_recipients_user_unread_idx").on(table.userId, table.readAt),
  ]
);

// ── Usage Tracking ───────────────────────────────────────────────────

export const usageRecords = pgTable(
  "usage_records",
  {
    id: serial("id").primaryKey(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    userId: text("user_id").notNull(),
    agentId: text("agent_id").notNull(),
    agentName: text("agent_name").notNull(),
    sessionKey: text("session_key").notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    estimatedCostUsd: numeric("estimated_cost_usd", {
      precision: 10,
      scale: 6,
    }),
    // Per-turn accounting (#483): the OpenClaw run id of the `model.completed`
    // turn this row records, plus the trajectory `seq` watermark. Both nullable
    // so the gauge poller (system sessions) and the /api/internal/usage/record
    // sink (plugin vision tokens) keep inserting without a run id.
    runId: text("run_id"),
    seq: integer("seq"),
    // How full the model's context window got on this turn — the size of the
    // prompt on the turn's LAST call, which is what the window has to hold.
    // Deliberately distinct from input_tokens: a turn drives a whole tool loop
    // and input_tokens sums every call in it (~11x larger in practice), so it
    // says nothing about context pressure.
    //
    // Counts every prompt class of that call — input + cacheRead + cacheWrite,
    // which the usage payload shows to be disjoint — since all three are tokens
    // the model read, differing only in how they are billed.
    //
    // Nullable: only the per-turn trajectory path can know it. The gauge poller
    // and the /api/internal/usage/record sink leave it NULL, as do events with
    // no usable promptCache — NULL means "unknown", never "empty".
    //
    // This is the read-side of the 2026-07-15 "Piper" incident: the agent ran at
    // ~170k context with compaction never firing (its window was configured at
    // 1M, so OpenClaw's shouldCompact threshold sat at ~1.03M) and started
    // fabricating tool results. Recovering those numbers meant SSHing into prod
    // and parsing trajectory JSONL by hand; with this column it is one query.
    // A drop between consecutive turns of a session is also how compaction
    // becomes visible — OpenClaw emits no compaction trajectory event.
    contextTokens: integer("context_tokens"),
  },
  (table) => [
    index("idx_usage_timestamp").on(table.timestamp),
    index("idx_usage_user").on(table.userId),
    index("idx_usage_agent").on(table.agentId),
    index("idx_usage_session_key").on(table.sessionKey),
    // "Usage for this user/agent over the last 30 days" is the hot query —
    // composite (entity, timestamp) indexes serve it via a backward scan
    // without a sort, supplementing the single-column indexes above.
    index("idx_usage_user_timestamp").on(table.userId, table.timestamp),
    index("idx_usage_agent_timestamp").on(table.agentId, table.timestamp),
    // Idempotent per-turn inserts: one row per (session, run). A plain unique
    // index suffices — Postgres treats NULLs as distinct (default NULLS
    // DISTINCT), so per-turn rows (run_id NOT NULL) dedup while the gauge poller
    // and the /api/internal/usage/record sink (run_id NULL) insert freely.
    // onConflictDoNothing(target [sessionKey, runId]) relies on this index.
    uniqueIndex("uq_usage_session_run").on(table.sessionKey, table.runId),
  ]
);

// ── Model Catalogue ──────────────────────────────────────────────────

export const models = pgTable(
  "models",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    displayName: text("display_name").notNull(),
    vision: boolean("vision"),
    longContext: boolean("long_context"),
    tools: boolean("tools"),
    source: text("source").notNull(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [uniqueIndex("uq_models_provider_modelid").on(t.provider, t.modelId)]
);

// ── Views ────────────────────────────────────────────────────────────

export const activeAgents = pgView("active_agents").as((qb) =>
  qb.select().from(agents).where(isNull(agents.deletedAt))
);

// ── File uploads ──────────────────────────────────────────────────────

export const uploadedFiles = pgTable(
  "uploaded_files",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    draftId: text("draft_id").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    contentHash: text("content_hash").notNull(),
    status: text("status", { enum: ["staged", "attached"] }).notNull(),
    stagingPath: text("staging_path"),
    expiresAt: timestamp("expires_at"),
    messageId: text("message_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    attachedAt: timestamp("attached_at"),
  },
  (t) => [
    index("idx_uploaded_files_gc").on(t.status, t.expiresAt),
    index("idx_uploaded_files_user_agent_draft").on(t.userId, t.agentId, t.draftId),
  ]
);

/**
 * Agent → user file delivery grants (#703). When an agent produces or fetches a
 * file into its workspace and hands it to the user in chat, a row here records
 * WHO may download it. This is the read-side authorization source for
 * `GET /api/agents/:agentId/artifacts/:filename` — the delivered-file analogue
 * of `uploadedFiles` for the user-upload route.
 *
 * Why a dedicated grant table (not reuse `uploadedFiles`): uploads model the
 * user→agent direction (staging, GC, draft/message lifecycle, content hash);
 * a delivery has none of that. Reusing that row would conflate provenance and
 * muddy the audit trail. Here the row is a pure capability: "user U may fetch
 * file F (in zone Z) from agent A".
 *
 * IDOR safety mirrors the uploads route: the serving route requires a row
 * matching `(agentId, filename, userId = caller)`. A shared agent's other
 * members hold no grant, so a predictable filename does not leak across users.
 * The bytes live under the agent workspace; the serving route searches the known
 * workspace zones (`workbench` for agent-generated files, `uploads` for
 * agent-fetched files) for the granted filename. `sessionKey` is the full
 * `agent:{agentId}:direct:{userId}` key the delivery happened in, kept for
 * history re-attachment and correlation (never read as a prefix).
 */
export const agentDeliveredFiles = pgTable(
  "agent_delivered_files",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    sessionKey: text("session_key").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // The serving route's authorization lookup: (agentId, filename, userId).
    index("idx_agent_delivered_files_lookup").on(t.agentId, t.filename, t.userId),
    // History re-attachment reads all grants for one session.
    index("idx_agent_delivered_files_session").on(t.sessionKey),
  ]
);

/**
 * Durable agent-error visibility (Concern 1). An OpenClaw error chunk surfaces
 * a live error bubble over the WS, but that bubble is ephemeral client state —
 * a reload or a WS reconnect during a long tool loop loses it, leaving only the
 * audit row. This table is the durable backing for the chat's "paused" banner:
 * the latest un-superseded, un-dismissed row for a session is what the user
 * sees on return.
 *
 * Why a dedicated table (not audit reuse): the audit log is append-only and
 * per-row HMAC-signed, so an UPDATE for supersededAt/dismissedAt would break
 * `verifyIntegrity`; its detail is PII-scrubbed/truncated and lacks the
 * clientMessageId/runId/sideEffects granularity; and we don't want chat loads
 * querying the compliance table on the hot path.
 *
 * `sessionKey` is the exact per-(agent,user) key `agent:{agentId}:direct:{userId}`
 * — reads MUST filter on the full value, never a prefix. `clientMessageId` is
 * the triggering user message, the anchor for both supersede (the same message
 * later succeeds) and a safe retry. `sideEffects` records whether the failed
 * run already executed a tool call, so the UI can warn about duplicate writes.
 */
export const chatSessionErrors = pgTable(
  "chat_session_errors",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    sessionKey: text("session_key").notNull(),
    clientMessageId: text("client_message_id"),
    runId: text("run_id"),
    agentName: text("agent_name").notNull(),
    model: text("model"),
    errorClass: text("error_class").notNull(),
    transientReason: text("transient_reason"),
    providerError: text("provider_error").notNull(),
    sideEffects: boolean("side_effects").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    supersededAt: timestamp("superseded_at"),
    dismissedAt: timestamp("dismissed_at"),
  },
  (t) => [
    // Active-error lookup: newest live row for a session.
    index("idx_chat_session_errors_session").on(t.sessionKey, t.createdAt),
    // GC sweep: reap resolved (superseded/dismissed) rows by age.
    index("idx_chat_session_errors_gc").on(t.createdAt),
  ]
);

// ── Audit Verify Checkpoint ──────────────────────────────────────────
//
// Singleton checkpoint (id is always 1) for the periodic incremental
// hash-chain verification job (audit-verify-job.ts). Tracks how far the
// last run scanned so subsequent runs only verify newly-appended rows,
// instead of re-walking the whole (unboundedly growing) audit_log every
// cycle. lastVerifiedHmac is the rowHmac of the row at lastVerifiedId — it
// seeds verifyIntegrity's boundary-link check so the link BETWEEN
// lastVerifiedId and lastVerifiedId+1 is never left unchecked (see
// verifyIntegrity's `seedPrevHmac` option).
export const auditVerifyState = pgTable("audit_verify_state", {
  id: integer("id").primaryKey(),
  lastVerifiedId: integer("last_verified_id").notNull().default(0),
  lastVerifiedHmac: text("last_verified_hmac"),
  lastStatus: text("last_status"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Knowledge Base (RAG) ─────────────────────────────────────────────
//
// kb_documents is the per-org, per-file source of truth for ingested
// knowledge-base content. (org_id, source_path) is the identity/idempotency
// key — re-ingesting the same path updates one row. content_hash is a
// change-detection column (same hash => skip, different hash => re-ingest),
// NOT an identity key. status lets later freshness work (Task 5+) archive
// stale docs without deleting history.
export const kbDocuments = pgTable(
  "kb_documents",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id").notNull(),
    contentHash: text("content_hash").notNull(),
    sourcePath: text("source_path").notNull(),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    lang: text("lang"),
    pageCount: integer("page_count"),
    mtime: timestamp("mtime"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // A document is keyed by its PATH: (org_id, source_path) is unique, so
    // re-ingesting the same path updates one row. content_hash is a
    // non-unique change-detection column — two different paths with
    // byte-identical content (e.g. an OLD/ archive copy) are DISTINCT
    // documents, which per-path allowed_paths filtering (Task 7) requires;
    // cross-path content dedup would break that filtering. The plain
    // (org_id, content_hash) index just speeds change-detection lookups.
    uniqueIndex("uq_kb_doc_org_path").on(t.orgId, t.sourcePath),
    index("idx_kb_doc_org_hash").on(t.orgId, t.contentHash),
  ]
);

// kb_chunks denormalizes org_id and source_path from the parent document so
// retrieval (Task 7) can filter by allowed_paths without a join. embedding
// is vector(768) (embeddinggemma-300m, see ./vector); the FTS tsv generated
// column + GIN index and the HNSW vector index are hand-added raw SQL in the
// generated migration (drizzle-kit cannot express either).
export const kbChunks = pgTable(
  "kb_chunks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    documentId: text("document_id")
      .notNull()
      .references(() => kbDocuments.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    sourcePath: text("source_path").notNull(),
    chunkText: text("chunk_text").notNull(),
    page: integer("page"),
    lang: text("lang"),
    embedding: vector("embedding"),
  },
  (t) => [
    index("idx_kb_chunks_doc").on(t.documentId),
    index("idx_kb_chunks_org_path").on(t.orgId, t.sourcePath),
  ]
);

// kb_index_jobs is the queue behind the async reindex (#714): the admin route
// enqueues a row, an in-process worker (src/server/kb-index-worker.ts) claims
// and runs it. Deliberately a plain table, not a queue engine — ingest is
// content-hash idempotent, so a crashed run recovers by re-running, which is
// the only guarantee a queue would have bought us.
//
// `paths` is a SNAPSHOT of the agent's granted folders resolved at enqueue
// time, not a pointer to them: the worker must index what was authorized when
// the admin asked, and re-reading the grants at run time would let a permission
// change silently widen a job already in flight.
export const kbIndexJobs = pgTable(
  "kb_index_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // Snapshotted beside the id so the completion audit row can carry the
    // {id, name} pair (AGENTS.md) without re-querying an agent that may have
    // been renamed or deleted while the job ran.
    agentName: text("agent_name").notNull(),
    requestedBy: text("requested_by").notNull(),
    paths: jsonb("paths").$type<string[]>().notNull(),
    status: text("status").$type<KbIndexJobStatus>().notNull().default("pending"),
    // Progress, in documents. `total` stays null until discovery has walked
    // every root — a total that grew as we went would make the progress bar
    // run backwards, so it is written once, upfront.
    total: integer("total"),
    processed: integer("processed").notNull().default(0),
    // The ingest's findings (IngestResult), written when the job reaches a
    // terminal state — on failure too, since partial counts are the operator's
    // only evidence of how far the run got.
    counts: jsonb("counts").$type<IngestResult>(),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [
    // At most one active index job per org. The index is corpus-wide and
    // embedding is CPU-bound on a 1.5-core container, so two concurrent runs
    // would race on the same (org_id, source_path) documents and thrash the
    // CPU for no throughput. This is the constraint the enqueue path relies on
    // to answer "busy" instead of queueing a duplicate — application code alone
    // could not make that atomic.
    uniqueIndex("uq_kb_index_jobs_active")
      .on(t.orgId)
      .where(sql`${t.status} ${inEnum(KB_INDEX_JOB_ACTIVE_STATUSES)}`),
    // Serves both the worker's claim ("oldest pending") and the status route's
    // "latest job for this agent".
    index("idx_kb_index_jobs_status_created").on(t.status, t.createdAt),
    index("idx_kb_index_jobs_agent_created").on(t.agentId, t.createdAt),
    check("kb_index_jobs_status_check", sql`${t.status} ${inEnum(KB_INDEX_JOB_STATUSES)}`),
  ]
);
