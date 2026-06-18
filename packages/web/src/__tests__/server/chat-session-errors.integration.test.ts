// Real-DB integration tests for the durable chat-session-error store that backs
// the chat "paused" banner (Concern 1). Uses the real Postgres test database
// (provisioned by global-setup.ts, truncated between tests by setup.ts).

import { describe, it, expect } from "vitest";

import { db } from "@/db";
import { users, agents, chatSessionErrors } from "@/db/schema";
import {
  recordChatSessionError,
  getActiveChatSessionError,
  supersedeChatSessionErrors,
  dismissChatSessionError,
} from "@/server/chat-session-errors";

async function seedUser(overrides?: Partial<typeof users.$inferInsert>) {
  const [row] = await db
    .insert(users)
    .values({
      name: "Test User",
      email: `cse-${Math.random().toString(36).slice(2)}@example.com`,
      emailVerified: true,
      role: "admin",
      ...overrides,
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
      greetingMessage: "Hello!",
      isPersonal: false,
      visibility: "all",
      ownerId,
    })
    .returning();
  return row;
}

function base(user: { id: string }, agent: { id: string; name: string }) {
  return {
    userId: user.id,
    agentId: agent.id,
    sessionKey: `agent:${agent.id}:direct:${user.id}`,
    agentName: agent.name,
    errorClass: "transient",
    transientReason: "rate_limit",
    providerError: "API rate limit reached",
    sideEffects: true,
  };
}

describe("chat session errors persistence", () => {
  it("records an error and returns it as the active error for the session", async () => {
    const user = await seedUser();
    const agent = await seedAgent(user.id);
    const input = { ...base(user, agent), clientMessageId: "m1" };

    await recordChatSessionError(input);
    const active = await getActiveChatSessionError(input.sessionKey);

    expect(active).not.toBeNull();
    expect(active!.transientReason).toBe("rate_limit");
    expect(active!.sideEffects).toBe(true);
    expect(active!.errorClass).toBe("transient");
  });

  it("clears the active error once the triggering message's run succeeds (supersede by clientMessageId)", async () => {
    const user = await seedUser();
    const agent = await seedAgent(user.id);
    const input = { ...base(user, agent), clientMessageId: "m1" };
    await recordChatSessionError(input);

    await supersedeChatSessionErrors({ sessionKey: input.sessionKey, clientMessageId: "m1" });

    expect(await getActiveChatSessionError(input.sessionKey)).toBeNull();
  });

  it("does NOT clear the error when a DIFFERENT message succeeds", async () => {
    const user = await seedUser();
    const agent = await seedAgent(user.id);
    const input = { ...base(user, agent), clientMessageId: "m1" };
    await recordChatSessionError(input);

    // The user moved on to an unrelated question m2 that succeeded — the
    // unanswered m1 error must survive.
    await supersedeChatSessionErrors({ sessionKey: input.sessionKey, clientMessageId: "m2" });

    expect(await getActiveChatSessionError(input.sessionKey)).not.toBeNull();
  });

  it("hides a dismissed error and scopes dismissal to the owning user", async () => {
    const user = await seedUser();
    const other = await seedUser();
    const agent = await seedAgent(user.id);
    const input = { ...base(user, agent), clientMessageId: "m1" };
    const row = await recordChatSessionError(input);

    // A different user cannot dismiss it.
    const wrong = await dismissChatSessionError({ id: row.id, userId: other.id });
    expect(wrong).toBeNull();
    expect(await getActiveChatSessionError(input.sessionKey)).not.toBeNull();

    // The owner can.
    const ok = await dismissChatSessionError({ id: row.id, userId: user.id });
    expect(ok).not.toBeNull();
    expect(await getActiveChatSessionError(input.sessionKey)).toBeNull();
  });

  it("scopes the active error to the exact sessionKey (no cross-session leak)", async () => {
    const user = await seedUser();
    const agent = await seedAgent(user.id);
    const input = { ...base(user, agent), clientMessageId: "m1" };
    await recordChatSessionError(input);

    expect(await getActiveChatSessionError(`${input.sessionKey}:other`)).toBeNull();
    expect(await getActiveChatSessionError(input.sessionKey)).not.toBeNull();
  });

  it("returns the newest un-resolved error when several exist", async () => {
    const user = await seedUser();
    const agent = await seedAgent(user.id);
    const sessionKey = `agent:${agent.id}:direct:${user.id}`;
    await db.insert(chatSessionErrors).values([
      {
        userId: user.id,
        agentId: agent.id,
        sessionKey,
        agentName: agent.name,
        errorClass: "transient",
        transientReason: "rate_limit",
        providerError: "older",
        sideEffects: false,
        createdAt: new Date("2026-06-18T09:00:00Z"),
      },
      {
        userId: user.id,
        agentId: agent.id,
        sessionKey,
        agentName: agent.name,
        errorClass: "transient",
        transientReason: "overloaded",
        providerError: "newer",
        sideEffects: false,
        createdAt: new Date("2026-06-18T09:05:00Z"),
      },
    ]);

    const active = await getActiveChatSessionError(sessionKey);
    expect(active!.providerError).toBe("newer");
  });
});
