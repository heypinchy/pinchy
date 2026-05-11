import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { getTableName } from "drizzle-orm";
import { uploadedFiles } from "@/db/schema";

describe("uploadedFiles schema", () => {
  it("has physical table name uploaded_files", () => {
    expect(getTableName(uploadedFiles)).toBe("uploaded_files");
  });

  it("declares the expected columns", () => {
    const cols = Object.keys(uploadedFiles);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "userId",
        "agentId",
        "draftId",
        "filename",
        "mimeType",
        "sizeBytes",
        "contentHash",
        "status",
        "expiresAt",
        "messageId",
        "createdAt",
        "attachedAt",
        "stagingPath",
      ])
    );
  });

  it("constrains status to staged | attached", () => {
    const config = getTableConfig(uploadedFiles);
    const statusCol = config.columns.find((c) => c.name === "status");
    expect(statusCol?.enumValues).toEqual(["staged", "attached"]);
  });
});
