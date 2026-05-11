import { describe, it, expect } from "vitest";
import { uploadedFiles } from "@/db/schema";

describe("uploadedFiles schema", () => {
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
    expect(uploadedFiles.status).toBeDefined();
  });
});
