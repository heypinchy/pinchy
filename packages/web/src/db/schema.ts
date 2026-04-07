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
  numeric,
  pgEnum,
  pgView,
  primaryKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ── JSON Column Types ───────────────────────────────────────────────────
//
// Defined inline (not imported from @/lib/audit) to avoid a circular import:
// @/lib/audit imports the auditLog table from this file.

/**
 * Per-agent plugin configuration. Currently the only plugin that stores
 * config is `pinchy-files` (knowledge-base agents), which uses
 * `allowed_paths` to scope reads. Add new fields here as plugins evolve.
 */
export type AgentPluginConfig = {
  allowed_paths?: string[];
};

/**
 * Audit log detail payload. The shape varies per event type — the strict
 * shape is enforced at the appendAuditLog() call boundary via the
 * AuditLogEntry discriminated union in @/lib/audit. The base type here is
 * intentionally loose so the schema does not need to know every event
 * shape.
 */
export type AuditDetail = Record<string, unknown>;
import { isNull } from "drizzle-orm";

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
    ownerId: text("owner_id").references(() => users.id, { onDelete: "cascade" }),
    isPersonal: boolean("is_personal").notNull().default(false),
    visibility: text("visibility").notNull().default("restricted"),
    greetingMessage: text("greeting_message"),
    tagline: text("tagline"),
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
    rowHmac: text("row_hmac").notNull(),
  },
  (table) => [
    index("idx_audit_timestamp").on(table.timestamp),
    index("idx_audit_actor").on(table.actorId),
    index("idx_audit_event").on(table.eventType),
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
  },
  (table) => [
    index("idx_usage_timestamp").on(table.timestamp),
    index("idx_usage_user").on(table.userId),
    index("idx_usage_agent").on(table.agentId),
    index("idx_usage_session_key").on(table.sessionKey),
  ]
);

// ── Views ────────────────────────────────────────────────────────────

export const activeAgents = pgView("active_agents").as((qb) =>
  qb.select().from(agents).where(isNull(agents.deletedAt))
);
