import { describe, it, expect } from "vitest";
import { emailConnectionCursors } from "@/db/schema";

const cols = (t: unknown) => (t as any)[Symbol.for("drizzle:Columns")];

describe("email_connection_cursors schema", () => {
  it("has the expected columns", () => {
    expect(Object.keys(cols(emailConnectionCursors))).toEqual(
      expect.arrayContaining(["connectionId", "cursor", "updatedAt"])
    );
  });

  it("requires cursor and makes connectionId the primary key", () => {
    const c = cols(emailConnectionCursors);
    expect(c.cursor.notNull).toBe(true);
    expect(c.connectionId.primary).toBe(true);
  });
});
