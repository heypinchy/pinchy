import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  RENEWAL_WINDOW_DAYS,
  validateContactParity,
  validateSecurityTxt,
} from "./security-txt.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SECURITY_TXT = join(
  repoRoot,
  "docs",
  "public",
  ".well-known",
  "security.txt",
);
const SECURITY_MD = join(repoRoot, "SECURITY.md");

const CANONICAL = "https://docs.heypinchy.com/.well-known/security.txt";
const NOW = new Date("2026-07-30T12:00:00Z");

const daysFromNow = (days) =>
  new Date(NOW.getTime() + days * 86_400_000).toISOString();

const build = (overrides = {}) => {
  const fields = {
    Contact: "mailto:security@heypinchy.com",
    Expires: daysFromNow(180),
    Canonical: CANONICAL,
    ...overrides,
  };
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .flatMap(([key, value]) =>
      (Array.isArray(value) ? value : [value]).map((v) => `${key}: ${v}`),
    )
    .join("\n");
};

const check = (content, canonical = CANONICAL) =>
  validateSecurityTxt(content, { now: NOW, canonical });

test("a well-formed security.txt has no problems", () => {
  assert.deepEqual(check(build()), []);
});

test("comments and blank lines are ignored", () => {
  const content = ["# Pinchy security contact", "", build(), ""].join("\n");
  assert.deepEqual(check(content), []);
});

test("field names are matched case-insensitively", () => {
  const content = [
    `contact: mailto:security@heypinchy.com`,
    `EXPIRES: ${daysFromNow(180)}`,
    `Canonical: ${CANONICAL}`,
  ].join("\n");
  assert.deepEqual(check(content), []);
});

test("a missing Contact field is reported", () => {
  const problems = check(build({ Contact: undefined }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Contact/);
});

test("a missing Expires field is reported", () => {
  const problems = check(build({ Expires: undefined }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Expires/);
});

test("an unparseable Expires value is reported", () => {
  const problems = check(build({ Expires: "next tuesday" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /next tuesday/);
});

test("RFC 9116 allows Expires exactly once", () => {
  const problems = check(
    build({ Expires: [daysFromNow(180), daysFromNow(200)] }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /exactly once/i);
});

test("an already-expired file is reported as expired", () => {
  const problems = check(build({ Expires: daysFromNow(-1) }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /expired/i);
});

test("an Expires inside the renewal window fails before it expires", () => {
  // The whole point of the guard: it goes red while the file is still valid,
  // so the renewal happens on a working day rather than after a scanner has
  // already started treating the file as absent.
  const problems = check(build({ Expires: daysFromNow(10) }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /within \d+ days/i);
});

test("an Expires just outside the renewal window passes", () => {
  assert.deepEqual(check(build({ Expires: daysFromNow(31) })), []);
});

test("an Expires more than a year out is reported", () => {
  // RFC 9116 §2.5.5: "less than a year".
  const problems = check(build({ Expires: daysFromNow(400) }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /year/i);
});

test("a missing Canonical field is reported", () => {
  const problems = check(build({ Canonical: undefined }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Canonical/);
});

test("a Canonical pointing at another URL is reported", () => {
  const problems = check(build({ Canonical: "https://example.com/x.txt" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /example\.com/);
});

test("several problems are reported together", () => {
  const problems = check(
    build({ Contact: undefined, Expires: undefined, Canonical: undefined }),
  );
  assert.equal(problems.length, 3);
});

test("a Contact address absent from SECURITY.md is reported", () => {
  const problems = validateContactParity(
    build({ Contact: "mailto:stale@example.com" }),
    "Email us at security@heypinchy.com",
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /stale@example\.com/);
});

test("a Contact address present in SECURITY.md passes parity", () => {
  assert.deepEqual(
    validateContactParity(
      build(),
      "Email us at **security@heypinchy.com** with:",
    ),
    [],
  );
});

test("non-mailto Contact entries are exempt from the parity check", () => {
  // A Contact may be a web form or a phone number; only addresses can drift
  // against the mail address SECURITY.md tells reporters to use.
  assert.deepEqual(
    validateContactParity(
      build({ Contact: "https://example.com/report" }),
      "no addresses here",
    ),
    [],
  );
});

test("the committed security.txt is valid and not about to expire", () => {
  // Deliberately time-dependent against the real clock. This is the renewal
  // alarm: it turns main red RENEWAL_WINDOW_DAYS before the published file
  // stops being honoured, which is the only mechanism that keeps an expiring
  // security.txt from quietly becoming a security.txt nobody reads.
  const content = readFileSync(SECURITY_TXT, "utf8");
  const problems = validateSecurityTxt(content, {
    now: new Date(),
    canonical: CANONICAL,
  });
  assert.deepEqual(
    problems,
    [],
    [
      ...problems,
      "",
      `Renew ${SECURITY_TXT}: set Expires ~6 months out, under a year.`,
      "THEN RENEW THE SECOND COPY, which nothing checks:",
      "  heypinchy/website (private) -> public/.well-known/security.txt",
      "It shares this Expires date and serves heypinchy.com, the domain",
      "reporters actually write to. Renewing only this file leaves that one",
      "expired with the alarm silent.",
    ].join("\n"),
  );
});

test("the committed security.txt agrees with SECURITY.md", () => {
  assert.deepEqual(
    validateContactParity(
      readFileSync(SECURITY_TXT, "utf8"),
      readFileSync(SECURITY_MD, "utf8"),
    ),
    [],
  );
});

test("the renewal window leaves room to act", () => {
  assert.ok(RENEWAL_WINDOW_DAYS >= 14);
});
