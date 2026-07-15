// Real-DB integration tests for the org-scoped agent services
// `listAgents` / `getAgent` (#572, Task 3.2).
//
// These back the key-authenticated `/api/v1/agents` surface, which is
// org-scoped rather than per-user: it ignores `visibility`/group membership,
// so a key sees restricted agents it shares no group with. That is design D4
// and the first two tests below pin it.
//
// The boundary D4 does NOT cross is personal agents. `agent-access.ts` states
// the invariant plainly: personal agents are private to their owner, and that
// applies to everyone — admins included. An API key is a machine identity for
// the organization, so it has strictly less business there than an admin does.
// `scope: "shared"` is the type-level expression of that: there is deliberately
// no scope that returns personal agents, because nothing may.
//
// Provisioned by global-setup.ts (fresh migrated DB) and truncated between tests
// (setup.ts). Everything runs for real — no mocks.

import { describe, it, expect } from "vitest";
import { db } from "@/db";
import { users, agents } from "@/db/schema";
import { listAgents, getAgent } from "@/lib/agents";

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

describe("listAgents / getAgent — org-scoped 'shared' scope (integration)", () => {
  // ── D4: the org scope ignores per-user visibility ────────────────────────

  it("returns a restricted agent with no group grants (design D4: no visibility filter)", async () => {
    const open = await seedAgent({ name: "Open", visibility: "all" });
    // Restricted with no group grants — on an enterprise instance
    // getVisibleAgents shows this to admins only. The org scope returns it
    // regardless: it has no visibility WHERE clause, and structurally cannot
    // filter per user, since it takes no userId at all. That is D4.
    //
    // Deliberately NOT asserted by comparing against getVisibleAgents: this
    // DB is a community instance, where effectiveVisibility() downgrades
    // "restricted" to "all", so both would return the same set and the
    // comparison would prove nothing. (Which is worth knowing: the D4 test
    // this replaced only "worked" because it used a PERSONAL agent as its
    // example of something the filter hides — i.e. it demonstrated the very
    // exposure B3 closes.)
    const restricted = await seedAgent({ name: "Restricted", visibility: "restricted" });

    const listed = await listAgents({ scope: "shared" });
    expect(listed.map((a) => a.id).sort()).toEqual([open.id, restricted.id].sort());
  });

  // ── B3: the org scope does NOT cross the personal-agent boundary ─────────

  it("EXCLUDES personal agents — the boundary an API key must not cross", async () => {
    const owner = await seedUser();

    const shared = await seedAgent({ name: "Shared", ownerId: owner.id, isPersonal: false });
    const personal = await seedAgent({
      name: "Owner's Personal",
      ownerId: owner.id,
      isPersonal: true,
    });

    const ids = (await listAgents({ scope: "shared" })).map((a) => a.id);
    expect(ids).toEqual([shared.id]);
    expect(ids).not.toContain(personal.id);
  });

  it("getAgent returns undefined for a personal agent, so the route 404s instead of leaking it", async () => {
    const owner = await seedUser();
    const personal = await seedAgent({ name: "Private", ownerId: owner.id, isPersonal: true });

    // Not "returns it but flagged" — undefined. The caller cannot accidentally
    // forget to check `isPersonal`, because it never receives the row.
    expect(await getAgent(personal.id, { scope: "shared" })).toBeUndefined();
  });

  // ── Soft-delete + fail-closed ───────────────────────────────────────────

  it("excludes soft-deleted agents (active_agents view)", async () => {
    const owner = await seedUser();
    const live = await seedAgent({ name: "Live", ownerId: owner.id });
    const deleted = await seedAgent({ name: "Deleted", ownerId: owner.id, deletedAt: new Date() });

    const ids = (await listAgents({ scope: "shared" })).map((a) => a.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(deleted.id);
  });

  it("getAgent returns a shared agent by id", async () => {
    const owner = await seedUser();
    const shared = await seedAgent({ name: "Shared", ownerId: owner.id, isPersonal: false });

    const found = await getAgent(shared.id, { scope: "shared" });
    expect(found?.id).toBe(shared.id);
  });

  it("getAgent returns undefined when the agent does not exist", async () => {
    expect(await getAgent("nonexistent-id", { scope: "shared" })).toBeUndefined();
  });

  it("getAgent does not return a soft-deleted agent", async () => {
    const owner = await seedUser();
    const deleted = await seedAgent({ name: "Deleted", ownerId: owner.id, deletedAt: new Date() });

    expect(await getAgent(deleted.id, { scope: "shared" })).toBeUndefined();
  });

  it("fails closed on an unknown scope (TS forbids it; guards a JS/refactor caller)", async () => {
    // Notably includes the retired "all" scope: a caller left over from before
    // personal agents were excluded must throw, not silently see everything.
    await expect(listAgents({ scope: "all" as unknown as "shared" })).rejects.toThrow(
      /unsupported scope/
    );
    await expect(getAgent("some-id", { scope: "all" as unknown as "shared" })).rejects.toThrow(
      /unsupported scope/
    );
  });
});
