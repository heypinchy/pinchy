/**
 * `WEB_SEARCH_KEY_TOOLS` must name exactly the `pinchy-web` tools that spend
 * the Brave Search API key (#987).
 *
 * The web-search connection is instance-wide: it has no
 * `agent_connection_permissions` rows, so the credentials route decides from
 * the agent's tool list whether it may decrypt the Brave key. The list it asks
 * is `WEB_SEARCH_KEY_TOOLS`. The plugin is the other half of the pair: some of
 * its tools request credentials, some (`pinchy_web_fetch`) never do.
 *
 * Drift in either direction is silent and lands in production:
 *
 *   - A plugin tool that starts requesting the key without being listed here
 *     gets a 403 on its first call, reported as an agent reaching beyond a
 *     grant it visibly has.
 *   - A tool listed here that never requests the key grants the Brave key for
 *     nothing. That was the shape before this guard was re-pinned: the list
 *     mirrored every tool that loads the plugin, so a fetch-only agent could
 *     read a key it has no use for.
 *
 * A second check keeps the emission side honest: every key tool must also be
 * one `build.ts` loads the plugin for, otherwise the grant names a tool no
 * agent can ever be configured with.
 *
 * Same contract as the other paired-list guards in this repo (see agent-rules/plugins.md
 * § "Tool dispatch coverage"): the extractors throw rather than returning a
 * short list, because a walker that quietly finds nothing turns this file into
 * decoration.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { WEB_SEARCH_KEY_TOOLS } from "@/lib/integrations/authorize-agent-connection";

const BUILD_TS = resolve(__dirname, "../../../lib/openclaw-config/build.ts");
const PLUGIN_INDEX = resolve(__dirname, "../../../../../plugins/pinchy-web/index.ts");

const BLOCK_START = "// Collect web search configs";
const BLOCK_END = 'entries["pinchy-web"]';

/** Calls in the plugin that mean "this tool needs the Brave key". */
const KEY_REQUEST = /\b(withAuthRetry|getBraveApiKey|fetchBraveCredentials|requestCredentials)\(/;

/**
 * The tools `build.ts` loads the web plugin for, read out of the source rather
 * than re-declared here — a copy would drift exactly like the pair it pins.
 */
function extractEmissionTools(): string[] {
  const source = readFileSync(BUILD_TS, "utf8");
  const start = source.indexOf(BLOCK_START);
  const end = source.indexOf(BLOCK_END, start);
  if (start === -1 || end === -1) {
    throw new Error(
      `web-search-tools-drift: could not find the web-search emission block in build.ts ` +
        `(looked for ${JSON.stringify(BLOCK_START)} … ${JSON.stringify(BLOCK_END)}). ` +
        `The block moved or was renamed — update this guard, do not delete it.`
    );
  }

  const block = source.slice(start, end);
  const tools = [...block.matchAll(/allowedTools\.includes\("([^"]+)"\)/g)].map((m) => m[1]);
  if (tools.length === 0) {
    throw new Error(
      `web-search-tools-drift: found the emission block but no allowedTools.includes("…") ` +
        `checks inside it. build.ts now spells the gate some other way — read it and update ` +
        `this guard so the pairing is still checked.`
    );
  }
  return [...new Set(tools)];
}

/**
 * Every tool `pinchy-web` registers, and whether its registration block asks
 * for credentials. Split on `api.registerTool(`; each block ends with the
 * `{ name: "…" }` options object that names the tool.
 */
function extractPluginTools(): { name: string; requestsKey: boolean }[] {
  const source = readFileSync(PLUGIN_INDEX, "utf8");
  const blocks = source.split("api.registerTool(").slice(1);
  if (blocks.length === 0) {
    throw new Error(
      `web-search-tools-drift: found no api.registerTool( calls in pinchy-web/index.ts. ` +
        `The plugin registers its tools some other way now — update this guard.`
    );
  }

  return blocks.map((block, i) => {
    const names = [...block.matchAll(/\{\s*name:\s*"([^"]+)"\s*\}/g)].map((m) => m[1]);
    const name = names.at(-1);
    if (!name) {
      throw new Error(
        `web-search-tools-drift: registerTool block #${i + 1} in pinchy-web/index.ts has no ` +
          `{ name: "…" } options object. The registration shape changed — update this guard.`
      );
    }
    return { name, requestsKey: KEY_REQUEST.test(block) };
  });
}

describe("web-search key grant drift (#987)", () => {
  it("reads real tool lists out of build.ts and the pinchy-web plugin", () => {
    // The corpus probes. Without them a regex that silently matches nothing
    // would make every assertion below vacuously true.
    const emitted = extractEmissionTools();
    const plugin = extractPluginTools();

    expect(emitted.length).toBeGreaterThan(0);
    for (const tool of emitted) expect(tool).toMatch(/^pinchy_web_/);

    expect(plugin.map((t) => t.name).sort()).toEqual(["pinchy_web_fetch", "pinchy_web_search"]);
    // At least one tool must request the key, or the KEY_REQUEST pattern has
    // stopped recognising how the plugin asks for it.
    expect(plugin.some((t) => t.requestsKey)).toBe(true);
  });

  it("grants the Brave key to exactly the plugin tools that request it", () => {
    const needKey = extractPluginTools()
      .filter((t) => t.requestsKey)
      .map((t) => t.name)
      .sort();
    const granted = [...WEB_SEARCH_KEY_TOOLS].sort();

    expect(
      granted,
      [
        `WEB_SEARCH_KEY_TOOLS and the pinchy-web tools that request the Brave key have drifted.`,
        `  plugin tools that request the key: [${needKey.join(", ")}]`,
        `  WEB_SEARCH_KEY_TOOLS grants:       [${granted.join(", ")}]`,
        `A tool that requests the key but is not granted gets a 403 + integration.credentials_denied.`,
        `A tool granted here that never requests the key hands out the Brave key for nothing.`,
      ].join("\n")
    ).toEqual(needKey);
  });

  it("does not let pinchy_web_fetch read the key", () => {
    // Pinned by name, not only through the pairing above: fetch needs no key,
    // and a future refactor that has it call withAuthRetry would otherwise move
    // both halves together and widen the grant without anyone deciding to.
    expect(WEB_SEARCH_KEY_TOOLS).not.toContain("pinchy_web_fetch");
  });

  it("only grants the key on tools build.ts loads the plugin for", () => {
    const emitted = extractEmissionTools();

    for (const tool of WEB_SEARCH_KEY_TOOLS) {
      expect(emitted, `${tool} grants the Brave key but build.ts never loads it`).toContain(tool);
    }
  });
});
