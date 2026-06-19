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
  it("reaps resolved rows past retention, keeps fresh and unresolved rows", async () => {
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
    const old = new Date("2026-01-01T00:00:00Z"); // well past the 30d window
    const fresh = new Date();

    await db.insert(chatSessionErrors).values([
      { ...base, createdAt: old, supersededAt: old }, // resolved + old → swept
      { ...base, createdAt: old, dismissedAt: old }, // resolved + old → swept
      { ...base, createdAt: old }, // old but UNRESOLVED (active) → kept
      { ...base, createdAt: fresh, supersededAt: fresh }, // resolved but fresh → kept
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
