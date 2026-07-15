import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { withAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { encrypt, decrypt } from "@/lib/encryption";
import { appendAuditLog, scrubEmails } from "@/lib/audit";
import { odooCredentialsSchema } from "@/lib/integrations/odoo-schema";
import { imapEditSchema, mcpEditSchema } from "@/lib/schemas/integration-edit";
import { validateExternalUrl } from "@/lib/integrations/url-validation";
import { maskConnectionCredentials } from "@/lib/integrations/mask-credentials";
import { probeIntegrationCredentials } from "@/lib/integrations/probe";
import { getOAuthProvider } from "@/lib/integrations/oauth-providers";
import { clearIntegrationAuthError } from "@/lib/integrations/auth-state";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import type { McpIntegrationData } from "@/lib/integrations/types";
import { z } from "zod";
import { parseRequestBody, formatValidationError } from "@/lib/api-validation";

const updateConnectionSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    credentials: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const credentialSchemas: Record<string, z.ZodType> = {
  odoo: odooCredentialsSchema.partial(),
  "web-search": z
    .object({ apiKey: z.string().min(1) })
    .strict()
    .partial(),
  // IMAP reconnect/edit: shared with the client dialog so validation can't
  // drift. Ports coerce to number so the merged blob keeps numeric ports — the
  // pinchy-email plugin asserts a strict `typeof number` shape.
  imap: imapEditSchema,
  // MCP credential edit = token rotation. extraHeaders (e.g. HighLevel's
  // locationId) stays on connection.data and is reused during re-discovery.
  mcp: mcpEditSchema,
};

type RouteContext = { params: Promise<{ connectionId: string }> };

export const GET = withAdmin<RouteContext>(async (_req, { params }) => {
  const { connectionId } = await params;
  const [connection] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));

  if (!connection) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...connection,
    credentials: maskConnectionCredentials(connection.type, connection.credentials, decrypt),
  });
});

export const PATCH = withAdmin<RouteContext>(async (request, { params }, session) => {
  const { connectionId } = await params;

  // Load existing connection
  const [existing] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));

  if (!existing) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  const parsed = await parseRequestBody(updateConnectionSchema, request);
  if ("error" in parsed) return parsed.error;
  const body = parsed.data;

  // Validate credentials based on connection type
  const rawCredentials = body.credentials;
  let parsedCredentials: Record<string, unknown> | undefined;
  if (rawCredentials !== undefined) {
    const oauthProvider = getOAuthProvider(existing.type);
    if (oauthProvider) {
      return NextResponse.json(
        {
          error: `${oauthProvider.label} credentials cannot be edited directly. Use Reconnect to start a new OAuth flow.`,
        },
        { status: 400 }
      );
    }
    const credSchema = credentialSchemas[existing.type];
    if (!credSchema) {
      return NextResponse.json(
        { error: `Unknown connection type: ${existing.type}` },
        { status: 400 }
      );
    }
    const credResult = credSchema.safeParse(rawCredentials);
    if (!credResult.success) {
      return formatValidationError(credResult.error);
    }
    parsedCredentials = credResult.data as Record<string, unknown>;
  }

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  if (body.name !== undefined) {
    updateData.name = body.name;
    if (body.name !== existing.name) {
      // IMAP connection names default to the mailbox address, so a rename diff
      // can carry a raw email on either side — scrub before it hits the log.
      changes.name = {
        from: existing.name ? scrubEmails(existing.name) : existing.name,
        to: scrubEmails(body.name),
      };
    }
  }
  if (body.description !== undefined) {
    updateData.description = body.description;
    if (body.description !== existing.description) {
      changes.description = { from: existing.description, to: body.description };
    }
  }
  if (parsedCredentials !== undefined) {
    if (existing.type === "odoo" && "url" in parsedCredentials) {
      const urlCheck = validateExternalUrl(parsedCredentials.url as string);
      if (!urlCheck.valid) {
        return NextResponse.json({ error: urlCheck.error }, { status: 400 });
      }
    }

    // Merge with existing stored credentials so callers can omit unchanged fields
    // ("leave empty to keep current" pattern).
    const existingDecoded = JSON.parse(decrypt(existing.credentials)) as Record<string, unknown>;
    const merged = { ...existingDecoded, ...parsedCredentials };

    // Probe before persisting. `existing.data` is passed through so the mcp
    // branch can read the stored url/transport/extraHeaders — every other
    // branch ignores the third argument.
    const probe = await probeIntegrationCredentials(
      existing.type,
      merged,
      existing.data as Record<string, unknown> | null
    );
    if (!probe.success) {
      return NextResponse.json({ error: probe.reason }, { status: 400 });
    }

    // Apply fields the probe resolved (e.g. fresh `uid` after a login change).
    const finalCredentials = probe.freshCredentials
      ? { ...merged, ...probe.freshCredentials }
      : merged;

    updateData.credentials = encrypt(JSON.stringify(finalCredentials));
    // NOTE: credential changes intentionally do NOT go into `changes` — they
    // get their own dedicated `integration.credentials_updated` event below,
    // which gives CISOs a clean filter for "all credential touches" without
    // having to also union "config.changed where details.changes.credentials
    // exists". One mutation → one audit row.
  }

  const [updated] = await db
    .update(integrationConnections)
    .set(updateData)
    .where(
      parsedCredentials !== undefined
        ? and(
            eq(integrationConnections.id, connectionId),
            eq(integrationConnections.credentials, existing.credentials)
          )
        : eq(integrationConnections.id, connectionId)
    )
    .returning();

  if (!updated) {
    return NextResponse.json(
      {
        error:
          parsedCredentials !== undefined
            ? "Credentials were updated concurrently, please try again"
            : "Connection not found",
      },
      { status: parsedCredentials !== undefined ? 409 : 404 }
    );
  }

  if (Object.keys(changes).length > 0) {
    await appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "integration.updated",
      resource: `integration:${connectionId}`,
      detail: { id: connectionId, name: scrubEmails(updated.name), changes },
      outcome: "success",
    });
  }

  if (parsedCredentials !== undefined) {
    await clearIntegrationAuthError({
      connectionId,
      actor: { type: "user", id: session.user.id! },
    });
    await appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "integration.credentials_updated",
      resource: `integration:${connectionId}`,
      detail: {
        id: connectionId,
        name: scrubEmails(updated.name),
        fields: Object.keys(parsedCredentials),
      },
      outcome: "success",
    });

    // No config regenerate here, for any type. The only config-relevant thing
    // a credential edit can do is recover an MCP connection from auth_failed
    // (build.ts filters mcp.servers/tools.allow to status==="active"), and
    // clearIntegrationAuthError above already triggers that at the status
    // transition itself — see auth-state.ts. Nothing else in a credential edit
    // reaches openclaw.json: for MCP, mcpEditSchema is token-only and the
    // token is fetched by the proxy per request rather than emitted into the
    // config; for every other type, credentials were never in the config
    // either.
  }

  return NextResponse.json({
    ...updated,
    credentials: maskConnectionCredentials(updated.type, updated.credentials, decrypt),
  });
});

