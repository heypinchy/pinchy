import { describe, it, expect } from "vitest";
import { validatePluginEntry } from "../../web/src/lib/openclaw-config/plugin-schema";
import { loadPluginManifest } from "../../web/src/lib/openclaw-config/plugin-manifest-loader";

const manifest = loadPluginManifest("pinchy-docs");

// Mirrors build.ts:289-296 — agents map to empty objects.
const REPRESENTATIVE_EMITTED_CONFIG = {
  docsPath: "/pinchy-docs",
  agents: {
    "agent-uuid": {},
  },
};

describe("pinchy-docs manifest contract", () => {
  it("validates the config shape that regenerateOpenClawConfig() writes", () => {
    const result = validatePluginEntry(manifest, REPRESENTATIVE_EMITTED_CONFIG);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.ok).toBe(true);
  });

  it("requires docsPath and agents", () => {
    expect(validatePluginEntry(manifest, { agents: {} }).ok).toBe(false);
    expect(validatePluginEntry(manifest, { docsPath: "/x" }).ok).toBe(false);
  });

  it("uses additionalProperties: false", () => {
    expect((manifest.configSchema as Record<string, unknown>).additionalProperties).toBe(false);
  });
});
