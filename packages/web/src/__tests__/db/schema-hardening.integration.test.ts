// Real-DB integration test for the schema-hardening CHECK constraints (#259).
// Verifies the database enforces the enum-like text columns the application
// already assumes, against the freshly migrated Postgres test database. The
// migration (0044) adds the CHECKs; this proves they bite.

import { describe, it, expect } from "vitest";
import { db } from "@/db";
import { users, agents, invites, integrationConnections } from "@/db/schema";

const suffix = Math.random().toString(36).slice(2);

/**
 * Drizzle wraps the postgres error as "Failed query: …" and puts the real
 * Postgres message (which names the violated constraint) on `.cause`. Flatten
 * the error chain into one string so the constraint-name assertion can match
 * regardless of where the driver surfaces it.
 */
function constraintViolation(pattern: RegExp) {
  return (err: unknown) => {
    const e = err as {
      message?: unknown;
      cause?: { message?: unknown; constraint?: unknown };
      constraint?: unknown;
    };
    const text = [e?.message, e?.cause?.message, e?.cause?.constraint, e?.constraint]
      .filter((v) => typeof v === "string")
      .join(" ");
    return pattern.test(text);
  };
}
let userCounter = 0;
async function insertUser(role: string) {
  const [row] = await db
    .insert(users)
    .values({
      email: `hardening-${suffix}-${userCounter++}@test.local`,
      name: "Hardening User",
      role: role as never,
    })
    .returning();
  return row;
}

describe("schema-hardening CHECK constraints (#259)", () => {
  it("accepts a user with role 'admin' or 'member'", async () => {
    const admin = await insertUser("admin");
    expect(admin.role).toBe("admin");
    const member = await insertUser("member");
    expect(member.role).toBe("member");
  });

  it("rejects a user with an invalid role", async () => {
    await expect(insertUser("superadmin")).rejects.toSatisfy(
      constraintViolation(/users_role_check/)
    );
  });

  it("accepts an agent with visibility 'restricted' or 'all'", async () => {
    const [restricted] = await db
      .insert(agents)
      .values({
        name: "A",
        model: "anthropic/claude-sonnet-4-6",
        greetingMessage: "hi",
        visibility: "restricted",
      })
      .returning();
    expect(restricted.visibility).toBe("restricted");

    const [all] = await db
      .insert(agents)
      .values({
        name: "B",
        model: "anthropic/claude-sonnet-4-6",
        greetingMessage: "hi",
        visibility: "all",
      })
      .returning();
    expect(all.visibility).toBe("all");
  });

  it("rejects an agent with an invalid visibility", async () => {
    await expect(
      db.insert(agents).values({
        name: "C",
        model: "anthropic/claude-sonnet-4-6",
        greetingMessage: "hi",
        visibility: "private",
      })
    ).rejects.toSatisfy(constraintViolation(/agents_visibility_check/));
  });

  it("accepts an integration connection with a known type and status", async () => {
    const [conn] = await db
      .insert(integrationConnections)
      .values({ type: "odoo", name: "Odoo", credentials: "enc", status: "active" })
      .returning();
    expect(conn.type).toBe("odoo");
    expect(conn.status).toBe("active");
  });

  it("rejects an integration connection with an unlisted type", async () => {
    await expect(
      db
        .insert(integrationConnections)
        .values({ type: "shopify", name: "Shopify", credentials: "enc" })
    ).rejects.toSatisfy(constraintViolation(/integration_connections_type_check/));
  });

  it("rejects an integration connection with an invalid status", async () => {
    await expect(
      db
        .insert(integrationConnections)
        .values({ type: "odoo", name: "Odoo", credentials: "enc", status: "archived" })
    ).rejects.toSatisfy(constraintViolation(/integration_connections_status_check/));
  });

  it("accepts an invite with role 'admin' and type 'invite'/'reset'", async () => {
    const creator = await insertUser("admin");
    const [invite] = await db
      .insert(invites)
      .values({
        tokenHash: `tok-${suffix}-1`,
        role: "admin",
        type: "invite",
        createdBy: creator.id,
        expiresAt: new Date(Date.now() + 86400000),
      })
      .returning();
    expect(invite.role).toBe("admin");
    expect(invite.type).toBe("invite");
  });

  it("rejects an invite with an invalid role", async () => {
    const creator = await insertUser("admin");
    await expect(
      db.insert(invites).values({
        tokenHash: `tok-${suffix}-2`,
        role: "owner",
        type: "invite",
        createdBy: creator.id,
        expiresAt: new Date(Date.now() + 86400000),
      })
    ).rejects.toSatisfy(constraintViolation(/invites_role_check/));
  });

  it("rejects an invite with an invalid type", async () => {
    const creator = await insertUser("admin");
    await expect(
      db.insert(invites).values({
        tokenHash: `tok-${suffix}-3`,
        role: "member",
        type: "lifetime",
        createdBy: creator.id,
        expiresAt: new Date(Date.now() + 86400000),
      })
    ).rejects.toSatisfy(constraintViolation(/invites_type_check/));
  });
});
