/**
 * Drift-guard: the linear HTML tag remover is duplicated on purpose in
 * `packages/web/src/lib/knowledge/msg-extract.ts` and
 * `packages/plugins/pinchy-email/email-adapter.ts` (a plugin and the web app
 * cannot share a module). A fix to one copy (e.g. the quadratic-scan and
 * U+0130 fixes) must reach the other, so the bodies are pinned together
 * modulo whitespace and comments, as for `normalizeTableHtml`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WEB_FILE = resolve(import.meta.dirname, "../../lib/knowledge/msg-extract.ts");
const PLUGIN_FILE = resolve(
  import.meta.dirname,
  "../../../../plugins/pinchy-email/email-adapter.ts"
);

function extractFunctionBody(source: string, fnName: string): string {
  const fnStart = source.indexOf(`function ${fnName}(`);
  if (fnStart === -1) throw new Error(`function ${fnName} not found in source`);
  // Skip the parameter list and return type: the body starts at the first `{`
  // after the signature's closing `)`.
  const braceStart = source.indexOf("{", source.indexOf(")", fnStart));
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

function extractConst(source: string, name: string): string {
  const start = source.indexOf(`const ${name}`);
  if (start === -1) throw new Error(`const ${name} not found in source`);
  return source.slice(start, source.indexOf(";", start) + 1);
}

function canonicalize(code: string): string {
  return code
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("removeTags drift guard", () => {
  const web = readFileSync(WEB_FILE, "utf-8");
  const plugin = readFileSync(PLUGIN_FILE, "utf-8");

  it("web and plugin removeTags bodies are identical", () => {
    const webBody = canonicalize(extractFunctionBody(web, "removeTags"));
    expect(webBody.length).toBeGreaterThan(200);
    expect(canonicalize(extractFunctionBody(plugin, "removeTags"))).toBe(webBody);
  });

  it("web and plugin block-tag regexes are identical", () => {
    const webRe = canonicalize(extractConst(web, "HTML_BLOCK_TAG_RE"));
    expect(webRe).toContain("blockquote");
    expect(canonicalize(extractConst(plugin, "HTML_BLOCK_TAG_RE"))).toBe(webRe);
  });
});
