// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { users, invites } from "@/db/schema";
import { makeLicense } from "../helpers/license-fixtures";

async function clearTables() {
  await db.delete(invites);
  await db.delete(users);
}

async function seedUser(opts: { id: string; banned?: boolean }) {
  await db.insert(users).values({
    id: opts.id,
    email: `${opts.id}@test.local`,
    name: opts.id,
    role: "member",
    banned: opts.banned ?? false,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seedInvite(opts: {
  id: string;
  claimedAt?: Date | null;
  expiresAt: Date;
  createdBy: string;
}) {
  await db.insert(invites).values({
    id: opts.id,
    tokenHash: `hash-${opts.id}`,
    role: "member",
    type: "invite",
    createdBy: opts.createdBy,
    expiresAt: opts.expiresAt,
    claimedAt: opts.claimedAt ?? null,
  });
}

describe("getSeatUsage", () => {
  beforeEach(clearTables);

  it("returns unlimited when license has maxUsers=0", async () => {
    const { getSeatUsage } = await import("@/lib/seat-usage");
    const usage = await getSeatUsage(makeLicense({ maxUsers: 0 }));
    expect(usage.unlimited).toBe(true);
    expect(usage.available).toBeNull();
    expect(usage.max).toBe(0);
  });

  it("counts active users plus valid pending invites", async () => {
    await seedUser({ id: "u1" });
    await seedUser({ id: "u2" });
    await seedUser({ id: "u3" });
    await seedInvite({
      id: "i1",
      expiresAt: new Date(Date.now() + 86400000),
      createdBy: "u1",
    });
    const { getSeatUsage } = await import("@/lib/seat-usage");
    const usage = await getSeatUsage(makeLicense({ maxUsers: 5 }));
    expect(usage.activeUsers).toBe(3);
    expect(usage.pendingInvites).toBe(1);
    expect(usage.used).toBe(4);
    expect(usage.available).toBe(1);
    expect(usage.unlimited).toBe(false);
  });

  it("excludes banned users from active count", async () => {
    await seedUser({ id: "u1" });
    await seedUser({ id: "u2", banned: true });
    const { getSeatUsage } = await import("@/lib/seat-usage");
    const usage = await getSeatUsage(makeLicense({ maxUsers: 5 }));
    expect(usage.activeUsers).toBe(1);
  });

  it("counts users with null banned as active", async () => {
    await db.insert(users).values({
      id: "u-null-banned",
      email: "null-banned@test.local",
      name: "null-banned",
      role: "member",
      banned: null,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { getSeatUsage } = await import("@/lib/seat-usage");
    const usage = await getSeatUsage(makeLicense({ maxUsers: 5 }));
    expect(usage.activeUsers).toBe(1);
  });

  it("excludes expired invites", async () => {
    await seedUser({ id: "u1" });
    await seedInvite({
      id: "i1",
      expiresAt: new Date(Date.now() - 86400000),
      createdBy: "u1",
    });
    const { getSeatUsage } = await import("@/lib/seat-usage");
    const usage = await getSeatUsage(makeLicense({ maxUsers: 5 }));
    expect(usage.pendingInvites).toBe(0);
  });

  it("excludes claimed invites", async () => {
    await seedUser({ id: "u1" });
    await seedInvite({
      id: "i1",
      expiresAt: new Date(Date.now() + 86400000),
      claimedAt: new Date(),
      createdBy: "u1",
    });
    const { getSeatUsage } = await import("@/lib/seat-usage");
    const usage = await getSeatUsage(makeLicense({ maxUsers: 5 }));
    expect(usage.pendingInvites).toBe(0);
  });

  it("clamps available to 0 when over cap", async () => {
    await seedUser({ id: "u1" });
    await seedUser({ id: "u2" });
    await seedUser({ id: "u3" });
    const { getSeatUsage } = await import("@/lib/seat-usage");
    const usage = await getSeatUsage(makeLicense({ maxUsers: 2 }));
    expect(usage.used).toBe(3);
    expect(usage.available).toBe(0);
  });
});

describe("isSeatAvailable", () => {
  beforeEach(clearTables);

  it("is always true when license is unlimited", async () => {
    await seedUser({ id: "u1" });
    const { isSeatAvailable } = await import("@/lib/seat-usage");
    expect(await isSeatAvailable(makeLicense({ maxUsers: 0 }))).toBe(true);
  });

  it("is false when at the cap", async () => {
    await seedUser({ id: "u1" });
    await seedUser({ id: "u2" });
    const { isSeatAvailable } = await import("@/lib/seat-usage");
    expect(await isSeatAvailable(makeLicense({ maxUsers: 2 }))).toBe(false);
  });

  it("is true when below the cap", async () => {
    await seedUser({ id: "u1" });
    const { isSeatAvailable } = await import("@/lib/seat-usage");
    expect(await isSeatAvailable(makeLicense({ maxUsers: 5 }))).toBe(true);
  });
});
