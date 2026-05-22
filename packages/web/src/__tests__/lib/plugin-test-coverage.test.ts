// Enforcement guard: every *.test.ts under packages/plugins/pinchy-* must
// be matched by the `include` patterns in packages/web/vitest.config.ts.
// Without this, new plugin tests silently fall outside CI (the root
// `pnpm test` script is `pnpm --filter @pinchy/web test`, so plugin
// packages' own `vitest run` scripts are never invoked in CI on their
// own — they only run by virtue of being picked up here).
//
// See AGENTS.md § "Plugin Integration Contract" for the broader
// plugin-coverage contract.
import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import vitestConfig from "../../../vitest.config";

const WEB_ROOT = resolve(__dirname, "../../..");
const PLUGINS_ROOT = resolve(WEB_ROOT, "../plugins");

function walkTestFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      result.push(...walkTestFiles(fullPath));
    } else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry)) {
      result.push(fullPath);
    }
  }
  return result;
}

/**
 * Match a path against a vitest-style glob. We support exactly the subset
 * of globs the config actually uses:
 *
 *   - `**` matches any number of path segments (including zero)
 *   - `*` matches any character except `/`
 *   - `{a,b,c}` is brace alternation (no nesting)
 *   - `?(...)` is an optional group of alternatives (extglob)
 *   - `.` matches a literal dot
 *
 * This is intentionally narrower than a full picomatch — we don't want
 * to add a runtime dep for one test, and the include patterns are
 * fully under our control.
 */
function globToRegex(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**` — match across path separators
        re += ".*";
        i += 2;
        // Eat a trailing `/` if there is one (so `**/foo` matches `foo`)
        if (glob[i] === "/") i++;
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      if (glob[i + 1] === "(") {
        // extglob: ?(a|b|c) → optional alternation
        const close = glob.indexOf(")", i + 2);
        if (close === -1) throw new Error(`Unclosed ?( in glob: ${glob}`);
        const inside = glob.slice(i + 2, close);
        const alternates = inside.split("|").map((s) => s.replace(/\./g, "\\."));
        re += `(?:${alternates.join("|")})?`;
        i = close + 1;
      } else {
        re += "[^/]";
        i++;
      }
    } else if (ch === "{") {
      const close = glob.indexOf("}", i + 1);
      if (close === -1) throw new Error(`Unclosed { in glob: ${glob}`);
      const inside = glob.slice(i + 1, close);
      const alternates = inside.split(",").map((s) => s.replace(/\./g, "\\."));
      re += `(?:${alternates.join("|")})`;
      i = close + 1;
    } else if (ch === ".") {
      re += "\\.";
      i++;
    } else if ("/+^$()|".includes(ch)) {
      re += `\\${ch}`;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

describe("plugin-test-coverage", () => {
  it("every *.test.ts under packages/plugins/pinchy-* is matched by vitest.config.ts include patterns", () => {
    // Source the include globs from the resolved config object instead of
    // parsing the file — that way comments, multi-line strings, and any
    // future refactor of the config file shape stay invisible to us.
    const includeGlobs: string[] =
      (vitestConfig as { test?: { include?: string[] } }).test?.include ?? [];

    // We only care about the plugin-targeted globs — `src/**/*.test.ts`
    // can never match a plugin test, and including it would only make the
    // error message noisier on failure.
    const pluginGlobs = includeGlobs.filter((g) => g.includes("plugins"));
    expect(
      pluginGlobs.length,
      `no plugin globs found in vitest.config.ts include list (raw globs: ${JSON.stringify(includeGlobs)})`
    ).toBeGreaterThan(0);

    const matchers = pluginGlobs.map((g) => {
      // Globs are written relative to packages/web; resolve them to
      // absolute paths so we can compare against the absolute file paths
      // returned by walkTestFiles.
      const absoluteGlob = resolve(WEB_ROOT, g);
      return globToRegex(absoluteGlob);
    });

    const pluginTests = walkTestFiles(PLUGINS_ROOT);
    const orphaned: string[] = [];
    for (const file of pluginTests) {
      if (!matchers.some((re) => re.test(file))) {
        orphaned.push(relative(WEB_ROOT, file));
      }
    }

    expect(
      orphaned,
      [
        "The following plugin test files are NOT covered by any include glob",
        "in packages/web/vitest.config.ts, which means they don't run in CI:",
        "",
        ...orphaned.map((f) => `  ${f}`),
        "",
        "Either widen the include glob, or remove the test file.",
      ].join("\n")
    ).toEqual([]);
  });
});
