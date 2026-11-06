// Real-DB tests for the "admin-only" shared agents of #1278: shared agents
// stored as `restricted` with no group attached. A community instance shows
// them to everyone; the moment a license is active, only admins can use them.
// The selection is a NOT EXISTS over agent_groups — mocking @/db would assert
// none of it.
import { describe, it, expect } from "vitest";

import { db } from "@/db";
import { agents, agentGroups, groups } from "@/db/schema";
import { eq } from "drizzle-orm";
import { listAdminOnlyAgents, openAdminOnlyAgentsToAll } from "@/lib/admin-only-agents";

async function seedAgent(
  name: string,
  values: Partial<typeof agents.$inferInsert> = {}
): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({ name, model: "anthropic/claude-haiku-5-5", greetingMessage: "Hi", ...values })
    .returning();
  return row.id;
}

async function seedGroup(name: string): Promise<string> {
  const [row] = await db.insert(groups).values({ name }).returning();
  return row.id;
}

async function visibilityOf(id: string) {
  const [row] = await db
    .select({ visibility: agents.visibility })
    .from(agents)
    .where(eq(agents.id, id));
  return row.visibility;
}

describe("listAdminOnlyAgents", () => {
  it("lists shared agents that are restricted with no group, by name", async () => {
    // The DB default is "restricted" — exactly the agents nobody chose to restrict.
    const zeta = await seedAgent("Zeta");
    const alpha = await seedAgent("Alpha");

    expect(await listAdminOnlyAgents()).toEqual([
      { id: alpha, name: "Alpha" },
      { id: zeta, name: "Zeta" },
    ]);
  });

  it("leaves out agents with a group, agents for everyone, personal and deleted agents", async () => {
    const hr = await seedGroup("HR");
    const scoped = await seedAgent("Scoped");
    await db.insert(agentGroups).values({ agentId: scoped, groupId: hr });
    await seedAgent("Open", { visibility: "all" });
    await seedAgent("Mine", { isPersonal: true, ownerId: null });
    await seedAgent("Gone", { deletedAt: new Date() });
    const stranded = await seedAgent("Stranded");

    expect(await listAdminOnlyAgents()).toEqual([{ id: stranded, name: "Stranded" }]);
  });
});

describe("openAdminOnlyAgentsToAll", () => {
  it("sets the named admin-only agents to visible for everyone and returns them", async () => {
    const a = await seedAgent("A");
    const b = await seedAgent("B");
    const untouched = await seedAgent("Untouched");

    const opened = await openAdminOnlyAgentsToAll([a, b]);

    expect(opened).toEqual(
      expect.arrayContaining([
        { id: a, name: "A" },
        { id: b, name: "B" },
      ])
    );
    expect(opened).toHaveLength(2);
    expect(await visibilityOf(a)).toBe("all");
    expect(await visibilityOf(b)).toBe("all");
    expect(await visibilityOf(untouched)).toBe("restricted");
  });

  it("never widens an agent that gained a group since the list was shown", async () => {
    // The admin saw the list, then someone scoped the agent to HR. Opening it
    // to everyone now would widen access past the group nobody asked to drop.
    const hr = await seedGroup("HR");
    const scoped = await seedAgent("Scoped meanwhile");
    await db.insert(agentGroups).values({ agentId: scoped, groupId: hr });

    expect(await openAdminOnlyAgentsToAll([scoped])).toEqual([]);
    expect(await visibilityOf(scoped)).toBe("restricted");
  });

  it("ignores personal and deleted agents even when named", async () => {
    const mine = await seedAgent("Mine", { isPersonal: true, ownerId: null });
    const gone = await seedAgent("Gone", { deletedAt: new Date() });

    expect(await openAdminOnlyAgentsToAll([mine, gone])).toEqual([]);
    expect(await visibilityOf(mine)).toBe("restricted");
    expect(await visibilityOf(gone)).toBe("restricted");
  });

  it("does nothing for an empty list", async () => {
    const a = await seedAgent("A");
    expect(await openAdminOnlyAgentsToAll([])).toEqual([]);
    expect(await visibilityOf(a)).toBe("restricted");
  });
});
