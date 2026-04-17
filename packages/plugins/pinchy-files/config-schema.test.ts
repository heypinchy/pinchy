/**
 * Validates that the pinchy-files plugin configSchema declares all fields
 * that Pinchy's regenerateOpenClawConfig() writes into it.
 *
 * OpenClaw rejects config reloads when the config contains properties not
 * declared in the plugin schema (additionalProperties: false). When that
 * happens, agents created after the last successful reload are unknown to
 * OpenClaw — they can't receive messages.
 *
 * This test catches schema/config divergence at CI time rather than at
 * runtime, where it would silently block all config hot-reloads.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "openclaw.plugin.json"), "utf-8"),
);
const configSchema = manifest.configSchema as {
  type: string;
  additionalProperties: boolean;
  properties: Record<string, unknown>;
  required?: string[];
};

describe("pinchy-files configSchema", () => {
  it("has additionalProperties: false (OpenClaw enforces this)", () => {
    // If this changes, OpenClaw will stop enforcing the schema contract.
    expect(configSchema.additionalProperties).toBe(false);
  });

  it("allows apiBaseUrl — written by regenerateOpenClawConfig() for usage reporting", () => {
    // Pinchy writes this field so the plugin can POST token usage to
    // /api/internal/usage/record after vision API calls (PDF scanning).
    // Without it in the schema, OpenClaw rejects every config reload.
    expect(configSchema.properties).toHaveProperty("apiBaseUrl");
  });

  it("allows gatewayToken — written by regenerateOpenClawConfig() for internal auth", () => {
    // Pinchy writes this field alongside apiBaseUrl so the plugin can
    // authenticate against Pinchy's internal API.
    expect(configSchema.properties).toHaveProperty("gatewayToken");
  });

  it("requires agents property", () => {
    expect(configSchema.required).toContain("agents");
    expect(configSchema.properties).toHaveProperty("agents");
  });
});
