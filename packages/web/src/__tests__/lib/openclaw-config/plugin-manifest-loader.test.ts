import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import {
  loadPluginManifest,
  KNOWN_PINCHY_PLUGINS,
  EXTERNAL_INTEGRATION_PLUGINS,
  INTERNAL_PLUGINS,
} from "@/lib/openclaw-config/plugin-manifest-loader";

const PLUGINS_ROOT = join(process.cwd(), "../plugins");

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

describe("KNOWN_PINCHY_PLUGINS drift guard", () => {
  // Same shape as the KNOWN_SKILLS guard in skills.test.ts: the const list and
  // the on-disk truth under packages/plugins must agree, so a new plugin
  // cannot silently escape config emission / manifest loading, and a removed
  // plugin cannot leave a dangling entry.

  it("every KNOWN_PINCHY_PLUGINS entry has a directory on disk", () => {
    for (const id of KNOWN_PINCHY_PLUGINS) {
      const pluginDir = join(PLUGINS_ROOT, id);
      expect(existsSync(pluginDir), `expected a plugin directory at ${pluginDir}`).toBe(true);
    }
  });

  it("every on-disk packages/plugins/pinchy-* directory is listed in KNOWN_PINCHY_PLUGINS", () => {
    const onDisk = readdirSync(PLUGINS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => name.startsWith("pinchy-"));

    for (const id of onDisk) {
      expect(
        KNOWN_PINCHY_PLUGINS,
        `on-disk plugin "${id}" missing from KNOWN_PINCHY_PLUGINS`
      ).toContain(id);
    }
  });
});
