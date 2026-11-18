import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { appendAuditLog } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";

type Actor = { type: "user" | "system"; id: string };

/**
 * Rebuilds openclaw.json after an MCP connection's auth status changed.
 *
 * WHY HERE, NOT IN THE CALLERS — for MCP (and only for MCP) the auth status is
 * an input to the generated config: `build.ts` emits `mcp.servers` and the
 * per-agent `tools.allow` entries only for connections with status "active",
 * because MCP has no plugin to gate at runtime. So the transition IS the
 * config change, in both directions:
 *   - active → auth_failed: the server entry must drop out, or OpenClaw keeps
 *     retrying a failing initialize handshake on every reload and the config
 *     advertises a reachability that no longer exists.
 *   - auth_failed → active: the entry must come back, or the agent's existing
 *     grants stay fail-closed while the UI reports the connection healthy.
 * Every other integration type fetches credentials and checks permissions at
 * tool-call time, so its status never reaches openclaw.json — hence the `type`
 * gate, which keeps odoo/imap/google/microsoft/web-search behavior unchanged.
 *
 * Putting it at the transition instead of at each caller means the four call
 * sites that can flip an MCP connection (sync route, Test Connection ×3 —
 * every one of which was missed on the first pass) get it automatically, and
 * it fires only on REAL transitions: callers can't tell a genuine flip from a
 * no-op, since both functions return void and bail out when the conditional
 * UPDATE matches no rows.
 *
 * WHY FAILURES ARE SWALLOWED — the status change has already committed; a
 * failed config write must not be reported as a failure of the thing that
 * succeeded. Concretely, the Test Connection route's catch-all converts ANY
 * throw into `setIntegrationAuthFailed(reason: <the error>)`, so a propagating
 * regen throw on the recovery path would flip a *healthy* connection to
 * auth_failed purely because openclaw.json couldn't be written. The next
 * regenerate (any config-touching action, or boot-inits) heals it.
 * `regenerateOpenClawConfig` already returns silently on the EACCES restart
 * race (#314); this covers everything else.
 */
async function regenerateIfMcp(connectionType: string): Promise<void> {
  if (connectionType !== "mcp") return;
  try {
    await regenerateOpenClawConfig();
  } catch (err) {
    console.error(
      "[integrations] openclaw.json regenerate after an MCP auth-status change failed. The " +
        "status change itself is persisted; the config will heal on the next regenerate.",
      err
    );
  }
}

export async function setIntegrationAuthFailed(args: {
  connectionId: string;
  reason: string;
  actor: Actor;
}): Promise<void> {
  const { connectionId, reason, actor } = args;
  const [existing] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));
  if (!existing) return;

  const now = new Date();

  // Atomic transition: the UPDATE only fires when the row is NOT already in
  // auth_failed state. If a concurrent caller (e.g. sync + plugin-report
  // racing on the same connection) already flipped the status between our
  // SELECT and UPDATE, the WHERE excludes our row and `returning()` is empty
  // — we exit without writing a duplicate transition audit.
  const transitioned = await db
    .update(integrationConnections)
    .set({ status: "auth_failed", lastError: reason, lastErrorAt: now, updatedAt: now })
    .where(
      and(
        eq(integrationConnections.id, connectionId),
        ne(integrationConnections.status, "auth_failed")
      )
    )
    .returning({ id: integrationConnections.id });

  if (transitioned.length === 0) return;

  const entry = {
    actorType: actor.type,
    actorId: actor.id,
    eventType: "integration.auth_failed" as const,
    resource: `integration:${connectionId}`,
    detail: { id: connectionId, name: existing.name, reason },
    outcome: "success" as const,
  };
  try {
    await appendAuditLog(entry);
  } catch (err) {
    recordAuditFailure(err, entry);
  }

  await regenerateIfMcp(existing.type);
}

export async function clearIntegrationAuthError(args: {
  connectionId: string;
  actor: Actor;
}): Promise<void> {
  const { connectionId, actor } = args;
  const [existing] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));
  if (!existing) return;
  if (existing.status !== "auth_failed") return;

  // Same atomic-transition guard as setIntegrationAuthFailed: only flip back
  // and emit the recovery audit when we win the race.
  const transitioned = await db
    .update(integrationConnections)
    .set({ status: "active", lastError: null, lastErrorAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(integrationConnections.id, connectionId),
        eq(integrationConnections.status, "auth_failed")
      )
    )
    .returning({ id: integrationConnections.id });

  if (transitioned.length === 0) return;

  const entry = {
    actorType: actor.type,
    actorId: actor.id,
    eventType: "integration.auth_recovered" as const,
    resource: `integration:${connectionId}`,
    detail: { id: connectionId, name: existing.name },
    outcome: "success" as const,
  };
  try {
    await appendAuditLog(entry);
  } catch (err) {
    recordAuditFailure(err, entry);
  }

  await regenerateIfMcp(existing.type);
}
