import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KNOWN_PINCHY_PLUGINS } from "@/lib/openclaw-config/plugin-manifest-loader";

const REPO_ROOT = resolve(__dirname, "../../../../../..");
const DOCKERFILE = readFileSync(resolve(REPO_ROOT, "Dockerfile.pinchy"), "utf8");

describe("Dockerfile.pinchy plugin coverage", () => {
  it.each(KNOWN_PINCHY_PLUGINS)("copies %s into /openclaw-extensions/", (plugin) => {
    const expected = `COPY packages/plugins/${plugin} /openclaw-extensions/${plugin}`;
    expect(DOCKERFILE).toContain(expected);
  });

  it.each(KNOWN_PINCHY_PLUGINS)(
    "copies the %s manifest into the build context for Next.js",
    (plugin) => {
      const expected = `COPY packages/plugins/${plugin}/openclaw.plugin.json packages/plugins/${plugin}/`;
      expect(DOCKERFILE).toContain(expected);
    }
  );
});
