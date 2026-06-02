import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { appendAuditLog } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";

type Actor = { type: "user" | "system"; id: string };

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
}
