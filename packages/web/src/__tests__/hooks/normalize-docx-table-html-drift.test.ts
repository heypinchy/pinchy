/**
 * Drift-guard: the table-HTML normalizer is duplicated across the plugin
 * (`packages/plugins/pinchy-files/docx-extract.ts::normalizeTableHtml`) and
 * the web composer (`packages/web/src/hooks/use-ws-runtime.ts::normalizeDocxTableHtml`).
 *
 * The duplication is intentional (bundle isolation in the web path uses
 * dynamic imports; a shared package would complicate that). Behavioral
 * drift between the two would silently make KB reads and composer uploads
 * emit different Markdown for the same DOCX table — which is exactly the
 * class of bug a paired-lists drift-guard test exists to catch.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PLUGIN_FILE = resolve(
  import.meta.dirname,
  "../../../../plugins/pinchy-files/docx-extract.ts"
);
const WEB_FILE = resolve(import.meta.dirname, "../../hooks/use-ws-runtime.ts");

function extractFunctionBody(source: string, fnName: string): string {
  const marker = `function ${fnName}(`;
  const fnStart = source.indexOf(marker);
  if (fnStart === -1) {
    throw new Error(`function ${fnName} not found in source`);
  }
  const braceStart = source.indexOf("{", fnStart);
  let depth = 1;
  let i = braceStart + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return source.slice(braceStart + 1, i - 1);
}

function canonicalize(body: string): string {
  return body
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("normalize*TableHtml drift guard", () => {
  it("plugin and web implementations have identical normalized function bodies", () => {
    const pluginSource = readFileSync(PLUGIN_FILE, "utf-8");
    const webSource = readFileSync(WEB_FILE, "utf-8");

    const pluginBody = canonicalize(extractFunctionBody(pluginSource, "normalizeTableHtml"));
    const webBody = canonicalize(extractFunctionBody(webSource, "normalizeDocxTableHtml"));

    expect(webBody).toBe(pluginBody);
  });
});
