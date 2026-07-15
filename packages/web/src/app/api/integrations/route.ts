import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { withAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { encrypt, decrypt } from "@/lib/encryption";
import { deferAuditLog } from "@/lib/audit-deferred";
import { odooCredentialsSchema, odooConnectionDataSchema } from "@/lib/integrations/odoo-schema";
import { validateExternalUrl } from "@/lib/integrations/url-validation";
import { maskConnectionCredentials } from "@/lib/integrations/mask-credentials";
import { parseRequestBody } from "@/lib/api-validation";
import { listMcpTools, mcpErrorCodeFromError } from "@/lib/integrations/mcp-client";
import { MCP_PRESETS, type McpPresetId } from "@/lib/integrations/mcp-presets";
import { isMcpEnabled } from "@/lib/feature-flags";
import type { McpIntegrationData } from "@/lib/integrations/types";

// Single source of truth for the preset id enum — pulled from mcp-presets.ts
// so adding a preset there automatically flows into request validation
// without a second hardcoded list to keep in sync.
const mcpPresetIds = MCP_PRESETS.map((p) => p.id) as [McpPresetId, ...McpPresetId[]];

const mcpCreateSchema = z.object({
  type: z.literal("mcp"),
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(""),
  preset: z.enum(mcpPresetIds),
  transport: z.enum(["http", "sse"]),
  url: z.string().url(),
  token: z.string().min(1),
  // Per-connection metadata the MCP credential proxy injects as HTTP headers
  // alongside Authorization: Bearer <token> when forwarding to the upstream.
  // Today only HighLevel needs this (locationId Sub-Account ID); other
  // presets ignore it. Values are non-secret and stay in Pinchy's DB (never
  // openclaw.json) — see AGENTS.md § Secret Handling, Pattern B.
  extraHeaders: z.record(z.string(), z.string()).optional(),
});

const createIntegrationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("odoo"),
    name: z.string().min(1).max(100),
    description: z.string().max(500).default(""),
    credentials: odooCredentialsSchema,
    data: odooConnectionDataSchema.optional(),
  }),
  z.object({
    type: z.literal("web-search"),
    name: z.string().min(1).max(100),
    description: z.string().max(500).default(""),
    credentials: z.object({ apiKey: z.string().min(1) }),
  }),
  mcpCreateSchema,
]);

export const GET = withAdmin(async () => {
  const connections = await db.select().from(integrationConnections);

  // Decrypt per row and isolate failures: if ENCRYPTION_KEY changed (e.g. an
  // admin accidentally overrode the persisted key via .env), some rows can no
  // longer be decrypted. A single poison row must NOT crash the whole list —
  // that used to silently hide all integrations, including freshly-added ones
  // that would decrypt fine. Flag unreadable rows so the UI can offer Delete.
  const masked = connections.map((conn) => {
    try {
      return {
        ...conn,
        credentials: maskConnectionCredentials(conn.type, conn.credentials, decrypt),
        cannotDecrypt: false,
      };
    } catch (err) {
      console.warn(
        `[integrations] Cannot decrypt credentials for connection ${conn.id} (${conn.name}). ` +
          `ENCRYPTION_KEY may have changed. The admin can delete this row via the UI.`,
        err
      );
      return {
        id: conn.id,
        type: conn.type,
        name: conn.name,
        description: conn.description,
        data: null,
        createdAt: conn.createdAt,
        updatedAt: conn.updatedAt,
        credentials: null,
        cannotDecrypt: true,
      };
    }
  });

  return NextResponse.json(masked);
});

