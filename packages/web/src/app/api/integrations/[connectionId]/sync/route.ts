import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { withAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { decrypt } from "@/lib/encryption";
import { odooCredentialsSchema } from "@/lib/integrations/odoo-schema";
import { deferAuditLog } from "@/lib/audit-deferred";
import { fetchOdooSchema } from "@/lib/integrations/odoo-sync";
import { validateExternalUrl } from "@/lib/integrations/url-validation";
import { setIntegrationAuthFailed, clearIntegrationAuthError } from "@/lib/integrations/auth-state";
import type { McpTool } from "@/lib/integrations/types";
import { isMcpEnabled } from "@/lib/feature-flags";

type RouteContext = { params: Promise<{ connectionId: string }> };

export const POST = withAdmin<RouteContext>(async (_req, { params }, session) => {
  const { connectionId } = await params;

  const [connection] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));

  if (!connection) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  // ── MCP sync ─────────────────────────────────────────────────────────────

  const data = connection.data as Record<string, unknown> | null;
  if (data?.type === "mcp") {
    if (!isMcpEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
    // Lazy-import MCP-specific modules so the Odoo path does not pull them in.
    const { listMcpTools } = await import("@/lib/integrations/mcp-client");
    const { diffMcpTools } = await import("@/lib/integrations/mcp-tool-diff");
    const { regenerateOpenClawConfig } = await import("@/lib/openclaw-config");

    const { token } = JSON.parse(decrypt(connection.credentials)) as { token: string };
    const before = (data.tools ?? []) as McpTool[];
    // Reuse any extra headers (e.g. HighLevel's locationId) the connection
    // was created with — otherwise sync would 400 on those servers.
    const extraHeaders = (data.extraHeaders ?? undefined) as Record<string, string> | undefined;

    let after: McpTool[];
    try {
      after = await listMcpTools({
        url: data.url as string,
        transport: data.transport as "http" | "sse",
        token,
        extraHeaders,
      });
    } catch (err) {
      // 401 from the upstream MCP server → flag the connection as auth_failed
      // (matches main's Odoo behaviour). Anything else → bubble up as a 500.
      const message = err instanceof Error ? err.message : String(err);
      const isAuthError =
        err instanceof Error && /unauthorized|401|forbidden|403/i.test(err.message);
      if (isAuthError) {
        await setIntegrationAuthFailed({
          connectionId,
          reason: message,
          actor: { type: "user", id: session.user.id! },
        });
        return NextResponse.json({ success: false, error: message, isAuthError: true });
      }
      return NextResponse.json({ success: false, error: message }, { status: 200 });
    }

    const diff = diffMcpTools(before, after);

    // Update only the connection row. Stale agentMcpToolPermissions are NOT
    // cascade-deleted — drift is detected at GET time so the admin sees a
    // one-shot toast for tools the agent had granted but the server no longer
    // exposes. The next PUT (saving permissions) overwrites the stale rows.
    await db
      .update(integrationConnections)
      .set({
        data: { ...data, tools: after, lastSyncAt: new Date().toISOString() },
        updatedAt: new Date(),
      })
      .where(eq(integrationConnections.id, connectionId));

    const auditTools = {
      added: diff.added.map((t) => ({ name: t.name })),
      removed: diff.removed.map((t) => ({ name: t.name })),
      total: after.length,
    };

    await clearIntegrationAuthError({
      connectionId,
      actor: { type: "user", id: session.user.id! },
    });

    deferAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "integration.synced",
      resource: `integration:${connectionId}`,
      detail: {
        id: connectionId,
        name: connection.name,
        tools: auditTools,
      },
      outcome: "success",
    });

    regenerateOpenClawConfig().catch((err: unknown) => {
      console.error("Failed to regenerate OpenClaw config after MCP sync:", err);
    });

    return NextResponse.json({ success: true, diff: auditTools });
  }

  // ── Odoo sync ─────────────────────────────────────────────────────────────

  try {
    const decrypted = JSON.parse(decrypt(connection.credentials));
    const parsed = odooCredentialsSchema.safeParse(decrypted);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid credentials format" },
        { status: 200 }
      );
    }

    const urlCheck = validateExternalUrl(parsed.data.url);
    if (!urlCheck.valid) {
      return NextResponse.json({ success: false, error: urlCheck.error }, { status: 200 });
    }

    const result = await fetchOdooSchema(parsed.data);
    if (!result.success) {
      if (result.isAuthError) {
        await setIntegrationAuthFailed({
          connectionId,
          reason: result.error,
          actor: { type: "user", id: session.user.id! },
        });
      }
      return NextResponse.json(result);
    }

    await db
      .update(integrationConnections)
      .set({ data: result.data, updatedAt: new Date() })
      .where(eq(integrationConnections.id, connectionId));

    await clearIntegrationAuthError({
      connectionId,
      actor: { type: "user", id: session.user.id! },
    });

    deferAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "integration.synced",
      resource: `integration:${connectionId}`,
      detail: {
        id: connectionId,
        name: connection.name,
        modelCount: result.models,
      },
      outcome: "success",
    });

    return NextResponse.json({
      success: true,
      models: result.models,
      lastSyncAt: result.lastSyncAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    return NextResponse.json({ success: false, error: message }, { status: 200 });
  }
});
