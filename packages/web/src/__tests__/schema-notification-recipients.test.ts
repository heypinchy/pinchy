import { describe, it, expect } from "vitest";
import { getTableColumns, type SQL } from "drizzle-orm";
import { getTableConfig, type IndexedColumn } from "drizzle-orm/pg-core";
import { notificationRecipients } from "@/db/schema";

/**
 * `IndexConfig.columns` is `Partial<IndexedColumn | SQL>[]` — an index can
 * mix plain columns and raw SQL expressions, so drizzle's own type only
 * guarantees the properties common to both (effectively none). Every column
 * in this index is a plain column reference, never a raw SQL expression, so
 * this narrows to that real case instead of asserting `name` exists via a
 * cast.
 */
function indexedColumnName(col: Partial<IndexedColumn | SQL>): string {
  if (!("name" in col) || typeof col.name !== "string") {
    throw new Error("expected a plain IndexedColumn with a string name, not a raw SQL expression");
  }
  return col.name;
}

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
    expect(idx!.config.columns.map(indexedColumnName)).toEqual(["user_id", "read_at"]);
  });
});
