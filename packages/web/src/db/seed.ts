import { db } from "@/db";
import { agents } from "@/db/schema";

export async function seedDefaultAgent() {
  const existing = await db.query.agents.findFirst();
  if (existing) return existing;

  const [agent] = await db
    .insert(agents)
    .values({
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-20250514",
      systemPrompt:
        "You are Smithers, a helpful and loyal AI assistant. You are professional, efficient, and always ready to help.",
    })
    .returning();

  return agent;
}
