// Real-DB integration tests for the Background-Jobs notification fan-out
// (foundation #704). Background-run output lands in `notifications` and fans out
// to one `notification_recipients` row per recipient, each carrying that user's
// own read state. Written once here; the dispatcher (next slice) is the caller.
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { agents, users, notifications, notificationRecipients } from "@/db/schema";
import { notify } from "@/lib/notifications/store";

let userCounter = 0;
async function seedUser() {
  const [row] = await db
    .insert(users)
    .values({
      email: `notify-fanout-${userCounter++}@test.local`,
      name: "Feed Reader",
    })
    .returning();
  return row;
}

async function seedAgent() {
  const [row] = await db
    .insert(agents)
    .values({
      name: "Penny",
      model: "ollama-cloud/gemini-3-flash",
      greetingMessage: "Hi",
    })
    .returning();
  return row;
}

async function recipientsOf(notificationId: string) {
  return db
    .select()
    .from(notificationRecipients)
    .where(eq(notificationRecipients.notificationId, notificationId));
}

describe("notification fan-out — notify()", () => {
  it("fans out one notification to every recipient, each unread", async () => {
    const agent = await seedAgent();
    const a = await seedUser();
    const b = await seedUser();

    const id = await notify({
      agentId: agent.id,
      title: "3 invoices filed",
      content: "Drafted 3 supplier bills in Odoo.",
      status: "success",
      sourceType: "inbox",
      sourceId: "run-1",
      recipientUserIds: [a.id, b.id],
    });

    const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
    expect(row.agentId).toBe(agent.id);
    expect(row.title).toBe("3 invoices filed");
    expect(row.status).toBe("success");
    expect(row.sourceType).toBe("inbox");
    expect(row.sourceId).toBe("run-1");

    const recips = await recipientsOf(id);
    expect(new Set(recips.map((r) => r.userId))).toEqual(new Set([a.id, b.id]));
    // readAt null == unread; deliveredAt stamped on write.
    expect(recips.every((r) => r.readAt === null)).toBe(true);
    expect(recips.every((r) => r.deliveredAt !== null)).toBe(true);
  });

  it("refuses a notification with no recipients and persists nothing", async () => {
    const agent = await seedAgent();

    // A notification nobody can see is a caller bug. Reject it *before* any
    // insert so no orphan notification row is left behind.
    await expect(
      notify({
        agentId: agent.id,
        title: "orphan",
        content: "nobody",
        status: "success",
        recipientUserIds: [],
      })
    ).rejects.toThrow(/recipient/i);

    const rows = await db.select().from(notifications).where(eq(notifications.agentId, agent.id));
    expect(rows).toHaveLength(0);
  });

  it("records a failure notification with its error message", async () => {
    const agent = await seedAgent();
    const u = await seedUser();

    const id = await notify({
      agentId: agent.id,
      title: "Processing failed",
      content: "Could not reach Odoo.",
      status: "failure",
      errorMessage: "ECONNREFUSED",
      recipientUserIds: [u.id],
    });

    const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
    expect(row.status).toBe("failure");
    expect(row.errorMessage).toBe("ECONNREFUSED");
  });

  it("cascades recipient rows when the notification is deleted", async () => {
    const agent = await seedAgent();
    const u = await seedUser();
    const id = await notify({
      agentId: agent.id,
      title: "t",
      content: "c",
      status: "success",
      recipientUserIds: [u.id],
    });

    await db.delete(notifications).where(eq(notifications.id, id));

    expect(await recipientsOf(id)).toHaveLength(0);
  });

  it("cascades the notification when its agent is deleted", async () => {
    const agent = await seedAgent();
    const u = await seedUser();
    const id = await notify({
      agentId: agent.id,
      title: "t",
      content: "c",
      status: "success",
      recipientUserIds: [u.id],
    });

    await db.delete(agents).where(eq(agents.id, agent.id));

    const rows = await db.select().from(notifications).where(eq(notifications.id, id));
    expect(rows).toHaveLength(0);
    // …and the recipient rows go with it (FK cascade through notifications).
    expect(await recipientsOf(id)).toHaveLength(0);
  });
});

describe("notification fan-out — status CHECK", () => {
  function violates(pattern: RegExp) {
    return (err: unknown) => {
      const e = err as {
        message?: unknown;
        cause?: { message?: unknown; constraint?: unknown };
        constraint?: unknown;
      };
      const text = [e?.message, e?.cause?.message, e?.cause?.constraint, e?.constraint]
        .filter((v): v is string => typeof v === "string")
        .join(" ");
      return pattern.test(text);
    };
  }

  it("rejects an out-of-domain notifications.status at the DB", async () => {
    const agent = await seedAgent();
    await expect(
      db.insert(notifications).values({
        agentId: agent.id,
        title: "bad",
        content: "bad",
        status: "bogus" as never,
      })
    ).rejects.toSatisfy(violates(/notifications_status_check/));
  });
});
