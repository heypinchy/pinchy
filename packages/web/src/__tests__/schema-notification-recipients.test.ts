import { describe, it, expect } from "vitest";
import { notificationRecipients } from "@/db/schema";

describe("notification_recipients schema", () => {
  it("has composite primary key and required columns", () => {
    const cols = notificationRecipients[Symbol.for("drizzle:Columns") as any];
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining(["userId", "notificationId", "deliveredAt", "readAt"])
    );
  });
});
