// Pre-existing data, new code (agent-rules/testing.md § "Test Migrations Against
// Pre-Existing Data"), for #1272.
//
// Before v0.9.0 the agent PATCH accepted any `pinchy-files.allowed_paths`, from
// any member on their own agent. The lockdown confined new writes to /data and
// left the old rows alone. These tests seed such a row directly — bypassing the
// schema exactly the way the old route did — and assert that the boot-time
// cleanup takes the grant away, records it, and touches nothing else.

import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, auditLog, type AgentPluginConfig } from "@/db/schema";
import { grantedDataPaths } from "@/lib/agent-granted-paths";
import { stripUngrantablePaths } from "@/lib/strip-ungrantable-paths";

async function insertAgent(name: string, pluginConfig: AgentPluginConfig | null) {
  const [row] = await db
    .insert(agents)
    .values({ name, model: "anthropic/claude-haiku-5-5", greetingMessage: "Hi", pluginConfig })
    .returning();
  return row;
}

async function storedConfig(id: string) {
  const [row] = await db
    .select({ pluginConfig: agents.pluginConfig })
    .from(agents)
    .where(eq(agents.id, id));
  return row.pluginConfig;
}

async function auditRows() {
  return db.select().from(auditLog).where(eq(auditLog.eventType, "agent.updated"));
}

describe("stripUngrantablePaths", () => {
  it("removes a pre-lockdown entry outside /data so the row no longer grants it", async () => {
    const agent = await insertAgent("Pre-lockdown", {
      "pinchy-files": {
        allowed_paths: ["/data/kb", "/root/.openclaw/workspaces", "/"],
        allowed_extensions: [".pdf"],
      },
      "pinchy-web": { allowedDomains: ["example.com"] },
    });

    expect(await stripUngrantablePaths()).toBe(1);

    const config = await storedConfig(agent.id);
    expect(grantedDataPaths(config)).toEqual(["/data/kb"]);
    // Only the offending entries go; every other setting on the row stays.
    expect(config).toEqual({
      "pinchy-files": { allowed_paths: ["/data/kb"], allowed_extensions: [".pdf"] },
      "pinchy-web": { allowedDomains: ["example.com"] },
    });
  });

  it("records each dropped grant so an admin can see what was taken away", async () => {
    const agent = await insertAgent("Pre-lockdown", {
      "pinchy-files": { allowed_paths: ["/data/kb", "/root/.openclaw/workspaces"] },
    });

    await stripUngrantablePaths();

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "system",
      actorId: "allowed-paths-cleanup",
      resource: `agent:${agent.id}`,
      outcome: "success",
    });
    // Counts, never the folder paths: a path can embed a username, and an
    // audit row is immutable (the `pathCount` rule in lib/audit.ts).
    const detail = rows[0].detail as Record<string, unknown>;
    expect(detail).toEqual({
      agent: { id: agent.id, name: "Pre-lockdown" },
      reason: "allowed_paths_outside_data_root",
      changes: { allowedPathCount: { from: 2, to: 1 } },
      sweepId: expect.any(String),
    });
    expect(JSON.stringify(detail)).not.toContain("/root");
  });

  it("gives every row of one run the same sweepId", async () => {
    await insertAgent("A", { "pinchy-files": { allowed_paths: ["/"] } });
    await insertAgent("B", { "pinchy-files": { allowed_paths: ["/etc"] } });

    expect(await stripUngrantablePaths()).toBe(2);

    const sweepIds = (await auditRows()).map((r) => (r.detail as { sweepId: string }).sweepId);
    expect(sweepIds).toHaveLength(2);
    expect(new Set(sweepIds).size).toBe(1);
  });

  it("leaves a deleted agent alone — nothing reads it, and a row about it would only confuse", async () => {
    const agent = await insertAgent("Gone", { "pinchy-files": { allowed_paths: ["/"] } });
    await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, agent.id));

    expect(await stripUngrantablePaths()).toBe(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it("is idempotent: a second boot finds nothing and writes nothing", async () => {
    await insertAgent("Pre-lockdown", {
      "pinchy-files": { allowed_paths: ["/root/.openclaw/workspaces"] },
    });

    expect(await stripUngrantablePaths()).toBe(1);
    expect(await stripUngrantablePaths()).toBe(0);
    expect(await auditRows()).toHaveLength(1);
  });

  it("leaves a clean row and a row without file config untouched and unaudited", async () => {
    const clean = await insertAgent("Clean", {
      "pinchy-files": { allowed_paths: ["/data/kb"] },
    });
    const bare = await insertAgent("Bare", null);

    expect(await stripUngrantablePaths()).toBe(0);

    expect(await storedConfig(clean.id)).toEqual({
      "pinchy-files": { allowed_paths: ["/data/kb"] },
    });
    expect(await storedConfig(bare.id)).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });
});
