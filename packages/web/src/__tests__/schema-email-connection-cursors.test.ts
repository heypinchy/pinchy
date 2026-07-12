import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { emailConnectionCursors } from "@/db/schema";

describe("email_connection_cursors schema", () => {
  it("has exactly the expected columns", () => {
    expect(new Set(Object.keys(getTableColumns(emailConnectionCursors)))).toEqual(
      new Set(["connectionId", "cursor", "updatedAt"])
    );
  });

  it("requires cursor and makes connectionId the primary key", () => {
    const c = getTableColumns(emailConnectionCursors);
    expect(c.cursor.notNull).toBe(true);
    expect(c.connectionId.primary).toBe(true);
  });
});
