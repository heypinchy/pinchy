import { db } from "@/db";
import { agents } from "@/db/schema";
import { and, isNull, like, or, eq } from "drizzle-orm";
import { toCodexModel, toOpenAiModel } from "@/lib/openai-model-mapping";
import { appendAuditLog } from "@/lib/audit";

export interface MigratedAgent {
  id: string;
  name: string;
  from: string;
  to: string;
}

export async function migrateAgentsToCodex(): Promise<MigratedAgent[]> {
  const rows = await db
    .select({ id: agents.id, name: agents.name, model: agents.model })
    .from(agents)
    .where(and(isNull(agents.deletedAt), like(agents.model, "openai/%")));

  const migrated: MigratedAgent[] = [];

  for (const agent of rows) {
    if (!agent.model || !agent.model.startsWith("openai/")) continue;
    const targetModel = toCodexModel(agent.model) ?? "openai-codex/gpt-4o-mini";

    await db.update(agents).set({ model: targetModel }).where(eq(agents.id, agent.id)).returning();

    await appendAuditLog({
      eventType: "agent.updated",
      actorType: "system",
      actorId: "system",
      resource: agent.id,
      outcome: "success",
      detail: {
        changes: {
          model: { from: agent.model, to: targetModel },
        },
        reason: "auth_method_switch",
      },
    });

    migrated.push({ id: agent.id, name: agent.name, from: agent.model, to: targetModel });
  }

  return migrated;
}

export async function migrateAgentsToApiKey(): Promise<MigratedAgent[]> {
  const rows = await db
    .select({ id: agents.id, name: agents.name, model: agents.model })
    .from(agents)
    .where(and(isNull(agents.deletedAt), like(agents.model, "openai-codex/%")));

  const migrated: MigratedAgent[] = [];

  for (const agent of rows) {
    if (!agent.model) continue;
    const targetModel = toOpenAiModel(agent.model) ?? "openai/gpt-4o-mini";

    await db.update(agents).set({ model: targetModel }).where(eq(agents.id, agent.id)).returning();

    await appendAuditLog({
      eventType: "agent.updated",
      actorType: "system",
      actorId: "system",
      resource: agent.id,
      outcome: "success",
      detail: {
        changes: {
          model: { from: agent.model, to: targetModel },
        },
        reason: "auth_method_switch",
      },
    });

    migrated.push({ id: agent.id, name: agent.name, from: agent.model, to: targetModel });
  }

  return migrated;
}