export const POST = withAdmin(async (request, _ctx, session) => {
  const parsed = await parseRequestBody(createIntegrationSchema, request);
  if ("error" in parsed) return parsed.error;

  // ── MCP branch ─────────────────────────────────────────────────────────
  // Kept separate from the odoo/web-search branch below: mcp's request shape
  // has no `credentials` field (the token is top-level) and needs a live
  // tool-discovery round trip before anything is persisted.
  if (parsed.data.type === "mcp") {
    // Flag off → behave as if the type doesn't exist at all, not a 500.
    if (!isMcpEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const { name, description, preset, transport, url, token, extraHeaders } = parsed.data;

    // HighLevel's MCP server 400s on tools/list without a locationId header
    // identifying the Sub-Account — catch the missing field before we even
    // try the upstream call.
    if (preset === "highlevel" && !extraHeaders?.locationId) {
      return NextResponse.json(
        { error: "HighLevel requires a locationId (Sub-Account ID) in extraHeaders" },
        { status: 400 }
      );
    }

    // Discover tools synchronously. listMcpTools() already SSRF-validates the
    // URL internally — no separate validateExternalUrl() call needed here.
    let tools;
    try {
      tools = await listMcpTools({ url, transport, token, extraHeaders });
    } catch (err) {
      // Nothing was persisted — this is pre-save validation, not a state
      // change, so (like the PATCH route's pre-persist probe failure) it is
      // not audited. `code` lets the dialog render a human-friendly,
      // preset-aware message (mcp-error-messages.ts) instead of the raw
      // protocol error; `detail` keeps that raw error for custom-server
      // debugging.
      const detail = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: "MCP discovery failed", detail, code: mcpErrorCodeFromError(err) },
        { status: 502 }
      );
    }

    const data: McpIntegrationData = {
      type: "mcp",
      preset,
      transport,
      url,
      tools,
      lastSyncAt: new Date().toISOString(),
      // Only persist extraHeaders when non-empty so the JSON column stays lean.
      ...(extraHeaders && Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
    };

    const [connection] = await db
      .insert(integrationConnections)
      .values({
        type: "mcp",
        name,
        description,
        credentials: encrypt(JSON.stringify({ token })),
        data,
      })
      .returning();

    deferAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "integration.created",
      resource: `integration:${connection.id}`,
      // `url` is the point of this row: what changed is that this deployment
      // can now reach a specific external endpoint. For preset "generic" the
      // URL is the only thing that identifies the server at all. It is an
      // admin-entered service address — not PII (no scrubbing needed) and not
      // a secret (the token lives in the encrypted credentials blob and must
      // never appear here).
      detail: { type: "mcp", name, preset, transport, url, toolCount: tools.length },
      outcome: "success",
    });

    return NextResponse.json(
      {
        ...connection,
        credentials: maskConnectionCredentials("mcp", connection.credentials, decrypt),
      },
      { status: 201 }
    );
  }

  // ── Odoo / web-search branch ──────────────────────────────────────────
  const { type, name, description, credentials } = parsed.data;

  // Singleton types: only one connection of this type allowed
  if (type === "web-search") {
    const existing = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.type, "web-search"));
    if (existing.length > 0) {
      return NextResponse.json(
        { error: "A Web Search connection already exists. Delete it first to add a new one." },
        { status: 409 }
      );
    }
  }

  if (parsed.data.type === "odoo") {
    const urlCheck = validateExternalUrl(parsed.data.credentials.url);
    if (!urlCheck.valid) {
      return NextResponse.json({ error: urlCheck.error }, { status: 400 });
    }
  }

  const encryptedCredentials = encrypt(JSON.stringify(credentials));
  const data = parsed.data.type === "odoo" ? (parsed.data.data ?? null) : null;

  const [connection] = await db
    .insert(integrationConnections)
    .values({
      type,
      name,
      description,
      credentials: encryptedCredentials,
      data,
    })
    .returning();

  deferAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "integration.created",
    resource: `integration:${connection.id}`,
    detail: { type, name },
    outcome: "success",
  });

  return NextResponse.json(
    {
      ...connection,
      credentials: maskConnectionCredentials(type, connection.credentials, decrypt),
    },
    { status: 201 }
  );
});
