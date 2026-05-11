import { describe, it, expect } from "vitest";
import { parseUnsupportedAttachmentError } from "@/lib/chat-errors";

describe("parseUnsupportedAttachmentError", () => {
  it("detects vision error", () => {
    expect(parseUnsupportedAttachmentError("model does not accept image inputs")).toEqual({
      capability: "vision",
    });
  });

  it("detects documents error", () => {
    expect(parseUnsupportedAttachmentError("model does not accept document inputs")).toEqual({
      capability: "documents",
    });
  });

  it("returns null for unknown errors", () => {
    expect(parseUnsupportedAttachmentError("some other error")).toBeNull();
  });

  it("matches partial strings (as they appear in real provider error messages)", () => {
    expect(
      parseUnsupportedAttachmentError(
        "Request failed: this model does not accept image inputs, please use a different model"
      )
    ).toEqual({ capability: "vision" });
  });
});
