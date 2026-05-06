import { describe, it, expect } from "vitest";
import { validatePluginEntry } from "@/lib/openclaw-config/plugin-schema";

const FAKE_MANIFEST = {
  id: "pinchy-fake",
  name: "Pinchy Fake",
  description: "Test plugin",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      apiBaseUrl: { type: "string" },
      agents: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: { connectionId: { type: "string" } },
          required: ["connectionId"],
          additionalProperties: false,
        },
      },
    },
    required: ["apiBaseUrl", "agents"],
  },
};

describe("validatePluginEntry", () => {
  it("returns ok=true for a config that matches the schema", () => {
    const result = validatePluginEntry(FAKE_MANIFEST, {
      apiBaseUrl: "http://pinchy:7777",
      agents: { "agent-1": { connectionId: "conn-1" } },
    });
    expect(result.ok).toBe(true);
  });

  it("returns ok=false with errors when a required field is missing", () => {
    const result = validatePluginEntry(FAKE_MANIFEST, {
      agents: { "agent-1": { connectionId: "conn-1" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain("apiBaseUrl");
    }
  });

  it("returns ok=false when an undeclared property is present", () => {
    const result = validatePluginEntry(FAKE_MANIFEST, {
      apiBaseUrl: "http://pinchy:7777",
      agents: {},
      bogus: 42,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/bogus|additional/i);
    }
  });

  it("formats errors with the dotted instance path", () => {
    const result = validatePluginEntry(FAKE_MANIFEST, {
      apiBaseUrl: "http://pinchy:7777",
      agents: { "agent-1": {} },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/agents\.agent-1.*connectionId/);
    }
  });
});
