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
import { listMcpTools, McpAuthError } from "@/lib/integrations/mcp-client";
import { diffMcpTools } from "@/lib/integrations/mcp-tool-diff";
import { isMcpEnabled } from "@/lib/feature-flags";
import type { McpIntegrationData } from "@/lib/integrations/types";

type RouteContext = { params: Promise<{ connectionId: string }> };

// Keeps the audit `detail` well under AGENTS.md's 2048-byte cap even for a
// server exposing dozens of tools — summarize to a count instead of listing
// every name once the list gets long (AGENTS.md: "Summarize bulk operations").
const MAX_TOOL_NAMES_IN_AUDIT = 20;

function summarizeToolNames(names: string[]): string[] | { count: number } {
  return names.length > MAX_TOOL_NAMES_IN_AUDIT ? { count: names.length } : names;
}

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
  if (connection.type === "mcp") {
    // Flag off → behave as if the type doesn't exist, not a 500.
    if (!isMcpEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const actor = { type: "user" as const, id: session.user.id! };

    try {
      const data = connection.data as McpIntegrationData;
      const decrypted = JSON.parse(decrypt(connection.credentials)) as { token?: unknown };
      const token = typeof decrypted.token === "string" ? decrypted.token : "";

      let after;
      try {
        after = await listMcpTools({
          url: data.url,
          transport: data.transport,
          token,
          extraHeaders: data.extraHeaders,
        });
      } catch (err) {
        if (err instanceof McpAuthError) {
          // A real auth failure (401/403) — the token itself is the problem,
          // so (and only so) the connection flips to auth_failed.
          const reason =
            "The server rejected this token. Check that it hasn't expired and has the permissions it needs, then reconnect.";
          await setIntegrationAuthFailed({ connectionId, reason, actor });
          return NextResponse.json({ success: false, error: reason }, { status: 200 });
        }
        // McpServerError (5xx/429), McpSchemaError, or a network/timeout
        // failure — fail-safe transient: a broken or slow server is not
        // proof the token is wrong, so status must NOT flip to auth_failed
        // and the stored tools must NOT be overwritten. Mirrors probe.ts's
        // mcp branch and the odoo branch below (isAuthError-gated).
        return NextResponse.json(
          { success: false, error: "Couldn't reach the server right now. Try again in a moment." },
          { status: 200 }
        );
      }

      const diff = diffMcpTools(data.tools, after);
      const lastSyncAt = new Date().toISOString();

      await db
        .update(integrationConnections)
        .set({ data: { ...data, tools: after, lastSyncAt }, updatedAt: new Date() })
        .where(eq(integrationConnections.id, connectionId));

      await clearIntegrationAuthError({ connectionId, actor });

      deferAuditLog({
        actorType: "user",
        actorId: session.user.id!,
        eventType: "integration.synced",
        resource: `integration:${connectionId}`,
        detail: {
          id: connectionId,
          name: connection.name,
          tools: {
            added: summarizeToolNames(diff.added.map((t) => t.name)),
            removed: summarizeToolNames(diff.removed.map((t) => t.name)),
            total: after.length,
          },
        },
        outcome: "success",
      });

      return NextResponse.json({
        success: true,
        tools: after.length,
        lastSyncAt,
        diff: { added: diff.added.length, removed: diff.removed.length },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync failed";
      return NextResponse.json({ success: false, error: message }, { status: 200 });
    }
  }

  // ── Odoo sync ────────────────────────────────────────────────────────────
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
