/**
 * `WEB_SEARCH_TOOLS` must name exactly the tools `build.ts` emits the
 * web-search connection for (#987).
 *
 * These two lists are a pair, and until this guard only one of them was
 * enforced by anything. `openclaw-config/build.ts` writes the instance-wide
 * web-search `connectionId` into an agent's `pinchy-web` config when the agent
 * holds `pinchy_web_search` or `pinchy_web_fetch`; the credentials route then
 * re-asks that same tool-list question before it decrypts the Brave key,
 * because this connection has no `agent_connection_permissions` rows to count.
 *
 * Drift in either direction is silent and lands in production:
 *
 *   - A third web tool added to the emission side alone gives that agent's
 *     plugin a connectionId whose credentials the server refuses. It surfaces
 *     as "web search stopped working", with an `integration.credentials_denied`
 *     row claiming the agent was never granted a connection the config just
 *     handed it.
 *   - A tool listed here that build.ts does not emit for is the opposite
 *     mistake: an agent allowed to read the Brave API key on the strength of a
 *     tool that was never wired to that connection.
 *
 * Same contract as the other paired-list guards in this repo (see AGENTS.md
 * § "Tool dispatch coverage"): the pairing is the invariant, and the extractor
 * throws rather than returning a short list, because a walker that quietly
 * finds nothing turns this file into decoration.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { WEB_SEARCH_TOOLS } from "@/lib/integrations/authorize-agent-connection";

const BUILD_TS = resolve(__dirname, "../../../lib/openclaw-config/build.ts");

const BLOCK_START = "// Collect web search configs";
const BLOCK_END = 'entries["pinchy-web"]';

/**
 * The tools `build.ts` gates the web-search plugin entry on, read out of the
 * source rather than re-declared here — a copy would drift exactly like the
 * pair it is meant to pin.
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
  return tools;
}

describe("web-search tool list drift (#987)", () => {
  it("reads a real emission block out of build.ts", () => {
    // The corpus probe. Without it a regex that silently matches nothing would
    // make every assertion below vacuously true.
    const tools = extractEmissionTools();

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool).toMatch(/^pinchy_web_/);
    }
  });

  it("authorizes exactly the tools build.ts emits the connection for", () => {
    const emitted = [...new Set(extractEmissionTools())].sort();
    const authorized = [...WEB_SEARCH_TOOLS].sort();

    expect(
      authorized,
      [
        `WEB_SEARCH_TOOLS and build.ts's web-search gate have drifted.`,
        `  build.ts emits the connection for: [${emitted.join(", ")}]`,
        `  WEB_SEARCH_TOOLS authorizes:        [${authorized.join(", ")}]`,
        `A tool on the emission side alone gets a connectionId whose credentials`,
        `the route then refuses (403 + integration.credentials_denied). A tool`,
        `here alone grants the Brave key on a tool that was never wired to it.`,
      ].join("\n")
    ).toEqual(emitted);
  });
});
