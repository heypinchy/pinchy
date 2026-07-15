// Real-DB integration tests for the admin "see all" agent services
// `listAgents` / `getAgent` (#572, Task 3.2).
//
// These back the key-authenticated `/api/v1/agents` surface (Phase 4), which is
// admin-scoped and must see EVERY non-deleted agent — including personal agents
// owned by other users that the session path (`getVisibleAgents`) deliberately
// hides. The load-bearing assertion (design D4) is exactly that gap: an agent
// the visibility filter hides is still returned by `{ scope: "all" }`.
//
// Provisioned by global-setup.ts (fresh migrated DB) and truncated between tests
// (setup.ts). Everything runs for real — no mocks.

import { describe, it, expect } from "vitest";
import { db } from "@/db";
import { users, agents } from "@/db/schema";
import { listAgents, getAgent } from "@/lib/agents";
import { getVisibleAgents } from "@/lib/visible-agents";

async function seedUser(overrides?: Partial<typeof users.$inferInsert>) {
  const [row] = await db
    .insert(users)
    .values({
      name: "Test User",
      email: `las-${Math.random().toString(36).slice(2)}@example.com`,
      emailVerified: true,
      role: "admin",
      ...overrides,
    })
    .returning();
  return row;
}

async function seedAgent(overrides: Partial<typeof agents.$inferInsert>) {
  const [row] = await db
    .insert(agents)
    .values({
      name: "Agent",
      model: "anthropic/claude-haiku-4-5-20251001",
      greetingMessage: "Hi!",
      isPersonal: false,
      visibility: "all",
      ...overrides,
    })
    .returning();
  return row;
}

describe("listAgents / getAgent — admin see-all scope (integration)", () => {
  it("listAgents({ scope: 'all' }) returns agents that getVisibleAgents hides", async () => {
    const userA = await seedUser();
    const userB = await seedUser();

    const shared = await seedAgent({
      name: "Shared",
      ownerId: userA.id,
      isPersonal: false,
      visibility: "all",
    });
    // A personal agent owned by A. getVisibleAgents hides this from everyone
    // but A — even from an admin (the isPersonal branch runs before the admin
    // check). This is the exact case scope:"all" must expose.
    const personalOfA = await seedAgent({
      name: "A's Personal",
      ownerId: userA.id,
      isPersonal: true,
    });

    const all = await listAgents({ scope: "all" });
    expect(all.map((a) => a.id).sort()).toEqual([shared.id, personalOfA.id].sort());

    // Prove the see-all mode returns what the visibility filter hides: admin
    // user B sees only the shared agent, not A's personal one.
    const visibleToB = await getVisibleAgents(userB.id, "admin");
    expect(visibleToB.map((a) => a.id)).toEqual([shared.id]);
    expect(visibleToB.map((a) => a.id)).not.toContain(personalOfA.id);
  });

  it("listAgents({ scope: 'all' }) excludes soft-deleted agents (active_agents view)", async () => {
    const owner = await seedUser();
    const live = await seedAgent({ name: "Live", ownerId: owner.id });
    const deleted = await seedAgent({
      name: "Deleted",
      ownerId: owner.id,
      deletedAt: new Date(),
    });

    const ids = (await listAgents({ scope: "all" })).map((a) => a.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(deleted.id);
  });

  it("getAgent(id, { scope: 'all' }) returns a personal agent regardless of owner", async () => {
    const owner = await seedUser();
    const personal = await seedAgent({
      name: "Private",
      ownerId: owner.id,
      isPersonal: true,
    });

    const found = await getAgent(personal.id, { scope: "all" });
    expect(found?.id).toBe(personal.id);
    expect(found?.isPersonal).toBe(true);
  });

  it("getAgent returns undefined when the agent does not exist", async () => {
    const found = await getAgent("nonexistent-id", { scope: "all" });
    expect(found).toBeUndefined();
  });

  it("getAgent does not return a soft-deleted agent", async () => {
    const owner = await seedUser();
    const deleted = await seedAgent({
      name: "Deleted",
      ownerId: owner.id,
      deletedAt: new Date(),
    });

    const found = await getAgent(deleted.id, { scope: "all" });
    expect(found).toBeUndefined();
  });

  it("fails closed on an unknown scope (TS forbids it; guards a JS/refactor caller)", async () => {
    await expect(listAgents({ scope: "user" as unknown as "all" })).rejects.toThrow(
      /unsupported scope/
    );
    await expect(getAgent("some-id", { scope: "user" as unknown as "all" })).rejects.toThrow(
      /unsupported scope/
    );
  });
});
