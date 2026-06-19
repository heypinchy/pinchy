// Real-DB integration tests for the chat-session-error retention sweep.
import { describe, it, expect } from "vitest";

import { db } from "@/db";
import { users, agents, chatSessionErrors, auditLog } from "@/db/schema";
import { sweepResolvedChatErrors } from "@/server/chat-error-gc";
import { eq } from "drizzle-orm";

async function seedUser() {
  const [row] = await db
    .insert(users)
    .values({
      name: "Test User",
      email: `gc-${Math.random().toString(36).slice(2)}@example.com`,
      emailVerified: true,
      role: "admin",
    })
    .returning();
  return row;
}
async function seedAgent(ownerId: string) {
  const [row] = await db
    .insert(agents)
    .values({
      name: "Penny",
      model: "ollama-cloud/gemini-3-flash",
      greetingMessage: "Hi",
      isPersonal: false,
      visibility: "all",
      ownerId,
    })
    .returning();
  return row;
}

describe("sweepResolvedChatErrors", () => {
  it("reaps resolved rows past 30d and any row past the 90d hard cap, keeps the rest", async () => {
    const user = await seedUser();
    const agent = await seedAgent(user.id);
    const sessionKey = `agent:${agent.id}:direct:${user.id}`;
    const base = {
      userId: user.id,
      agentId: agent.id,
      sessionKey,
      agentName: "Penny",
      errorClass: "transient",
      providerError: "API rate limit reached",
      sideEffects: false,
    };
    const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

    await db.insert(chatSessionErrors).values([
      { ...base, createdAt: daysAgo(40), supersededAt: daysAgo(40) }, // resolved + >30d → swept
      { ...base, createdAt: daysAgo(100) }, // UNRESOLVED but past the 90d hard cap → swept
      { ...base, createdAt: daysAgo(40) }, // UNRESOLVED, within 90d → kept
      { ...base, createdAt: daysAgo(5), dismissedAt: daysAgo(5) }, // resolved but <30d → kept
    ]);

    const res = await sweepResolvedChatErrors();

    expect(res.swept).toBe(2);
    expect(res.sweepId).toMatch(/[0-9a-f-]{36}/);

    const remaining = await db.select().from(chatSessionErrors);
    expect(remaining).toHaveLength(2);

    // One summary audit row carrying the sweepId.
    const gcRows = await db.select().from(auditLog).where(eq(auditLog.eventType, "chat.error_gc"));
    expect(gcRows).toHaveLength(1);
  });

  it("is a no-op (no audit row) when nothing is eligible", async () => {
    const res = await sweepResolvedChatErrors();
    expect(res.swept).toBe(0);
    const gcRows = await db.select().from(auditLog).where(eq(auditLog.eventType, "chat.error_gc"));
    expect(gcRows).toHaveLength(0);
  });
});
