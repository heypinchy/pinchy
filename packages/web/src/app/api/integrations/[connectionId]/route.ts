import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { withAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { encrypt, decrypt } from "@/lib/encryption";
import { appendAuditLog } from "@/lib/audit";
import { odooCredentialsSchema } from "@/lib/integrations/odoo-schema";
import { validateExternalUrl } from "@/lib/integrations/url-validation";
import { maskConnectionCredentials } from "@/lib/integrations/mask-credentials";
import { deleteOAuthSettings } from "@/lib/integrations/oauth-settings";
import { probeIntegrationCredentials } from "@/lib/integrations/probe";
import { listMcpTools, mcpErrorCodeFromError } from "@/lib/integrations/mcp-client";
import { clearIntegrationAuthError } from "@/lib/integrations/auth-state";
import { z } from "zod";
import { parseRequestBody, formatValidationError } from "@/lib/api-validation";
import type { McpIntegrationData } from "@/lib/integrations/types";

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
  // MCP credential edit = token rotation. extraHeaders (e.g. HighLevel's
  // locationId) stays on connection.data and is reused during re-discovery.
  mcp: z
    .object({ token: z.string().min(1) })
    .strict()
    .partial(),
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
    if (existing.type === "google") {
      return NextResponse.json(
        {
          error:
            "Google credentials cannot be edited directly. Use Reconnect to start a new OAuth flow.",
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
      changes.name = { from: existing.name, to: body.name };
    }
  }
  if (body.description !== undefined) {
    updateData.description = body.description;
    if (body.description !== existing.description) {
      changes.description = { from: existing.description, to: body.description };
    }
  }
  if (parsedCredentials !== undefined) {
    // Merge with existing stored credentials so callers can omit unchanged fields
    // ("leave empty to keep current" pattern).
    const existingDecoded = JSON.parse(decrypt(existing.credentials)) as Record<string, unknown>;
    const merged = { ...existingDecoded, ...parsedCredentials };

    if (existing.type === "mcp") {
      // MCP can't go through the Odoo/web-search probe registry. Validate the
      // (rotated) token by re-discovering tools against the upstream server
      // using the connection's stored url/transport/extraHeaders, then persist
      // both the new token and the refreshed tool list.
      const data = existing.data as unknown as McpIntegrationData;
      let tools: Awaited<ReturnType<typeof listMcpTools>>;
      try {
        tools = await listMcpTools({
          url: data.url,
          transport: data.transport,
          token: merged.token as string,
          extraHeaders: data.extraHeaders,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return NextResponse.json(
          {
            error: "Couldn't verify the token with the MCP server.",
            detail,
            code: mcpErrorCodeFromError(err),
          },
          { status: 400 }
        );
      }
      updateData.credentials = encrypt(JSON.stringify(merged));
      updateData.data = { ...data, tools, lastSyncAt: new Date().toISOString() };
    } else {
      if (existing.type === "odoo" && "url" in parsedCredentials) {
        const urlCheck = validateExternalUrl(parsedCredentials.url as string);
        if (!urlCheck.valid) {
          return NextResponse.json({ error: urlCheck.error }, { status: 400 });
        }
      }

      // Probe before persisting.
      const probe = await probeIntegrationCredentials(existing.type, merged);
      if (!probe.success) {
        return NextResponse.json({ error: probe.reason }, { status: 400 });
      }

      // Apply fields the probe resolved (e.g. fresh `uid` after a login change).
      const finalCredentials = probe.freshCredentials
        ? { ...merged, ...probe.freshCredentials }
        : merged;

      updateData.credentials = encrypt(JSON.stringify(finalCredentials));
    }
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
      detail: { id: connectionId, name: updated.name, changes },
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
        name: updated.name,
        fields: Object.keys(parsedCredentials),
      },
      outcome: "success",
    });
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

  // Clear OAuth settings when the last Google connection is removed
  if (existing.type === "google") {
    const remainingGoogle = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.type, "google"));
    if (remainingGoogle.length === 0) {
      await deleteOAuthSettings("google");
    }
  }

  const deletedDetail: { id: string; name: string; type: string; mcp?: unknown } = {
    id: connectionId,
    name: existing.name,
    type: existing.type,
  };
  if (existing.type === "mcp" && existing.data) {
    const mcpData = existing.data as unknown as McpIntegrationData;
    deletedDetail.mcp = {
      preset: mcpData.preset,
      transport: mcpData.transport,
      url: mcpData.url,
    };
  }

  await appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "integration.deleted",
    resource: `integration:${connectionId}`,
    detail: deletedDetail,
    outcome: "success",
  });

  return NextResponse.json({ success: true });
});
