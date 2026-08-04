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
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

import { describe, it, expect } from "vitest";

import { IMAP_ONLY_SPEC_FILES, IMAP_ONLY_SPEC_MATCH } from "../../../e2e/email/imap-spec-patterns";
import emailConfig from "../../../playwright.email.config";
import imapConfig from "../../../playwright.imap.config";

const WEB_ROOT = join(__dirname, "../../..");
const E2E_EMAIL_DIR = join(WEB_ROOT, "e2e/email");
const SHARED_MODULE = "./e2e/email/imap-spec-patterns";
const SHARED_MODULE_PATTERN = SHARED_MODULE.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const EMAIL_CONFIG_FILE = "playwright.email.config.ts";
const IMAP_CONFIG_FILE = "playwright.imap.config.ts";

function configSource(file: string): string {
  return readFileSync(join(WEB_ROOT, file), "utf8");
}

/**
 * Does `file` import `binding` from the shared partition module?
 *
 * Anchored at the start of a line, so a mention inside a comment cannot satisfy
 * it — both configs name these constants in their prose, and a check that
 * counted that would pass on a config that had been reverted to a literal.
 */
function importsFromSharedModule(file: string, binding: string): boolean {
  const importLine = new RegExp(
    String.raw`^import\s*\{[^}]*\b${binding}\b[^}]*\}\s*from\s*["']${SHARED_MODULE_PATTERN}["'];?$`,
    "m"
  );
  return importLine.test(configSource(file));
}

/** The value of `option` exactly as written in the config source. */
function optionExpression(file: string, option: "testIgnore" | "testMatch"): string {
  const src = configSource(file);
  const declaration = new RegExp(String.raw`^\s*${option}:\s*(.+?),?\s*$`, "m").exec(src);
  expect(
    declaration,
    `${file} must declare ${option} on one line so this guard can read how it is written`
  ).not.toBeNull();
  return declaration![1];
}

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

  it("reads the partition from the shared e2e/email/imap-spec-patterns module, not two hand-maintained lists", () => {
    // The checks above prove the configs AGREE. This one proves *why* they
    // agree: both derive testIgnore/testMatch from the same constants rather
    // than two lists that happen to match today. Without it, a revert to a
    // literal duplicate would pass every check above and silently reintroduce
    // the mirror AGENTS.md's "A Hand-Maintained List That Mirrors Code Will Be
    // Wrong" warns about.
    //
    // Provenance is only visible in the source text: two lists that agree
    // produce byte-identical runtime values, so comparing the loaded config
    // against the shared constants cannot tell a wired config from a copy of
    // it. Verified by reproduction — revert both configs to literals and this
    // test must go red while the other three stay green.
    expect(
      importsFromSharedModule(EMAIL_CONFIG_FILE, "IMAP_ONLY_SPEC_FILES"),
      `${EMAIL_CONFIG_FILE} must import IMAP_ONLY_SPEC_FILES from "${SHARED_MODULE}" instead of spelling the list out again`
    ).toBe(true);
    expect(
      optionExpression(EMAIL_CONFIG_FILE, "testIgnore"),
      `${EMAIL_CONFIG_FILE}'s testIgnore must be derived from IMAP_ONLY_SPEC_FILES, not a literal array`
    ).toContain("IMAP_ONLY_SPEC_FILES");

    expect(
      importsFromSharedModule(IMAP_CONFIG_FILE, "IMAP_ONLY_SPEC_MATCH"),
      `${IMAP_CONFIG_FILE} must import IMAP_ONLY_SPEC_MATCH from "${SHARED_MODULE}" instead of spelling the pattern out again`
    ).toBe(true);
    expect(
      optionExpression(IMAP_CONFIG_FILE, "testMatch"),
      `${IMAP_CONFIG_FILE}'s testMatch must be derived from IMAP_ONLY_SPEC_MATCH, not a literal RegExp`
    ).toContain("IMAP_ONLY_SPEC_MATCH");

    // And the wiring must not be decorative: a config that imports the shared
    // constants and then overrides them is back to two sources.
    expect(emailIgnoreList()).toEqual([...IMAP_ONLY_SPEC_FILES]);
    expect((imapConfig.testMatch as RegExp).source).toBe(IMAP_ONLY_SPEC_MATCH.source);
  });
});
