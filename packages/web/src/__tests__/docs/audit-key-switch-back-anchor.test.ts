import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  AUDIT_KEY_SWITCH_BACK_DOCS_URL,
  AUDIT_KEY_SWITCH_DOCS_URL,
  describeAuditKeyFilePersist,
  describeIgnoredSecretEnv,
  ENCRYPTION_KEY_IGNORED_DOCS_URL,
  evaluateAuditSecretRotation,
} from "@/lib/secret-source";

const repoRoot = resolve(__dirname, "../../../../..");
const docsRoot = resolve(repoRoot, "docs/src/content/docs");
const pagePath = resolve(docsRoot, "concepts/audit-trail-verification.mdx");
const envVarsPagePath = resolve(docsRoot, "reference/environment-variables.mdx");

function headingSlugs(path: string): string[] {
  return readFileSync(path, "utf-8")
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

function expectExistingSection(
  docsUrl: string,
  page: { pathname: string; path: string } = {
    pathname: "/concepts/audit-trail-verification/",
    path: pagePath,
  }
) {
  const url = new URL(docsUrl);
  expect(url.origin).toBe("https://docs.heypinchy.com");
  expect(url.pathname).toBe(page.pathname);
  expect(headingSlugs(page.path)).toContain(url.hash.slice(1));
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

  it("points the ignored-ENCRYPTION_KEY warning at the safe steps", () => {
    // Printed on every start while ENCRYPTION_KEY is malformed. The obvious
    // "fix" makes every stored credential unreadable, so the section it links
    // to is the only place the safe steps are spelled out.
    expectExistingSection(ENCRYPTION_KEY_IGNORED_DOCS_URL, {
      pathname: "/reference/environment-variables/",
      path: envVarsPagePath,
    });
  });
});

describe("the retire-the-earlier-key steps quote log lines Pinchy prints", () => {
  // Step 3 makes removing the key file conditional on what the log says. If
  // a message is reworded and the docs are not, an operator looks for a line
  // that never appears and either stops for nothing or, worse, reads its
  // absence the wrong way. Pin each quoted line to the code that prints it.
  const page = readFileSync(pagePath, "utf-8");
  const quoted = (line: string) => expect(page).toContain(`\`${line}\``);

  it("the key-switch notice", () => {
    const line = "AUDIT_HMAC_SECRET is set and differs from the audit signing key";
    quoted(line);
    expect(evaluateAuditSecretRotation({ hasSupersededSecret: true }).message).toContain(line);
  });

  it("the ignored-variable warning", () => {
    const line = "AUDIT_HMAC_SECRET is set but is not a valid key";
    quoted(line);
    expect(
      describeIgnoredSecretEnv({ envVar: "AUDIT_HMAC_SECRET", ignored: true }).message
    ).toContain(line);
  });

  it("the ignored-ENCRYPTION_KEY warning, on the environment variables page", () => {
    const line = "ENCRYPTION_KEY is set but is not a valid key";
    expect(readFileSync(envVarsPagePath, "utf-8")).toContain(`\`${line}\``);
    expect(describeIgnoredSecretEnv({ envVar: "ENCRYPTION_KEY", ignored: true }).message).toContain(
      line
    );
  });

  it("the key-file write", () => {
    const line = "Wrote the AUDIT_HMAC_SECRET value to .audit_hmac_secret";
    quoted(line);
    expect(
      describeAuditKeyFilePersist({ status: "written", dir: "/app/secrets" }).message
    ).toContain(line);
  });
});
