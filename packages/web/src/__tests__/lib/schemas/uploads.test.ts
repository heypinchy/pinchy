import { describe, it, expect } from "vitest";
import { attachmentIdsSchema, draftIdSchema, uploadResponseSchema } from "@/lib/schemas/uploads";

describe("uploads schemas", () => {
  it("attachmentIdsSchema accepts up to 10 UUIDs", () => {
    const ids = Array.from({ length: 10 }, () => crypto.randomUUID());
    expect(attachmentIdsSchema.parse(ids)).toEqual(ids);
  });

  it("attachmentIdsSchema rejects > 10 ids", () => {
    const ids = Array.from({ length: 11 }, () => crypto.randomUUID());
    expect(() => attachmentIdsSchema.parse(ids)).toThrow();
  });

  it("attachmentIdsSchema rejects non-UUID strings", () => {
    expect(() => attachmentIdsSchema.parse(["not-a-uuid"])).toThrow();
  });

  it("draftIdSchema accepts a UUID string", () => {
    const id = crypto.randomUUID();
    expect(draftIdSchema.parse(id)).toBe(id);
  });

  it("draftIdSchema rejects a non-UUID string", () => {
    expect(() => draftIdSchema.parse("not-a-uuid")).toThrow();
  });

  it("uploadResponseSchema describes the POST /uploads response shape", () => {
    const ok = uploadResponseSchema.parse({
      id: crypto.randomUUID(),
      filename: "x.pdf",
      mimeType: "application/pdf",
      sizeBytes: 100,
    });
    expect(ok.filename).toBe("x.pdf");
  });

  it("uploadResponseSchema rejects missing required fields", () => {
    expect(() => uploadResponseSchema.parse({ filename: "x.pdf" })).toThrow();
  });
});
