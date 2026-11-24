// @vitest-environment node
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CONVERSATION_HOOK_PLUGINS } from "@/lib/openclaw-config/build";
import { loadOpenClawDistExport } from "../helpers/openclaw-dist";

/**
 * A Pinchy plugin that registers a conversation hook (before_prompt_build,
 * before_agent_run, …) needs `hooks.allowConversationAccess` on its
 * openclaw.json entry. Pinchy's plugins load from ~/.openclaw/extensions, so
 * OpenClaw treats them as non-bundled and drops such a hook at registration
 * with nothing but a warn diagnostic — the plugin still loads, its tools still
 * work, and the hook simply never runs. That is how pinchy-knowledge's
 * question-language note (#1299) and pinchy-files' memory block went missing.
 *
 * The question "is this a conversation hook" is OpenClaw's, so it is asked of
 * the installed OpenClaw, not of a copied list.
 */

const PLUGINS_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "plugins");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((p) => /\.ts$/.test(p))
    .filter((p) => !/(^|\/)(node_modules|__tests__)\//.test(p) && !/\.test\.ts$/.test(p))
    .map((p) => join(dir, p));
}

/** Plugin id → hook names its production code registers with `api.on`. */
function registeredHooks(): Map<string, Set<string>> {
  const byPlugin = new Map<string, Set<string>>();
  for (const dir of readdirSync(PLUGINS_ROOT)) {
    const manifest = join(PLUGINS_ROOT, dir, "openclaw.plugin.json");
    if (!existsSync(manifest)) continue;
    const id = (JSON.parse(readFileSync(manifest, "utf8")) as { id: string }).id;
    const hooks = new Set<string>();
    for (const file of sourceFiles(join(PLUGINS_ROOT, dir))) {
      for (const m of readFileSync(file, "utf8").matchAll(
        /\bapi\.on(?:\?\.)?\(\s*["']([a-z_]+)["']/g
      )) {
        hooks.add(m[1]);
      }
    }
    byPlugin.set(id, hooks);
  }
  return byPlugin;
}

describe("conversation hook access", () => {
  it("grants it to exactly the plugins that register a conversation hook", async () => {
    const isConversationHookName = (await loadOpenClawDistExport(
      /^hook-runner-global-/,
      "isConversationHookName"
    )) as (name: string) => boolean;

    const hooks = registeredHooks();
    // Every assertion below compares against this scan; an empty one would
    // agree with an empty list.
    expect(hooks.size).toBeGreaterThan(5);
    expect([...hooks.values()].some((names) => names.size > 0)).toBe(true);

    const needing = [...hooks]
      .filter(([, names]) => [...names].some(isConversationHookName))
      .map(([id]) => id)
      .sort();
    expect([...CONVERSATION_HOOK_PLUGINS].sort()).toEqual(needing);
  });
});
