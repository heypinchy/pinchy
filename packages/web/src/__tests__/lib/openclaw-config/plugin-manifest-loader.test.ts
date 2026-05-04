import { describe, it, expect } from "vitest";
import {
  loadPluginManifest,
  KNOWN_PINCHY_PLUGINS,
} from "@/lib/openclaw-config/plugin-manifest-loader";

describe("loadPluginManifest", () => {
  it.each(KNOWN_PINCHY_PLUGINS)("loads the %s manifest with id and configSchema", (id) => {
    const manifest = loadPluginManifest(id);
    expect(manifest.id).toBe(id);
    expect(manifest.configSchema).toBeDefined();
    expect(typeof manifest.configSchema).toBe("object");
  });

  it("throws when the plugin id is unknown", () => {
    expect(() => loadPluginManifest("pinchy-does-not-exist" as never)).toThrow(/unknown.*pinchy/i);
  });
});
