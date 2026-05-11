import { eq } from "drizzle-orm";
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
  await db
    .update(integrationConnections)
    .set({ status: "auth_failed", lastError: reason, lastErrorAt: now, updatedAt: now })
    .where(eq(integrationConnections.id, connectionId));

  // Only audit the *transition* — not every duplicate failure.
  if (existing.status !== "auth_failed") {
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

  await db
    .update(integrationConnections)
    .set({ status: "active", lastError: null, lastErrorAt: null, updatedAt: new Date() })
    .where(eq(integrationConnections.id, connectionId));

  const entry = {
    actorType: actor.type,
    actorId: actor.id,
    eventType: "integration.recovered" as const,
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
