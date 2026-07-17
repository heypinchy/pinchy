// Drift guard: `e2e/email` is ONE directory served by TWO Playwright configs.
//
// - playwright.email.config.ts runs the OAuth-provider specs, on a stack with no
//   mailbox. It claims the directory by DENYLIST (`testIgnore`), so a new spec
//   runs there by default.
// - playwright.imap.config.ts runs the specs that need the GreenMail + imap-mock
//   stack. It claims them by ALLOWLIST (`testMatch`).
//
// The two must partition the directory exactly, and both drift directions hurt:
//
// - Ignored by email but NOT claimed by imap: the spec runs nowhere. Green CI,
//   zero protection — the failure mode the no-untracked-skips and
//   no-test-deletion guards exist to stop, reached from a third direction.
// - Claimed by imap but NOT ignored by email: it runs twice, and the imap-less
//   job fails with "IMAP mock not ready".
//
// Nothing else checks this: each config is individually valid whatever the other
// says, and CI runs them in separate jobs that never compare notes. A brand-new
// spec that neither mentions is fine by construction — the denylist runs it.
import { readdirSync } from "fs";
import { join } from "path";

import { describe, it, expect } from "vitest";

import emailConfig from "../../../playwright.email.config";
import imapConfig from "../../../playwright.imap.config";

const E2E_EMAIL_DIR = join(__dirname, "../../../e2e/email");

function specFiles(): string[] {
  return readdirSync(E2E_EMAIL_DIR)
    .filter((f) => f.endsWith(".spec.ts"))
    .sort();
}

/** The denylist as written in playwright.email.config.ts. */
function emailIgnoreList(): string[] {
  const ignore = emailConfig.testIgnore;
  // Keep the guard honest about the shape it reads: a config that switched to a
  // RegExp or a glob would sail past a naive `[].includes` check.
  expect(
    Array.isArray(ignore),
    "playwright.email.config.ts testIgnore must stay a string array"
  ).toBe(true);
  return (ignore as string[]).map(String);
}

/** Does playwright.imap.config.ts's allowlist claim this spec? */
function imapClaims(spec: string): boolean {
  const match = imapConfig.testMatch;
  expect(match instanceof RegExp, "playwright.imap.config.ts testMatch must stay a RegExp").toBe(
    true
  );
  return (match as RegExp).test(spec);
}

describe("e2e/email is partitioned between the two Playwright configs", () => {
  it("finds the specs it is guarding", () => {
    // A guard that silently reads an empty directory proves nothing forever.
    expect(specFiles().length).toBeGreaterThan(0);
  });

  it("runs every spec in exactly one config", () => {
    const assignments = specFiles().map((spec) => {
      const claimedByImap = imapClaims(spec);
      const ignoredByEmail = emailIgnoreList().includes(spec);
      return {
        spec,
        // The email config is a denylist: it runs whatever it does not ignore.
        runsUnderEmail: !ignoredByEmail,
        runsUnderImap: claimedByImap,
      };
    });

    for (const a of assignments) {
      const configs = [a.runsUnderEmail && "email", a.runsUnderImap && "imap"].filter(Boolean);
      expect(
        configs,
        `${a.spec} must run under exactly one config, but runs under ${configs.length === 0 ? "neither" : configs.join(" AND ")}. ` +
          `Add it to playwright.imap.config.ts's testMatch AND playwright.email.config.ts's testIgnore (it needs the GreenMail stack), or to neither (it does not).`
      ).toHaveLength(1);
    }
  });

  it("ignores nothing in the email config that the imap config does not claim", () => {
    // The other drift direction: an entry left in testIgnore after its spec was
    // renamed or deleted means the email config is quietly skipping a spec that
    // no job picks up.
    for (const ignored of emailIgnoreList()) {
      expect(
        specFiles(),
        `playwright.email.config.ts ignores "${ignored}", which no longer exists in e2e/email`
      ).toContain(ignored);
      expect(
        imapClaims(ignored),
        `playwright.email.config.ts ignores "${ignored}", but playwright.imap.config.ts does not claim it — no job runs this spec`
      ).toBe(true);
    }
  });
});
