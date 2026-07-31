/**
 * The credentials grant check against real Postgres (#987).
 *
 * `decideConnectionAccess` is unit-tested branch by branch, and its
 * counterpart here exists because the failure mode of a rule like this is
 * almost never the `if` — it is the QUERY. A `where` that forgets one of the
 * two columns matches every row for the agent (or every row for the
 * connection) and hands back `allowed: true` for a pair nobody granted, which
 * is exactly the bug this endpoint already had, restored in a new place.
 *
 * The soft-delete case is the second reason: `activeAgents` is a view, and a
 * loader written against `agents` would keep serving decrypted credentials to
 * an agent an admin deleted. That difference is invisible without a database.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { agents, agentConnectionPermissions, integrationConnections } from "@/db/schema";
import { authorizeAgentConnection } from "@/lib/integrations/authorize-agent-connection";

async function seedConnection(opts: {
  type: "odoo" | "web-search";
  name: string;
}): Promise<string> {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      type: opts.type,
      name: opts.name,
      credentials: "encrypted-blob",
      status: "active",
    })
    .returning();
  return row.id;
}

async function seedAgent(opts: { name: string; allowedTools?: string[] }): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({
      name: opts.name,
      model: "ollama-cloud/gemini-3-flash",
      greetingMessage: "Hi",
      allowedTools: opts.allowedTools ?? [],
    })
    .returning();
  return row.id;
}

async function grant(agentId: string, connectionId: string, operation = "read") {
  await db
    .insert(agentConnectionPermissions)
    .values({ agentId, connectionId, model: "res.partner", operation });
}

describe("authorizeAgentConnection against a real database", () => {
  let odooA: string;
  let odooB: string;
  let agentA: string;
  let agentB: string;

  beforeEach(async () => {
    odooA = await seedConnection({ type: "odoo", name: "Odoo A" });
    odooB = await seedConnection({ type: "odoo", name: "Odoo B" });
    agentA = await seedAgent({ name: "Agent A" });
    agentB = await seedAgent({ name: "Agent B" });
    await grant(agentA, odooA);
    await grant(agentB, odooB);
  });

  it("allows the pair that was granted", async () => {
    await expect(authorizeAgentConnection(agentA, odooA)).resolves.toMatchObject({ allowed: true });
  });

  it("denies agent B the connection granted only to agent A — the #987 case", async () => {
    // Both agents hold grants, and both connections are granted to someone.
    // A `where` missing either column would return a row here and allow it.
    await expect(authorizeAgentConnection(agentB, odooA)).resolves.toMatchObject({
      allowed: false,
      reason: "not-granted",
    });
    await expect(authorizeAgentConnection(agentA, odooB)).resolves.toMatchObject({
      allowed: false,
      reason: "not-granted",
    });
  });

  it("stops allowing a soft-deleted agent even while its grant row survives", async () => {
    await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, agentA));

    const [remaining] = await db.select().from(agentConnectionPermissions);
    expect(remaining).toBeDefined(); // the grant is still on the table

    await expect(authorizeAgentConnection(agentA, odooA)).resolves.toMatchObject({
      allowed: false,
      reason: "agent-unknown",
    });
  });

  it("honors a grant row written by an older deploy, whatever model/operation it names", async () => {
    // AGENTS.md § "Test Migrations Against Pre-Existing Data": this check is a
    // NEW reader of `agent_connection_permissions`, and the rows it reads were
    // written by deploys that knew nothing about it. An IMAP mailbox grant
    // carries `model: "email"`; an Odoo grant carries a dotted model name and
    // per-operation rows. If the count were narrowed to a particular pair —
    // the obvious "read" — every mailbox agent in an upgraded instance would
    // start getting 403s on credentials it has always been allowed to fetch.
    const mailbox = await seedConnection({ type: "odoo", name: "Legacy mailbox" });
    const inbox = await seedAgent({ name: "Inbox Agent" });
    await db
      .insert(agentConnectionPermissions)
      .values({ agentId: inbox, connectionId: mailbox, model: "email", operation: "list" });

    await expect(authorizeAgentConnection(inbox, mailbox)).resolves.toMatchObject({
      allowed: true,
    });
  });

  it("reports an unknown connection as such, so the route keeps its 404", async () => {
    await expect(
      authorizeAgentConnection(agentA, "00000000-0000-0000-0000-000000000000")
    ).resolves.toMatchObject({ allowed: false, reason: "connection-unknown" });
  });

  it("carries the agent's name back for the audit row", async () => {
    const decision = await authorizeAgentConnection(agentB, odooA);

    expect(decision.agent).toMatchObject({ id: agentB, name: "Agent B" });
  });

  describe("the instance-wide web-search connection", () => {
    it("allows an agent holding the tool, with no permission row anywhere", async () => {
      const web = await seedConnection({ type: "web-search", name: "Brave" });
      const searcher = await seedAgent({
        name: "Searcher",
        allowedTools: ["pinchy_web_search"],
      });

      // This is the case a permission-row-only rule would have broken: the
      // web connection is never granted through that table, so requiring a
      // row would revoke web search from every agent in the instance.
      await expect(authorizeAgentConnection(searcher, web)).resolves.toMatchObject({
        allowed: true,
      });
    });

    it("denies an agent without either web tool", async () => {
      const web = await seedConnection({ type: "web-search", name: "Brave" });

      await expect(authorizeAgentConnection(agentA, web)).resolves.toMatchObject({
        allowed: false,
        reason: "not-granted",
      });
    });
  });
});
