import { describe, it, expect } from "vitest";
import { oversizeAttachmentError } from "@/lib/attachment-size-check";
import { CLIENT_MAX_ATTACHMENT_SIZE_BYTES } from "@/lib/limits";

const MAX = CLIENT_MAX_ATTACHMENT_SIZE_BYTES; // 15 MB

describe("oversizeAttachmentError", () => {
  it("rejects a non-image file over the limit with a message naming the file and both sizes", () => {
    const msg = oversizeAttachmentError({
      name: "Noboarding.pdf",
      type: "application/pdf",
      size: 31 * 1024 * 1024,
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain("Noboarding.pdf");
    expect(msg).toContain("31 MB"); // actual size
    expect(msg).toContain("15 MB"); // limit
  });

  it("accepts a non-image file at or under the limit (returns null)", () => {
    expect(
      oversizeAttachmentError({ name: "a.pdf", type: "application/pdf", size: MAX })
    ).toBeNull();
    expect(
      oversizeAttachmentError({ name: "a.pdf", type: "application/pdf", size: MAX - 1 })
    ).toBeNull();
  });

  it("never rejects images by raw size — they are compressed client-side before upload", () => {
    expect(
      oversizeAttachmentError({ name: "photo.jpg", type: "image/jpeg", size: 50 * 1024 * 1024 })
    ).toBeNull();
    expect(
      oversizeAttachmentError({ name: "shot.png", type: "image/png", size: 40 * 1024 * 1024 })
    ).toBeNull();
  });

  it("rejects a large CSV/other non-image type too (not just PDFs)", () => {
    const msg = oversizeAttachmentError({
      name: "export.csv",
      type: "text/csv",
      size: 20 * 1024 * 1024,
    });
    expect(msg).toContain("export.csv");
    expect(msg).toContain("20 MB");
  });
});
