/**
 * Validates that the pinchy-image plugin configSchema declares all fields
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
import { validatePluginEntry } from "../../web/src/lib/openclaw-config/plugin-schema";
import { loadPluginManifest } from "../../web/src/lib/openclaw-config/plugin-manifest-loader";

const manifest = loadPluginManifest("pinchy-image");

// Mirrors the shape regenerateOpenClawConfig() emits for pinchy-image.
const REPRESENTATIVE_EMITTED_CONFIG = {
  agents: {
    "agent-uuid": {
      tools: ["image_crop", "image_resize", "image_rotate", "image_convert"],
    },
  },
};

describe("pinchy-image manifest contract", () => {
  it("validates the config shape that regenerateOpenClawConfig() writes", () => {
    const result = validatePluginEntry(manifest, REPRESENTATIVE_EMITTED_CONFIG);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.ok).toBe(true);
  });

  it("rejects an empty config (agents is required)", () => {
    const result = validatePluginEntry(manifest, {});
    expect(result.ok).toBe(false);
  });

  it("uses additionalProperties: false at the top level", () => {
    expect((manifest.configSchema as Record<string, unknown>).additionalProperties).toBe(false);
  });
});
