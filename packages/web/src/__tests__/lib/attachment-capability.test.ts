import { describe, expect, it } from "vitest";
import { requiredCapabilityForFile } from "@/lib/attachment-capability";

describe("requiredCapabilityForFile", () => {
  it("requires vision for image attachments — images ship base64 as direct model input", () => {
    expect(requiredCapabilityForFile("image/png")).toBe("vision");
    expect(requiredCapabilityForFile("image/jpeg")).toBe("vision");
    expect(requiredCapabilityForFile("image/heic")).toBe("vision");
  });

  it("requires no capability for PDFs — they route via OpenClaw's pdf tool, whose model Pinchy resolves independently of the agent model", () => {
    expect(requiredCapabilityForFile("application/pdf")).toBeNull();
  });

  it("requires no capability for text formats — they are workspace files read via pinchy_read", () => {
    expect(requiredCapabilityForFile("text/plain")).toBeNull();
    expect(requiredCapabilityForFile("text/csv")).toBeNull();
    expect(requiredCapabilityForFile("application/json")).toBeNull();
  });
});
