import { describe, it, expect } from "vitest";
import {
  loadPluginManifest,
  KNOWN_PINCHY_PLUGINS,
  EXTERNAL_INTEGRATION_PLUGINS,
  INTERNAL_PLUGINS,
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

describe("plugin classification", () => {
  it("every known plugin is in exactly one bucket", () => {
    const all = [...EXTERNAL_INTEGRATION_PLUGINS, ...INTERNAL_PLUGINS];
    expect(new Set(all).size).toBe(all.length); // no duplicates
    expect(new Set(all)).toEqual(new Set(KNOWN_PINCHY_PLUGINS));
  });

  it("classifies pinchy-web, pinchy-email, pinchy-odoo as external", () => {
    expect(EXTERNAL_INTEGRATION_PLUGINS).toEqual(
      expect.arrayContaining(["pinchy-web", "pinchy-email", "pinchy-odoo"])
    );
  });

  it("classifies pinchy-files, pinchy-context, pinchy-docs, pinchy-audit as internal", () => {
    expect(INTERNAL_PLUGINS).toEqual(
      expect.arrayContaining(["pinchy-files", "pinchy-context", "pinchy-docs", "pinchy-audit"])
    );
  });
});
