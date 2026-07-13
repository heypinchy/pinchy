import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { notificationRecipients } from "@/db/schema";

describe("notification_recipients schema", () => {
  it("has exactly the expected columns", () => {
    expect(new Set(Object.keys(getTableColumns(notificationRecipients)))).toEqual(
      new Set(["userId", "notificationId", "deliveredAt", "readAt"])
    );
  });

  it("requires userId and notificationId", () => {
    const c = getTableColumns(notificationRecipients);
    expect(c.userId.notNull).toBe(true);
    expect(c.notificationId.notNull).toBe(true);
    // readAt null == unread; the whole point of the per-user read state.
    expect(c.readAt.notNull).toBe(false);
  });

  it("has a composite primary key on (userId, notificationId)", () => {
    const { primaryKeys } = getTableConfig(notificationRecipients);
    expect(primaryKeys).toHaveLength(1);
    expect(primaryKeys[0].columns.map((col) => col.name)).toEqual(["user_id", "notification_id"]);
  });

  it("has the (userId, readAt) unread index", () => {
    const { indexes } = getTableConfig(notificationRecipients);
    const idx = indexes.find((i) => i.config.name === "notification_recipients_user_unread_idx");
    expect(idx).toBeDefined();
    expect(idx!.config.columns.map((col: { name: string }) => col.name)).toEqual([
      "user_id",
      "read_at",
    ]);
  });
});
