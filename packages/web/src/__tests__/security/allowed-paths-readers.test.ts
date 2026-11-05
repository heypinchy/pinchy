// Every reader of a stored `pinchy-files.allowed_paths` goes through
// `grantedDataPaths` (lib/agent-granted-paths.ts).
//
// Since v0.9.1 every WRITER confines the column to /data, but rows written
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
  "lib/strip-ungrantable-paths.ts":
    "the boot cleanup — it reads the stored list to record what it was before it rewrites it",
  "lib/agents.ts":
    "validates a create request's INPUT with validateAllowedPaths and rejects it — a writer, not a reader of a stored row",
};

const RAW_ACCESS = /\[\s*["']pinchy-files["']\s*\]\s*\??\.\s*allowed_paths/;

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
