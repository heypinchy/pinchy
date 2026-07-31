// Real-DB integration tests for the durable chat-session-error store that backs
// the chat "paused" banner (Concern 1). Uses the real Postgres test database
// (provisioned by global-setup.ts, truncated between tests by setup.ts).

import { describe, it, expect } from "vitest";

import { db } from "@/db";
import { users, agents, chatSessionErrors, auditLog } from "@/db/schema";
import {
  recordChatSessionError,
  getActiveChatSessionError,
  supersedeChatSessionErrors,
  dismissChatSessionError,
  agentRanToolSince,
  resolveRetryGate,
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

describe("banner visibility is separate from recording the run (#1013)", () => {
  it("records a non-banner failure but keeps it out of the banner", async () => {
    const user = await seedUser();
    const agent = await seedAgent(user.id);
    const input = { ...base(user, agent), showBanner: false };

    const row = await recordChatSessionError(input);

    // The row exists — it carries the window the retry gate needs …
    expect(row.showBanner).toBe(false);
    // … but the banner, which exists to re-surface a MISSED error, must not
    // start showing failures it never showed before.
    expect(await getActiveChatSessionError(input.sessionKey)).toBeNull();
  });
});

describe("resolveRetryGate (#1013)", () => {
  it("re-derives sideEffects when the tool audit row lands AFTER the error was stored", async () => {
    // The #1013 race, reproduced in the order it actually happens: OpenClaw
    // fires `after_tool_call` without awaiting it, so the run can fail and the
    // error row can be written while `pinchy-audit`'s POST is still in flight.
    // The stored flag is therefore `false` for a run that DID act.
    const user = await seedUser();
    const agent = await seedAgent(user.id);
    const runStartedAt = new Date(Date.now() - 5000);
    const sessionKey = `agent:${agent.id}:direct:${user.id}`;

    await recordChatSessionError({
      ...base(user, agent),
      sideEffects: false,
      runStartedAt,
    });

    // At error time the gate is open — that is the bug, and it is what the
    // stored row still says.
    expect((await getActiveChatSessionError(sessionKey))!.sideEffects).toBe(false);

    // The audit row lands late.
    await db.insert(auditLog).values({
      actorType: "user",
      actorId: user.id,
      eventType: "tool.odoo_create",
      resource: `agent:${agent.id}`,
      rowHmac: "test-hmac",
      outcome: "success",
    });

    // Asked again — at Retry-click time — the answer is now the true one.
    expect(await resolveRetryGate({ sessionKey, agentId: agent.id })).toBe(true);
  });

  it("never downgrades a stored true, even with no audit row in range", async () => {
    // Monotonic on purpose: the stored `true` was derived from a row that
    // existed. A later window that finds nothing (GC, a clock jump) must not
    // turn a warned retry into an unwarned one.
    const user = await seedUser();
    const agent = await seedAgent(user.id);
    const sessionKey = `agent:${agent.id}:direct:${user.id}`;

    await recordChatSessionError({
      ...base(user, agent),
      sideEffects: true,
      runStartedAt: new Date(Date.now() - 5000),
    });

    expect(await resolveRetryGate({ sessionKey, agentId: agent.id })).toBe(true);
  });

  it("falls back to the stored flag for a row written before the window existed", async () => {
    // Pre-existing data (AGENTS.md §"Test Migrations Against Pre-Existing
    // Data"): rows written before 0064 have no `runStartedAt`. There is no
    // honest window to re-derive over, so the gate must report exactly what the
    // old code decided — not invent a bound and answer over the wrong range.
    const user = await seedUser();
    const agent = await seedAgent(user.id);
    const sessionKey = `agent:${agent.id}:direct:${user.id}`;

    await db.insert(chatSessionErrors).values({
      userId: user.id,
      agentId: agent.id,
      sessionKey,
      agentName: agent.name,
      errorClass: "transient",
      providerError: "API rate limit reached",
      sideEffects: false,
      runStartedAt: null,
    });

    // A tool row for this agent exists, and an unbounded re-derivation would
    // find it. The row predates the window, so the gate must not use it.
    await db.insert(auditLog).values({
      actorType: "user",
      actorId: user.id,
      eventType: "tool.odoo_create",
      resource: `agent:${agent.id}`,
      rowHmac: "test-hmac",
      outcome: "success",
    });

    expect(await resolveRetryGate({ sessionKey, agentId: agent.id })).toBe(false);
  });

  it("serves a failure that gets no banner, and stays scoped to the exact session", async () => {
    const user = await seedUser();
    const agent = await seedAgent(user.id);
    const sessionKey = `agent:${agent.id}:direct:${user.id}`;

    await recordChatSessionError({
      ...base(user, agent),
      errorClass: "unknown",
      sideEffects: true,
      showBanner: false,
      runStartedAt: new Date(Date.now() - 5000),
    });

    // No banner for this class, but the inline bubble still offers Retry — so
    // the gate must still have an answer. This is the hole that gating the
    // INSERT on `shouldPersistDurableError` left open.
    expect(await resolveRetryGate({ sessionKey, agentId: agent.id })).toBe(true);
    expect(await resolveRetryGate({ sessionKey: `${sessionKey}:other`, agentId: agent.id })).toBe(
      false
    );
  });

  it("answers false when the session has no recorded failure at all", async () => {
    const user = await seedUser();
    const agent = await seedAgent(user.id);
    expect(
      await resolveRetryGate({
        sessionKey: `agent:${agent.id}:direct:${user.id}`,
        agentId: agent.id,
      })
    ).toBe(false);
  });

  it("uses the NEWEST failure's window, not an older one", async () => {
    // Two failures in one session: an old one that ran a tool, and a fresh one
    // that did not. Re-deriving over the old window would warn about writes the
    // run the user is retrying never made — noise that trains users to click
    // through the confirm.
    const user = await seedUser();
    const agent = await seedAgent(user.id);
    const sessionKey = `agent:${agent.id}:direct:${user.id}`;

    await db.insert(auditLog).values({
      actorType: "user",
      actorId: user.id,
      eventType: "tool.odoo_create",
      resource: `agent:${agent.id}`,
      rowHmac: "test-hmac",
      outcome: "success",
      timestamp: new Date("2026-06-18T09:01:00Z"),
    });

    await db.insert(chatSessionErrors).values([
      {
        userId: user.id,
        agentId: agent.id,
        sessionKey,
        agentName: agent.name,
        errorClass: "transient",
        providerError: "older",
        sideEffects: false,
        runStartedAt: new Date("2026-06-18T09:00:00Z"),
        createdAt: new Date("2026-06-18T09:02:00Z"),
      },
      {
        userId: user.id,
        agentId: agent.id,
        sessionKey,
        agentName: agent.name,
        errorClass: "transient",
        providerError: "newer",
        sideEffects: false,
        runStartedAt: new Date("2026-06-18T10:00:00Z"),
        createdAt: new Date("2026-06-18T10:02:00Z"),
      },
    ]);

    expect(await resolveRetryGate({ sessionKey, agentId: agent.id })).toBe(false);
  });
});

describe("agentRanToolSince", () => {
  it("detects a tool.* audit event for the agent after the cutoff, scoped by agent and time", async () => {
    const user = await seedUser();
    const agent = await seedAgent(user.id);
    const cutoff = new Date(Date.now() - 1000);

    expect(await agentRanToolSince(agent.id, cutoff)).toBe(false);

    await db.insert(auditLog).values({
      actorType: "user",
      actorId: user.id,
      eventType: "tool.pinchy_ls",
      resource: `agent:${agent.id}`,
      rowHmac: "test-hmac",
      outcome: "success",
    });

    expect(await agentRanToolSince(agent.id, cutoff)).toBe(true);
    // A different agent doesn't match.
    expect(await agentRanToolSince("other-agent", cutoff)).toBe(false);
    // A cutoff in the future excludes the already-written row.
    expect(await agentRanToolSince(agent.id, new Date(Date.now() + 60_000))).toBe(false);
  });
});
