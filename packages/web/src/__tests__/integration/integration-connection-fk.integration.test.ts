import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { integrationConnections, agentConnectionPermissions, agents, user } from "@/db/schema";

const url = process.env.INTEGRATION_DATABASE_URL;
const describeIf = url ? describe : describe.skip;

describeIf("integration_connections FK (integration)", () => {
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    sql = postgres(url!);
    db = drizzle(sql);
  });

  afterEach(async () => {
    await sql`DELETE FROM agent_connection_permissions`;
    await sql`DELETE FROM integration_connections`;
    await sql`DELETE FROM agents`;
    await sql`DELETE FROM "user"`;
  });

  it("rejects direct integration delete when permissions reference it", async () => {
    const userId = "u-fk-test";
    await db.insert(user).values({
      id: userId,
      email: "u@test",
      name: "U",
      emailVerified: false,
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [agent] = await db
      .insert(agents)
      .values({
        name: "A",
        visibility: "all",
        ownerId: userId,
      })
      .returning();
    const [conn] = await db
      .insert(integrationConnections)
      .values({
        type: "odoo",
        name: "C",
        credentials: "enc",
      })
      .returning();
    await db.insert(agentConnectionPermissions).values({
      agentId: agent.id,
      connectionId: conn.id,
      model: "res.partner",
      operation: "read",
    });

    await expect(
      db.delete(integrationConnections).where(eq(integrationConnections.id, conn.id))
    ).rejects.toThrow(/foreign key|23503/i);
  });
});
