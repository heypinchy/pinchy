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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const PLUGINS_DIR = resolve(import.meta.dirname, "../../../../plugins");
const REFERENCE_PLUGIN = "pinchy-email";

function readIndex(plugin: string): string {
  return readFileSync(resolve(PLUGINS_DIR, plugin, "index.ts"), "utf-8");
}

function readCopy(plugin: string): string {
  return readFileSync(resolve(PLUGINS_DIR, plugin, "web-chat-run.ts"), "utf-8");
}

// A file block built in code: `{ type: "file", …` or `type: "file",` on its
// own line. A type annotation (`| { type: "file"; …`) and a comment do not
// match, so a plugin is counted for what it returns, not for what it names.
const EMITS_FILE_BLOCK = /^\s*(\{\s*)?type:\s*"file",/m;

// Discovered, not listed (AGENTS.md § "A Hand-Maintained List That Mirrors
// Code Will Be Wrong"): a third plugin that starts returning a file block must
// carry the copy and ask it, or this guard goes red. Plugins that carry a copy
// are included too, so a copy left behind still has to match.
const PLUGINS = readdirSync(PLUGINS_DIR)
  .filter((entry) => entry.startsWith("pinchy-"))
  .filter((plugin) => existsSync(resolve(PLUGINS_DIR, plugin, "index.ts")))
  .filter(
    (plugin) =>
      existsSync(resolve(PLUGINS_DIR, plugin, "web-chat-run.ts")) ||
      EMITS_FILE_BLOCK.test(readIndex(plugin))
  )
  .sort();

describe("web-chat-run.ts drift guard", () => {
  it("finds every plugin that emits a file block, including ones added later", () => {
    // The floor keeps a broken walk or a broken pattern from passing on an
    // empty corpus. Extend it when a plugin joins; it must never shrink.
    expect(PLUGINS).toEqual(expect.arrayContaining(["pinchy-email", "pinchy-files"]));
  });

  it("the reference copy exports the predicate", () => {
    expect(readCopy(REFERENCE_PLUGIN)).toContain("export function isWebChatRun(");
  });

  it.each(PLUGINS)("%s carries a byte-identical copy", (plugin) => {
    expect(
      existsSync(resolve(PLUGINS_DIR, plugin, "web-chat-run.ts")),
      `${plugin} has no copy`
    ).toBe(true);
    expect(readCopy(plugin)).toBe(readCopy(REFERENCE_PLUGIN));
  });

  it.each(PLUGINS)("%s's copy stays import-free, so it loads standalone", (plugin) => {
    expect(readCopy(plugin)).not.toMatch(
      /^\s*import\s|^\s*export\s[^;]*\sfrom\s|\brequire\(|\bimport\(/m
    );
  });

  it.each(PLUGINS)("%s asks its copy instead of deciding on its own", (plugin) => {
    const index = readIndex(plugin);
    expect(index).toMatch(/from "\.\/web-chat-run(\.js)?"/);
    // Imported is not asked: the import must be called.
    expect(index).toMatch(/\bisWebChatRun\(/);
    expect(index, `${plugin}/index.ts must not declare a second predicate`).not.toMatch(
      /(function|const|let|var)\s+isWebChatRun\b/
    );
    // The channel test lives in the copy; a "webchat" literal here is a
    // private version of it.
    expect(index, `${plugin}/index.ts must not test the channel itself`).not.toMatch(
      /["'`]webchat["'`]/
    );
  });
});
