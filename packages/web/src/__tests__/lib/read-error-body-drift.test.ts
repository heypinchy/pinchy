/**
 * Drift-guard: the rejection-body reader is duplicated across
 * `packages/plugins/pinchy-transcript/index.ts::readErrorBody` and
 * `packages/plugins/pinchy-audit/index.ts::readErrorBody`.
 *
 * The duplication is intentional: plugins are separate packages with no shared
 * lib between them, so the alternative to copying is a new workspace package
 * in the OpenClaw container's dependency graph. Same trade-off, same remedy as
 * `normalize-docx-table-html-drift.test.ts` — copy, then pin.
 *
 * What drift would cost is #599 spelled twice. That incident's lesson was
 * "when a client gives up on a response, it must say why": the plugin logged
 * `capture rejected (403)` and dropped the message while the body it already
 * held said the domain lock had refused the Host header. Both copies exist to
 * quote that body. A fix applied to one — a truncation bound, an unwrap of a
 * new error shape, a swallowed throw — silently leaves the other reporting the
 * bare status code that sent a debugging session hunting the wrong layer.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const TRANSCRIPT_FILE = resolve(
  import.meta.dirname,
  "../../../../plugins/pinchy-transcript/index.ts"
);
const AUDIT_FILE = resolve(import.meta.dirname, "../../../../plugins/pinchy-audit/index.ts");

function extractFunctionBody(source: string, fnName: string): string {
  const marker = `function ${fnName}(`;
  const fnStart = source.indexOf(marker);
  if (fnStart === -1) {
    throw new Error(`function ${fnName} not found in source`);
  }

  // Walk past the parameter list before looking for the body's brace. Both
  // copies annotate their parameter with an inline object type
  // (`{ text?: () => Promise<string> }`), so "first { after the name" — which
  // is what normalize-docx-table-html-drift.test.ts can afford, its subject
  // taking a plain `string` — lands on that annotation instead. Two identical
  // annotations compare equal, and the guard passes having read no body at
  // all. A canary found that, reading the code did not.
  let i = fnStart + marker.length;
  let parenDepth = 1;
  while (i < source.length && parenDepth > 0) {
    const ch = source[i];
    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth--;
    i++;
  }

  const braceStart = source.indexOf("{", i);
  if (braceStart === -1) {
    throw new Error(`body of ${fnName} not found in source`);
  }

  let depth = 1;
  i = braceStart + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return source.slice(braceStart + 1, i - 1);
}

function extractNumericConstant(source: string, name: string): string {
  const match = new RegExp(`const ${name}\\s*=\\s*([^;]+);`).exec(source);
  if (!match) throw new Error(`const ${name} not found in source`);
  return match[1].trim();
}

function canonicalize(body: string): string {
  return body
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("readErrorBody drift guard", () => {
  const transcriptSource = readFileSync(TRANSCRIPT_FILE, "utf-8");
  const auditSource = readFileSync(AUDIT_FILE, "utf-8");

  it("extracts real function bodies, not the parameter annotation", () => {
    // The comparison below is only worth anything if both sides are bodies.
    // An extractor that slides off one returns a string that still compares
    // equal to the other's — a guard passing on an empty comparison, which is
    // how a coverage gate turns into decoration. Anchor on something only the
    // body contains.
    for (const [label, source] of [
      ["pinchy-transcript", transcriptSource],
      ["pinchy-audit", auditSource],
    ] as const) {
      const body = extractFunctionBody(source, "readErrorBody");
      expect(body, `${label}: extracted no function body`).toContain("MAX_REASON_CHARS");
      expect(body, `${label}: extracted no function body`).toContain("JSON.parse");
    }
  });

  it("transcript and audit implementations have identical normalized function bodies", () => {
    const transcriptBody = canonicalize(extractFunctionBody(transcriptSource, "readErrorBody"));
    const auditBody = canonicalize(extractFunctionBody(auditSource, "readErrorBody"));

    expect(auditBody).toBe(transcriptBody);
  });

  it("both copies truncate at the same bound", () => {
    // The bodies reference MAX_REASON_CHARS by name, so a divergent value is
    // invisible to the body comparison above while still producing two
    // different messages for the same rejection.
    expect(extractNumericConstant(auditSource, "MAX_REASON_CHARS")).toBe(
      extractNumericConstant(transcriptSource, "MAX_REASON_CHARS")
    );
  });
});
