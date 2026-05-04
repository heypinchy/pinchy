import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KNOWN_PINCHY_PLUGINS } from "@/lib/openclaw-config/plugin-manifest-loader";

const REPO_ROOT = resolve(__dirname, "../../../../..");
const ENTRYPOINT = readFileSync(resolve(REPO_ROOT, "entrypoint.sh"), "utf8");

describe("entrypoint.sh plugin runtime check", () => {
  it("hardcodes the expected-plugin list", () => {
    for (const plugin of KNOWN_PINCHY_PLUGINS) {
      expect(ENTRYPOINT).toContain(plugin);
    }
  });

  it("fails fast (exit 1) if a plugin directory is missing", () => {
    expect(ENTRYPOINT).toMatch(/exit 1/);
    expect(ENTRYPOINT).toMatch(/openclaw-extensions/);
  });
});
