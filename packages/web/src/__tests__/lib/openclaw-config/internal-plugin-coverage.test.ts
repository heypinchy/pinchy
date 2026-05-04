import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { INTERNAL_PLUGINS } from "@/lib/openclaw-config/plugin-manifest-loader";

const REPO_ROOT = resolve(__dirname, "../../../../../..");

function readAllSpecs(dir: string): string {
  let out = "";
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out += readAllSpecs(full);
    else if (entry.endsWith(".spec.ts")) out += readFileSync(full, "utf8");
  }
  return out;
}

const ALL_E2E = readAllSpecs(resolve(REPO_ROOT, "packages/web/e2e"));

describe("internal plugins are exercised by E2E specs", () => {
  it.each(INTERNAL_PLUGINS)("%s is mentioned in at least one e2e spec", (plugin) => {
    // Heuristic: the plugin id (or a tool name unique to it) appears
    // somewhere in the e2e directory. This is a smoke check: it does
    // NOT prove the plugin's tools execute correctly, only that
    // someone built coverage. Quality is enforced by code review.
    expect(ALL_E2E).toMatch(new RegExp(plugin.replace("-", "[-_]")));
  });
});
