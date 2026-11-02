import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { AUDIT_KEY_SWITCH_BACK_DOCS_URL, AUDIT_KEY_SWITCH_DOCS_URL } from "@/lib/secret-source";

const repoRoot = resolve(__dirname, "../../../../..");
const pagePath = resolve(repoRoot, "docs/src/content/docs/concepts/audit-trail-verification.mdx");

function headingSlugs(): string[] {
  return readFileSync(pagePath, "utf-8")
    .split(/\r?\n/)
    .filter((line) => /^#{2,6} /.test(line))
    .map((line) =>
      line
        .replace(/^#{2,6} /, "")
        .toLowerCase()
        .replace(/[^a-z0-9 -]/g, "")
        .trim()
        .replace(/ /g, "-")
    );
}

function expectExistingSection(docsUrl: string) {
  const url = new URL(docsUrl);
  expect(url.origin).toBe("https://docs.heypinchy.com");
  expect(url.pathname).toBe("/concepts/audit-trail-verification/");
  expect(headingSlugs()).toContain(url.hash.slice(1));
}

describe("the audit-key startup notices link to sections that exist", () => {
  it("names a docs page and heading that the docs source carries", () => {
    // The notice is printed on every start while AUDIT_HMAC_SECRET differs from
    // the key file. check:anchors only reads links in the built docs, never a
    // URL inside a server log line, so a renamed heading would leave the notice
    // pointing at nothing without any check going red.
    expectExistingSection(AUDIT_KEY_SWITCH_BACK_DOCS_URL);
  });

  it("points the failed-key-file warning at the switching procedure", () => {
    // Printed when the variable's value could not be written to the key file:
    // the operator needs the one procedure that says what to do before a switch.
    expectExistingSection(AUDIT_KEY_SWITCH_DOCS_URL);
  });
});
