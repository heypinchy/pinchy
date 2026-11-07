/**
 * Drift guard: `web-chat-run.ts` is duplicated, byte-for-byte, into every
 * plugin that hands the user a file through a `type: "file"` block
 * (pinchy-email's email_get_attachment, pinchy-files' pinchy_generate_file).
 *
 * The duplication is forced: each plugin directory is mounted into the
 * OpenClaw container on its own, so an import reaching into a sibling plugin
 * resolves to a path that is not there at runtime. Two copies of "is this a
 * web-chat run?" that disagree would let one tool tell the agent a Telegram
 * user got a download chip while the other says it did not — the false claim
 * the module exists to remove.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PLUGINS_DIR = resolve(import.meta.dirname, "../../../../plugins");
const COPIES = ["pinchy-email", "pinchy-files"];

function read(plugin: string): string {
  return readFileSync(resolve(PLUGINS_DIR, plugin, "web-chat-run.ts"), "utf-8");
}

describe("web-chat-run.ts drift guard", () => {
  it("every copy is byte-identical to pinchy-email's", () => {
    const canonical = read("pinchy-email");
    expect(canonical).toContain("export function isWebChatRun(");
    for (const plugin of COPIES) {
      expect(read(plugin), `${plugin}/web-chat-run.ts drifted`).toBe(canonical);
    }
  });

  it("stays import-free, so each copy loads standalone", () => {
    for (const plugin of COPIES) {
      expect(read(plugin)).not.toMatch(/^\s*import\s/m);
    }
  });

  it("each plugin uses its copy instead of a private reimplementation", () => {
    for (const plugin of COPIES) {
      const index = readFileSync(resolve(PLUGINS_DIR, plugin, "index.ts"), "utf-8");
      expect(index).toMatch(/from "\.\/web-chat-run(\.js)?"/);
      expect(index).not.toMatch(/function isWebChatRun\(/);
    }
  });
});
