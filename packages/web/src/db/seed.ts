import { db } from "@/db";
import { createSmithersAgent } from "@/lib/personal-agent";

export async function seedDefaultAgent(ownerId?: string) {
  const existing = await db.query.agents.findFirst();
  if (existing) return existing;

  return createSmithersAgent({
    model: "anthropic/claude-sonnet-4-6",
    ownerId: ownerId ?? null,
    isPersonal: ownerId ? true : false,
    isAdmin: ownerId ? true : false,
  });
}
