import { describe, expect, it } from "vitest";
import { sendingOpacityClass } from "@/components/assistant-ui/thread";

describe("sendingOpacityClass", () => {
  it("returns 'opacity-60' when status is 'sending'", () => {
    expect(sendingOpacityClass("sending")).toBe("opacity-60");
  });

  it("returns empty string when status is 'sent'", () => {
    expect(sendingOpacityClass("sent")).toBe("");
  });

  it("returns empty string when status is 'failed'", () => {
    expect(sendingOpacityClass("failed")).toBe("");
  });

  it("returns empty string when status is undefined", () => {
    expect(sendingOpacityClass(undefined)).toBe("");
  });
});
