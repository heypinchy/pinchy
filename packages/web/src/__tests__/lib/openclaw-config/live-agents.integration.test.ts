// liveAgentIds against a real database: it decides which agents a config push
// may remove from OpenClaw's roster with agents.delete (deleteFiles: true), so
// a soft-deleted agent must count as gone and a live one never may. Every
// push test mocks it; this is where the query itself is checked.
import { describe, it, expect } from "vitest";

import { db } from "@/db";
import { agents } from "@/db/schema";
import { liveAgentIds } from "@/lib/openclaw-config/live-agents";

async function seedAgent(deletedAt: Date | null) {
  const [row] = await db
    .insert(agents)
    .values({
      name: "Knowledge Base",
      model: "anthropic/claude-haiku-5-5",
      greetingMessage: "Hi",
      deletedAt,
    })
    .returning();
  return row.id;
}

describe("liveAgentIds", () => {
  it("returns only the agents the database holds and has not soft-deleted", async () => {
    const live = await seedAgent(null);
    const softDeleted = await seedAgent(new Date());

    const held = await liveAgentIds([live, softDeleted, "never-existed"]);

    expect([...held]).toEqual([live]);
  });

  it("asks nothing for no ids", async () => {
    expect([...(await liveAgentIds([]))]).toEqual([]);
  });
});
