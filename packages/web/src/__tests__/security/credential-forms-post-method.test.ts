import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Tripwire (text-scan) security test: every native <form> in production
 * source must declare method="post".
 *
 * Root cause this guards against: Pinchy's forms are React client
 * components using react-hook-form (`<form onSubmit={form.handleSubmit(onSubmit)}>`).
 * react-hook-form's handler only calls preventDefault() once JS has
 * hydrated. Without an explicit `method` attribute, a *native*
 * pre-hydration submit (slow hydration, hydration failure, no-JS) defaults
 * to GET and serializes named inputs — including passwords and API keys —
 * into the URL, browser history, server access logs, and Referer headers.
 * This was reproduced live: submitting the login form pre-hydration put
 * `?email=...&password=...` in the address bar.
 * `method="post"` makes a native pre-hydration submit a POST (secret stays
 * in the request body) without changing the normal hydrated flow, where
 * react-hook-form still preventDefault()s and drives submission through the
 * API client.
 *
 * Why this is a universal invariant rather than an allowlist of
 * "credential-carrying" files: deciding statically whether a given <form>
 * carries a secret is not reliable (a follow-up review found the identical
 * leak, unfixed, in provider-key-form.tsx — a file that simply wasn't on
 * the original hand-maintained list). "Does this form have method=post?"
 * is trivial to check and impossible to get wrong. method="post" is
 * harmless for non-credential forms too — chat text, invite emails, and
 * agent names don't belong in a URL/history/access-log/Referer either — so
 * there is no reason to special-case any form out of this guard. This scans
 * every production .tsx file under src/ for every <form> and asserts
 * method="post", which means every future form is safe by default with no
 * list to remember to update.
 *
 * Regex limitation (intentionally fail-safe, never fail-open): the
 * FORM_OPEN_TAG_RE below stops at the first literal `>`. An inline arrow
 * function inside the tag's attributes (e.g. `onSubmit={(e) => ...}`) would
 * truncate the match before `method="post"` is reached, which makes the
 * assertion fail (a false positive on a compliant form), never pass a
 * non-compliant one (a false negative). If a legitimate tag ever trips this,
 * fix the tag's formatting (e.g. extract the handler to a named function)
 * rather than loosening the regex.
 */

const webSrcDir = path.resolve(__dirname, "../..");

// Matches a full opening <form ...> tag, allowing attributes/newlines
// between "<form" and the closing ">". No /s: it only ever affects ".", which
// this pattern doesn't use, and [^>] spans newlines on its own. The flag was
// inert, and it needs target >= ES2018 (tsconfig targets ES2017).
const FORM_OPEN_TAG_RE = /<form\b[^>]*>/g;

const EXCLUDED_DIR_NAMES = new Set(["__tests__", "node_modules"]);

function isTestFile(fileName: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(fileName);
}

function findProductionTsxFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIR_NAMES.has(entry)) continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...findProductionTsxFiles(full));
    } else if (entry.endsWith(".tsx") && !isTestFile(entry)) {
      results.push(full);
    }
  }
  return results;
}

describe('Every <form> in production source uses method="post"', () => {
  const files = findProductionTsxFiles(webSrcDir);

  it("should find production .tsx files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  const filesWithForms = files
    .map((file) => {
      const source = readFileSync(file, "utf8");
      const formTags = source.match(FORM_OPEN_TAG_RE) ?? [];
      return { file, relativePath: path.relative(webSrcDir, file), formTags };
    })
    .filter(({ formTags }) => formTags.length > 0);

  it("should find at least one <form> in production source", () => {
    expect(filesWithForms.length).toBeGreaterThan(0);
  });

  for (const { relativePath, formTags } of filesWithForms) {
    it(`every <form> in ${relativePath} has method="post"`, () => {
      for (const tag of formTags) {
        expect(tag, `<form> in ${relativePath} is missing method="post": ${tag}`).toMatch(
          /method="post"/
        );
      }
    });
  }
});
