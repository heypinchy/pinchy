import { describe, it, expect } from "vitest";
import { secretRef } from "@/lib/openclaw-secrets";

describe("secretRef", () => {
  it("builds a SecretRef pointing at the pinchy file provider", () => {
    expect(secretRef("/providers/anthropic/apiKey")).toEqual({
      source: "file",
      provider: "pinchy",
      id: "/providers/anthropic/apiKey",
    });
  });
});
