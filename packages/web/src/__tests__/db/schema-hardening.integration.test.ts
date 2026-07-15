// Real-DB integration test for the schema-hardening CHECK constraints (#259).
// Verifies the database enforces the enum-like text columns the application
// already assumes, against the freshly migrated Postgres test database. The
// migration (0044) adds the CHECKs; this proves they bite.

import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users, agents, invites, integrationConnections } from "@/db/schema";
import {
  USER_ROLES,
  AGENT_VISIBILITIES,
  INVITE_ROLES,
  INVITE_TYPES,
  INTEGRATION_CONNECTION_TYPES,
  INTEGRATION_CONNECTION_STATUSES,
  EMAIL_WORKFLOW_STATUSES,
  PROCESSED_EMAIL_STATUSES,
  NOTIFICATION_STATUSES,
} from "@/db/enums";

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
        // Deliberately outside the AGENT_VISIBILITIES union — proving the DB
        // CHECK constraint (not just Drizzle's `.$type<...>()` column type)
        // rejects it. `sql` keeps this a real, parameterized value (part of
        // the column's declared `... | SQL<unknown> | ...` type) instead of
        // a cast around the union.
        visibility: sql`${"private"}`,
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
        // Deliberately outside INTEGRATION_CONNECTION_TYPES — see the
        // `sql` note on the visibility test above.
        .values({ type: sql`${"shopify"}`, name: "Shopify", credentials: "enc" })
    ).rejects.toSatisfy(constraintViolation(/integration_connections_type_check/));
  });

  it("rejects an integration connection with an invalid status", async () => {
    await expect(
      db
        .insert(integrationConnections)
        .values({ type: "odoo", name: "Odoo", credentials: "enc", status: sql`${"archived"}` })
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
        // Deliberately outside INVITE_ROLES — see the `sql` note on the
        // visibility test above.
        role: sql`${"owner"}`,
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
        // Deliberately outside INVITE_TYPES — see the `sql` note above.
        type: sql`${"lifetime"}`,
        createdBy: creator.id,
        expiresAt: new Date(Date.now() + 86400000),
      })
    ).rejects.toSatisfy(constraintViolation(/invites_type_check/));
  });
});

// Coverage for sub-task D of #259: invites.claimedByUserId is deliberately
// `ON DELETE SET NULL` (not cascade) so an invite — audit-relevant history of
// who was invited, by whom, and when it was claimed — survives the deletion of
// the user who claimed it, with only the claimer reference nulled. Without this
// test the semantic FK change would be unguarded: a future refactor could flip
// it back to cascade (silently dropping the record) or to the pre-migration
// NO ACTION (which would block the user deletion entirely) with a green suite.
describe("invites.claimedByUserId ON DELETE SET NULL (#259)", () => {
  it("keeps the invite and nulls the claimer when the claiming user is deleted", async () => {
    // Distinct creator so the invite's createdBy FK (which DOES cascade) does
    // not delete the row out from under the assertion when we delete claimer.
    const creator = await insertUser("admin");
    const claimer = await insertUser("member");

    const [invite] = await db
      .insert(invites)
      .values({
        tokenHash: `tok-${suffix}-claimed`,
        role: "member",
        type: "invite",
        createdBy: creator.id,
        claimedByUserId: claimer.id,
        claimedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
      })
      .returning();
    expect(invite.claimedByUserId).toBe(claimer.id);

    await db.delete(users).where(eq(users.id, claimer.id));

    const [survivor] = await db.select().from(invites).where(eq(invites.id, invite.id));
    expect(survivor).toBeDefined();
    expect(survivor.claimedByUserId).toBeNull();
    // The rest of the historical record is untouched.
    expect(survivor.createdBy).toBe(creator.id);
    expect(survivor.claimedAt).not.toBeNull();
  });
});

// Drift guard for sub-task E of #259. The CHECK constraints in db/schema.ts are
// derived from the const arrays in db/enums.ts, and the enum-like columns are
// `.$type<…>()`-typed from the same unions — so schema and app code cannot
// drift at compile time. This test closes the remaining gap: it reads each
// constraint back from the live database and asserts the enforced value set
// equals the const. It fails loudly if someone edits db/enums.ts without
// generating the widening migration (or edits a migration without the const),
// which the two compile-time mechanisms cannot catch.
describe("CHECK constraints match db/enums.ts (drift guard, #259)", () => {
  async function enforcedValues(constraintName: string): Promise<Set<string>> {
    const rows = (await db.execute(
      sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${constraintName}`
    )) as unknown as Array<{ def: string }>;
    expect(rows.length, `constraint ${constraintName} should exist`).toBe(1);
    // Postgres renders `col IN ('a','b')` as `col = ANY (ARRAY['a'::text, …])`.
    // Every allowed value is the only single-quoted token in the definition.
    const literals = [...rows[0].def.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    return new Set(literals);
  }

  it.each([
    ["users_role_check", USER_ROLES],
    ["agents_visibility_check", AGENT_VISIBILITIES],
    ["invites_role_check", INVITE_ROLES],
    ["invites_type_check", INVITE_TYPES],
    ["integration_connections_type_check", INTEGRATION_CONNECTION_TYPES],
    ["integration_connections_status_check", INTEGRATION_CONNECTION_STATUSES],
    ["email_workflows_status_check", EMAIL_WORKFLOW_STATUSES],
    ["processed_emails_status_check", PROCESSED_EMAIL_STATUSES],
    ["notifications_status_check", NOTIFICATION_STATUSES],
  ] as const)("%s enforces exactly its const's values", async (constraintName, values) => {
    expect(await enforcedValues(constraintName)).toEqual(new Set(values));
  });
});
