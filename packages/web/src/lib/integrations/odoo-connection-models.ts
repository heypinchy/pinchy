import { eq } from "drizzle-orm";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";

interface ModelAccessData {
  model: string;
  name: string;
  access?: { read: boolean; create: boolean; write: boolean; delete: boolean };
}

/**
 * Load the cached model list from the oldest Odoo connection.
 * Ordering by createdAt makes the choice deterministic when multiple
 * connections exist (without an explicit order, Postgres row order is
 * undefined and the picked connection could change between requests).
 * Returns null if no connection exists or has no cached models.
 */
export async function getConnectionModels(): Promise<ModelAccessData[] | null> {
  const connections = await db
    .select({ data: integrationConnections.data })
    .from(integrationConnections)
    .where(eq(integrationConnections.type, "odoo"))
    .orderBy(integrationConnections.createdAt);

  if (connections.length === 0) return null;

  const data = connections[0].data as { models?: ModelAccessData[] } | null;
  return data?.models ?? null;
}
