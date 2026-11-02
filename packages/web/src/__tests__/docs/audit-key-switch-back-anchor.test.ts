import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { AUDIT_KEY_SWITCH_BACK_DOCS_URL } from "@/lib/secret-source";

const repoRoot = resolve(__dirname, "../../../../..");
const pagePath = resolve(repoRoot, "docs/src/content/docs/concepts/audit-trail-verification.mdx");

describe("the audit-key startup notice links to a section that exists", () => {
  it("names a docs page and heading that the docs source carries", () => {
    // The notice is printed on every start while AUDIT_HMAC_SECRET differs from
    // the key file. check:anchors only reads links in the built docs, never a
    // URL inside a server log line, so a renamed heading would leave the notice
    // pointing at nothing without any check going red.
    const url = new URL(AUDIT_KEY_SWITCH_BACK_DOCS_URL);
    expect(url.origin).toBe("https://docs.heypinchy.com");
    expect(url.pathname).toBe("/concepts/audit-trail-verification/");

    const source = readFileSync(pagePath, "utf-8");
    const slugs = source
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

    expect(slugs).toContain(url.hash.slice(1));
  });
});
