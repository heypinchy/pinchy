// Every reader of a stored `pinchy-files.allowed_paths` goes through
// `grantedDataPaths` (lib/agent-granted-paths.ts).
//
// Since v0.9.0 every WRITER confines the column to /data, but rows written
// before then were never rewritten, and the old PATCH let a member point their
// own agent at the workspaces root (#1272). Five readers took the column
// verbatim — the pinchy-files config build, the KB search scope, the
// browser-facing workspace-file route, reindex, and the nightly schedule — so a
// pre-lockdown row kept its grant through the upgrade that was meant to close
// it. Fixing those five does not stop a sixth from reading the column raw
// tomorrow; this guard does.
//
// Comments are stripped before matching, so prose describing the column does
// not count as a read.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(__dirname, "../..");

/**
 * Files allowed to touch the raw column, each with the reason. A stale entry
 * fails the guard too — an exemption must not outlive its file.
 */
const ALLOWED_RAW_ACCESS: Record<string, string> = {
  "lib/agent-granted-paths.ts": "the accessor itself",
  "lib/openclaw-config/validate-built-config.ts":
    "reads allowed_paths of the EMITTED pinchy-files config, which build.ts derived through the accessor",
  "lib/agents.ts":
    "validates a create request's INPUT with validateAllowedPaths and rejects it — a writer, not a reader of a stored row",
  "lib/agent-plugin-config-audit.ts":
    "counts how the STORED list changed for an agent.updated row and grants nothing; dropping a leftover outside /data must show up as removed",
};

/**
 * A read of an `allowed_paths` property: `x.allowed_paths`
 * (not an assignment to it), `x["allowed_paths"]`, or destructuring
 * `{ allowed_paths } =` (renamed or not). Destructuring in a function parameter
 * is not matched: it cannot be told apart from a call passing an object literal.
 * Matched on the property rather than on the
 * `["pinchy-files"]` chain, because build.ts read it in two steps
 * (`const cfg = …["pinchy-files"]; cfg?.allowed_paths`) and a chain match
 * missed exactly that reader.
 */
const RAW_ACCESS =
  /\.\s*allowed_paths\b(?!\s*=[^=])|\[\s*["'`]allowed_paths["'`]\s*\]|\{[^{}]*\ballowed_paths\b[^{}]*\}\s*=/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function readsRaw(rel: string): boolean {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- rel comes from walking src/ or the exemption list above
  return RAW_ACCESS.test(stripComments(readFileSync(join(SRC, rel), "utf8")));
}

function walk(dir: string, out: string[] = []): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- recursive walk of this package's src/
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same walk
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "test-helpers" || name === "node_modules") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe("RAW_ACCESS", () => {
  it.each([
    [
      "the two-step read build.ts used before #1272",
      'const f = a?.["pinchy-files"];\nconst p = f?.allowed_paths ?? [];',
    ],
    ["the one-line chain", 'a.pluginConfig?.["pinchy-files"]?.allowed_paths ?? []'],
    ["a non-null assertion", 'cfg["pinchy-files"]!.allowed_paths'],
    ["bracket access", 'cfg["pinchy-files"]?.["allowed_paths"]'],
    ["destructuring", 'const { allowed_paths } = cfg["pinchy-files"];'],
    ["destructuring with a rename", 'const { allowed_paths: paths } = cfg["pinchy-files"] ?? {};'],
  ])("sees %s", (_label, source) => {
    expect(RAW_ACCESS.test(source)).toBe(true);
  });

  it.each([
    ["an assignment to the emitted config", "agentFilesConfig.allowed_paths = [...paths];"],
    ["an object literal a writer builds", '{ "pinchy-files": { allowed_paths: selectedPaths } }'],
  ])("ignores %s", (_label, source) => {
    expect(RAW_ACCESS.test(source)).toBe(false);
  });
});

describe("stored allowed_paths readers", () => {
  const files = walk(SRC);

  it("finds a real corpus", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it("reads the column only through grantedDataPaths", () => {
    const offenders = files
      .map((f) => relative(SRC, f))
      .filter((rel) => !(rel in ALLOWED_RAW_ACCESS))
      .filter(readsRaw);
    expect(
      offenders,
      'Read pinchy-files.allowed_paths through grantedDataPaths() from "@/lib/agent-granted-paths" — a pre-lockdown row can still carry folders outside /data (#1272).'
    ).toEqual([]);
  });

  it("has no stale exemption", () => {
    for (const rel of Object.keys(ALLOWED_RAW_ACCESS)) {
      expect(readsRaw(rel), `${rel} no longer reads the column; drop its exemption`).toBe(true);
    }
  });
});
