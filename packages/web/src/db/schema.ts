import {
  pgTable,
  text,
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

export const users = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("member"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
  context: text("context"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sessions = pgTable("session", {
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
});

export const accounts = pgTable("account", {
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
});

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
    visibility: text("visibility").notNull().default("restricted"),
    greetingMessage: text("greeting_message").notNull(),
    tagline: text("tagline"),
    // Per-agent starter prompts (#570): clickable suggestion chips shown in
    // the empty chat to lower the entry barrier for role-specific agents.
    // Empty array = no chips (the default).
    starterPrompts: jsonb("starter_prompts").$type<string[]>().notNull().default([]),
    avatarSeed: text("avatar_seed"),
    personalityPresetId: text("personality_preset_id"),
    createdAt: timestamp("created_at").defaultNow(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [index("agents_owner_id_idx").on(table.ownerId)]
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
  (table) => [primaryKey({ columns: [table.userId, table.groupId] })]
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
  (table) => [primaryKey({ columns: [table.agentId, table.groupId] })]
);

export const invites = pgTable("invites", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  tokenHash: text("token_hash").notNull().unique(),
  email: text("email"),
  role: text("role").notNull().default("member"),
  type: text("type").notNull().default("invite"),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  claimedAt: timestamp("claimed_at"),
  claimedByUserId: text("claimed_by_user_id").references(() => users.id),
});

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
    check(
      "audit_log_v2_outcome_required",
      sql`${table.version} = 1 OR ${table.outcome} IS NOT NULL`
    ),
  ]
);

// ── Integration Connections ──────────────────────────────────────────

export const integrationConnections = pgTable("integration_connections", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  type: text("type").notNull(), // 'odoo', future: 'shopify', 'datev'
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  credentials: text("credentials").notNull(), // AES-256-GCM encrypted JSON
  data: jsonb("data"), // Type-specific, Zod-validated (schema cache)
  status: text("status").notNull().default("active"), // 'active' | 'pending' | 'auth_failed'
  lastError: text("last_error"),
  lastErrorAt: timestamp("last_error_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

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
  },
  (table) => [
    index("idx_usage_timestamp").on(table.timestamp),
    index("idx_usage_user").on(table.userId),
    index("idx_usage_agent").on(table.agentId),
    index("idx_usage_session_key").on(table.sessionKey),
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
