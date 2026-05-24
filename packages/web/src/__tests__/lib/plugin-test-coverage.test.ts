// This file contains TWO describes despite the singular file name:
//
//   1. `globToRegex (escape safety)` — unit tests for the small glob→regex
//      helper defined below. Co-located here because the helper is the
//      ONLY consumer of `escapeRegex` and is not exported beyond this
//      file. Extracting it to a separate module would be over-engineering
//      for a single internal use; the tests would just import it back.
//   2. `plugin-test-coverage` — the actual enforcement guard: every
//      *.test.ts under packages/plugins/pinchy-* must be matched by the
//      `include` patterns in packages/web/vitest.config.ts. The helper
//      from (1) is what powers the matching.
//
// If `globToRegex` ever grows a second caller, extract it (and these
// tests) to `glob-to-regex.ts` + `glob-to-regex.test.ts` and update the
// import in (2).
//
// Why the enforcement guard matters: without it, new plugin tests
// silently fall outside CI. The root `pnpm test` script is
// `pnpm --filter @pinchy/web test`, so plugin packages' own `vitest run`
// scripts are never invoked in CI on their own — they only run by virtue
// of being picked up by the include glob. See AGENTS.md § "Plugin
// Integration Contract" for the broader plugin-coverage contract.
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
 * Escape every regex metacharacter in a literal string so it matches itself
 * when interpolated into a RegExp. Used for the alternates inside `{a,b}`
 * and `?(a|b)` groups, which are otherwise treated as literal path text.
 */
function escapeRegex(s: string): string {
  return s.replace(/[\\.*+?^${}()|[\]]/g, "\\$&");
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
        const alternates = inside.split("|").map(escapeRegex);
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
      const alternates = inside.split(",").map(escapeRegex);
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

describe("globToRegex (escape safety)", () => {
  // CodeQL alerts 141/142 flagged the previous implementation, which only
  // escaped `.` inside `{a,b}` / `?(a|b)` alternates. These tests pin the
  // current behaviour: every regex metacharacter is escaped, so a literal
  // metachar in a glob alternate matches itself rather than being
  // (silently) interpreted as a regex token.
  //
  // Our config-supplied globs never contain these characters today, but
  // the function should be safe in general.

  it("matches a literal extension via brace alternation", () => {
    const re = globToRegex("foo.{ts,tsx}");
    expect(re.test("foo.ts")).toBe(true);
    expect(re.test("foo.tsx")).toBe(true);
    expect(re.test("fooXts")).toBe(false); // `.` must not act as any-char
  });

  it("matches a literal extension via extglob optional alternation", () => {
    const re = globToRegex("foo.?(c|m)js");
    expect(re.test("foo.js")).toBe(true);
    expect(re.test("foo.cjs")).toBe(true);
    expect(re.test("foo.mjs")).toBe(true);
    expect(re.test("foo.xjs")).toBe(false);
  });

  it("escapes backslash in brace alternates (CodeQL fix)", () => {
    // A literal `\` in an alternate must match itself, NOT be treated as
    // a regex escape. (Practical inputs don't have this; safety check.)
    const re = globToRegex("{a\\b,c}");
    expect(re.test("a\\b")).toBe(true);
    expect(re.test("ab")).toBe(false);
    expect(re.test("c")).toBe(true);
  });

  it("escapes backslash in extglob alternates (CodeQL fix)", () => {
    const re = globToRegex("?(a\\b|c)x");
    expect(re.test("a\\bx")).toBe(true);
    expect(re.test("abx")).toBe(false);
    expect(re.test("cx")).toBe(true);
  });

  it("escapes other regex metacharacters in alternates", () => {
    // Each metachar should match itself, not act as a regex operator.
    // We exclude `{`, `}`, `[`, `]`, `|`, `,` because those are structural
    // in globs (they delimit alternates) and never make it INTO an
    // alternate's text in the first place.
    for (const meta of ["+", "*", "?", "^", "$", "(", ")"]) {
      const re = globToRegex(`{a${meta}b,c}`);
      expect(re.test(`a${meta}b`), `metachar "${meta}" should match literally`).toBe(true);
      // Adversarial: the metachar must NOT produce a regex match that the
      // literal text wouldn't (e.g. `+` mustn't make `b` repeat).
      if (meta === "+" || meta === "*") {
        expect(re.test("abb"), `metachar "${meta}" must not enable repetition`).toBe(false);
      }
    }
  });

  it("matches the standard vitest include glob shapes against absolute paths", () => {
    const re = globToRegex("/abs/src/**/*.{test,spec}.?(c|m)[jt]s?(x)");
    expect(re.test("/abs/src/foo.test.ts")).toBe(true);
    expect(re.test("/abs/src/a/b/foo.spec.tsx")).toBe(true);
    expect(re.test("/abs/src/foo.test.cjs")).toBe(true);
    expect(re.test("/abs/src/foo.spec.mjsx")).toBe(true);
    expect(re.test("/abs/src/foo.test.coffee")).toBe(false);
  });
});

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
