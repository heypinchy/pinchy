// Real-DB integration proof of GDPR crypto-erasure for audit_log.actorId.
//
// audit_log is append-only and HMAC-signed (see lib/audit.ts), so its rows
// can never be rewritten or deleted to satisfy an Art. 17 erasure request.
// Instead, appendAuditLog() substitutes a random per-user auditPseudonym for
// the raw users.id when writing a row for actorType:"user" — the mapping
// lives in the (mutable) users row, not in the immutable log. Deleting the
// user deletes the mapping: the audit rows survive (the trail is intact),
// but nothing in the database can link them back to the person anymore.
//
// This file proves both directions of the read/write contract:
//   - the WRITE substitutes the pseudonym, not the raw id (row inspected
//     directly);
//   - after erasure, no `users` row carries that pseudonym any more, so a
//     join-based name lookup (as /api/audit does) can no longer resolve it —
//     the row is provably unlinkable, not merely "hard to find".
//
// A companion migration-vs-old-data test lives in
// diagnostics/audit-collector.integration.test.ts and proves the dual-join
// read side still resolves rows written BEFORE this feature (raw actorId).

import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { appendAuditLog } from "@/lib/audit";
import { db } from "@/db";
import { auditLog, users } from "@/db/schema";

async function createUser(overrides: Partial<typeof users.$inferInsert> = {}) {
  const [row] = await db
    .insert(users)
    .values({
      name: "Erasure Test User",
      email: `erasure-${Math.random().toString(36).slice(2)}@example.com`,
      emailVerified: true,
      role: "member",
      ...overrides,
    })
    .returning();
  return row;
}

describe("audit_log crypto-erasure (integration)", () => {
  it("writes the user's auditPseudonym (not the raw users.id) into actor_id", async () => {
    const user = await createUser();

    await appendAuditLog({
      actorType: "user",
      actorId: user.id,
      eventType: "auth.login",
      outcome: "success",
    });

    const [row] = await db.select().from(auditLog).where(eq(auditLog.eventType, "auth.login"));
    expect(row.actorId).toBe(user.auditPseudonym);
    expect(row.actorId).not.toBe(user.id);
  });

  it("erasure: deleting the user leaves the audit row intact but unlinkable", async () => {
    const user = await createUser();

    await appendAuditLog({
      actorType: "user",
      actorId: user.id,
      eventType: "agent.created",
      resource: "agent:abc",
      detail: { name: "Smithers" },
      outcome: "success",
    });

    const [beforeErasure] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "agent.created"));
    expect(beforeErasure.actorId).toBe(user.auditPseudonym);

    // Erasure: delete the user. This is the only mutation crypto-erasure
    // performs — the audit_log row itself is never touched (it's immutable).
    await db.delete(users).where(eq(users.id, user.id));

    // The audit row survives untouched — the trail is intact.
    const [afterErasure] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "agent.created"));
    expect(afterErasure).toBeDefined();
    expect(afterErasure.id).toBe(beforeErasure.id);
    expect(afterErasure.actorId).toBe(beforeErasure.actorId);
    expect(afterErasure.rowHmac).toBe(beforeErasure.rowHmac);
    expect(afterErasure.detail).toEqual({ name: "Smithers" });

    // Name resolution is now impossible: no users row carries this
    // pseudonym (nor the original id) any more — the row is unlinkable.
    const matchByPseudonym = await db
      .select()
      .from(users)
      .where(eq(users.auditPseudonym, afterErasure.actorId));
    expect(matchByPseudonym).toHaveLength(0);

    const matchByOriginalId = await db.select().from(users).where(eq(users.id, user.id));
    expect(matchByOriginalId).toHaveLength(0);
  });

  it("a second user's rows are unaffected by another user's erasure", async () => {
    const erasedUser = await createUser();
    const survivingUser = await createUser();

    await appendAuditLog({
      actorType: "user",
      actorId: erasedUser.id,
      eventType: "auth.login",
      outcome: "success",
    });
    await appendAuditLog({
      actorType: "user",
      actorId: survivingUser.id,
      eventType: "auth.login",
      outcome: "success",
    });

    await db.delete(users).where(eq(users.id, erasedUser.id));

    // The surviving user's pseudonym mapping is untouched and still resolves.
    const [survivorRow] = await db
      .select()
      .from(users)
      .where(eq(users.auditPseudonym, survivingUser.auditPseudonym));
    expect(survivorRow).toBeDefined();
    expect(survivorRow.id).toBe(survivingUser.id);
  });

  it("backfills audit_pseudonym via a DB-level default for inserts that bypass Drizzle", async () => {
    // auditPseudonym previously only had a Drizzle-side $defaultFn, which
    // fires only for inserts issued through this Drizzle table object. Any
    // insert into "user" that does NOT go through db.insert(users) — e.g.
    // Better Auth's own adapter queries, or a raw-SQL seed/migration — would
    // violate the NOT NULL constraint because nothing populates the column.
    // This raw SQL INSERT simulates that non-Drizzle path: every column
    // except audit_pseudonym is supplied explicitly, so the only way this
    // insert can succeed is a DB-level DEFAULT on the column itself.
    const id = crypto.randomUUID();
    const email = `raw-insert-${Math.random().toString(36).slice(2)}@example.com`;

    await db.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified, role) VALUES (${id}, ${"Raw Insert User"}, ${email}, ${true}, ${"member"})`
    );

    const [row] = await db.select().from(users).where(eq(users.id, id));
    expect(row).toBeDefined();
    expect(row.auditPseudonym).toEqual(expect.any(String));
    expect(row.auditPseudonym.length).toBeGreaterThan(0);

    // Uniqueness: a second raw insert must get a DIFFERENT pseudonym, not a
    // fixed/constant default that would violate the UNIQUE constraint (or
    // worse, silently collide two users' erasure mappings).
    const id2 = crypto.randomUUID();
    const email2 = `raw-insert-${Math.random().toString(36).slice(2)}@example.com`;
    await db.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified, role) VALUES (${id2}, ${"Raw Insert User 2"}, ${email2}, ${true}, ${"member"})`
    );
    const [row2] = await db.select().from(users).where(eq(users.id, id2));
    expect(row2.auditPseudonym).not.toBe(row.auditPseudonym);
  });
});