export const DELETE = withAdmin<RouteContext>(async (_req, { params }, session) => {
  const { connectionId } = await params;

  // Load connection for audit log (need name + type before deletion)
  const [existing] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));

  if (!existing) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  await db.delete(integrationConnections).where(eq(integrationConnections.id, connectionId));

  // The OAuth app has an independent lifecycle: removing the last connection of a
  // provider intentionally leaves the stored app credentials in place. Admins manage
  // the app explicitly via the "Connected apps" section (Edit/Reset).

  // MCP: snapshot the server identity before it's unrecoverable. AGENTS.md
  // requires delete events to carry what the deleted row can no longer answer
  // — for an MCP connection that's *which external endpoint* the agents could
  // reach, which is the whole question a CISO brings to this log. The URL is
  // an admin-entered service address (not PII, not a secret); the token stays
  // in the encrypted credentials blob and never lands here.
  const mcpData = existing.type === "mcp" ? (existing.data as McpIntegrationData | null) : null;
  const mcpIdentity = mcpData
    ? { preset: mcpData.preset, transport: mcpData.transport, url: mcpData.url }
    : undefined;

  await appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "integration.deleted",
    resource: `integration:${connectionId}`,
    detail: {
      id: connectionId,
      name: scrubEmails(existing.name),
      type: existing.type,
      ...mcpIdentity,
    },
    outcome: "success",
  });

  // MCP-only (T6): unlike Odoo/email, MCP gating lives entirely in
  // openclaw.json (mcp.servers + tools.allow). Without regenerating here, a
  // deleted connection's server entry and any agent's tools.allow names for
  // it would linger until an unrelated regenerate happened to notice — the
  // per-request proxy 404 (T4's Gone-Contract) degrades that window
  // gracefully, but is a safety net, not a substitute for prompt cleanup.
  if (existing.type === "mcp") {
    await regenerateOpenClawConfig();
  }

  return NextResponse.json({ success: true });
});
