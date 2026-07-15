// Real-DB integration tests for the Inbox Agent per-connection sync cursor
// (Brick B). The cursor is a cheap "what's new since last tick" pointer — an
// opaque provider token (Gmail historyId / Graph deltaLink / timestamp), one
// per mailbox, shared by every workflow on it (design §4/D2). It is a
// performance optimization only: the `processed_emails` ledger + reconciliation
// sweep are the durable correctness layer, so a lost or stale cursor never
// causes double-processing. The store here is just read + last-write-wins
// upsert; advancing it "only after durable claim" is the orchestrator's job.
//
// Runs against the ephemeral integration Postgres.
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { integrationConnections, emailConnectionCursors } from "@/db/schema";
import { readCursor, advanceCursor } from "@/lib/email-workflows/cursors";

let connCounter = 0;
async function seedConnection() {
  const id = `cursor-conn-${connCounter++}`;
  await db
    .insert(integrationConnections)
    .values({ id, type: "imap", name: "Mailbox", credentials: "enc:placeholder" });
  return id;
}

describe("email connection cursor store", () => {
  it("returns null when a connection has no cursor yet", async () => {
    const conn = await seedConnection();
    expect(await readCursor(conn)).toBeNull();
  });

  it("stores a cursor on first advance and reads it back", async () => {
    const conn = await seedConnection();
    await advanceCursor(conn, "historyId:1000");
    expect(await readCursor(conn)).toBe("historyId:1000");
  });

  it("overwrites an existing cursor (last write wins) and bumps updatedAt", async () => {
    const conn = await seedConnection();
    await advanceCursor(conn, "historyId:1000");
    // Backdate so a real update is observable regardless of clock resolution;
    // this also pins the `updatedAt` refresh in the upsert's set clause.
    const old = new Date("2020-01-01T00:00:00.000Z");
    await db
      .update(emailConnectionCursors)
      .set({ updatedAt: old })
      .where(eq(emailConnectionCursors.connectionId, conn));

    await advanceCursor(conn, "historyId:2000");

    expect(await readCursor(conn)).toBe("historyId:2000");
    const [row] = await db
      .select({ updatedAt: emailConnectionCursors.updatedAt })
      .from(emailConnectionCursors)
      .where(eq(emailConnectionCursors.connectionId, conn));
    expect(row.updatedAt.getTime()).toBeGreaterThan(old.getTime());
  });

  it("keeps cursors independent per connection", async () => {
    const connA = await seedConnection();
    const connB = await seedConnection();
    await advanceCursor(connA, "cursor-A");
    await advanceCursor(connB, "cursor-B");
    expect(await readCursor(connA)).toBe("cursor-A");
    expect(await readCursor(connB)).toBe("cursor-B");
  });
});
