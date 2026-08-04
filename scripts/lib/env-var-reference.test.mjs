import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  READ_NOT_FORWARDED,
  assertReadNotForwardedAreAbsent,
  extractComposeVariables,
  extractDocumentedVariables,
  findGhostVariables,
  findUndocumentedVariables,
  findWrongDefaults,
} from "./env-var-reference.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COMPOSE = join(REPO_ROOT, "docker-compose.yml");
const PAGE = join(
  REPO_ROOT,
  "docs/src/content/docs/reference/environment-variables.mdx",
);

// ── pure logic ────────────────────────────────────────────────────────────

test("extractComposeVariables reads defaults, required markers and bare uses", () => {
  const vars = extractComposeVariables(
    [
      "image: pinchy:${PINCHY_VERSION:?set it}",
      'ports: ["${PINCHY_PORT:-127.0.0.1:7777}:7777"]',
      "mem_limit: ${PINCHY_MEM_LIMIT:-1g}",
      "environment: [FOO=${BARE_ONE}]",
    ].join("\n"),
  );
  assert.deepEqual(vars.get("PINCHY_VERSION"), {
    default: null,
    required: true,
  });
  assert.deepEqual(vars.get("PINCHY_PORT"), {
    default: "127.0.0.1:7777",
    required: false,
  });
  assert.deepEqual(vars.get("PINCHY_MEM_LIMIT"), {
    default: "1g",
    required: false,
  });
  assert.deepEqual(vars.get("BARE_ONE"), { default: null, required: false });
});

test("extractComposeVariables keeps the most specific reading of a repeated var", () => {
  // PINCHY_VERSION appears in both image tags; DB_PASSWORD twice with a default.
  const vars = extractComposeVariables(
    "a: ${DB_PASSWORD:-pinchy_dev}\nb: ${DB_PASSWORD:-pinchy_dev}\nc: ${V:?x}\nd: ${V:?x}",
  );
  assert.deepEqual(vars.get("DB_PASSWORD"), {
    default: "pinchy_dev",
    required: false,
  });
  assert.equal(vars.get("V").required, true);
});

test("extractComposeVariables throws rather than reporting an empty compose file", () => {
  assert.throws(
    () => extractComposeVariables("services:\n  pinchy:\n"),
    /no \$\{VAR\}/,
  );
});

test("extractDocumentedVariables reads the table rows", () => {
  const page = [
    "| Variable | Default | What it does |",
    "| -------- | ------- | ------------ |",
    "| `PINCHY_PORT` | `127.0.0.1:7777` | host binding |",
    "| `ENCRYPTION_KEY` | auto-generated | encrypts keys |",
  ].join("\n");
  const documented = extractDocumentedVariables(page);
  assert.deepEqual(documented.get("PINCHY_PORT"), {
    default: "127.0.0.1:7777",
  });
  // "auto-generated" is prose, not a literal default.
  assert.deepEqual(documented.get("ENCRYPTION_KEY"), { default: null });
});

test("extractDocumentedVariables throws when the table shape changes", () => {
  assert.throws(
    () => extractDocumentedVariables("# Environment variables\n\nProse only."),
    /table rows/,
  );
});

test("findUndocumentedVariables flags a compose variable the page omits", () => {
  const problems = findUndocumentedVariables(
    new Map([
      ["PINCHY_PORT", {}],
      ["DB_CPUS", {}],
    ]),
    new Map([["PINCHY_PORT", {}]]),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /DB_CPUS/);
});

test("findGhostVariables flags a documented variable compose never expands", () => {
  const problems = findGhostVariables(
    new Map([["PINCHY_PORT", {}]]),
    new Map([
      ["PINCHY_PORT", {}],
      ["MADE_UP", {}],
    ]),
    {},
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /MADE_UP/);
});

test("findGhostVariables lets a known read-not-forwarded variable through", () => {
  assert.deepEqual(
    findGhostVariables(
      new Map([["PINCHY_PORT", {}]]),
      new Map([["AUDIT_HMAC_SECRET", {}]]),
      {
        AUDIT_HMAC_SECRET:
          "read by the app, absent from the compose environment block",
      },
    ),
    [],
  );
});

test("findWrongDefaults catches a default the page states wrongly", () => {
  const compose = new Map([
    ["PINCHY_MEM_LIMIT", { default: "1g", required: false }],
  ]);
  assert.deepEqual(
    findWrongDefaults(
      compose,
      new Map([["PINCHY_MEM_LIMIT", { default: "1g" }]]),
    ),
    [],
  );
  const problems = findWrongDefaults(
    compose,
    new Map([["PINCHY_MEM_LIMIT", { default: "2g" }]]),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /PINCHY_MEM_LIMIT/);
});

test("findWrongDefaults treats an empty compose fallback as no default", () => {
  // `${ENCRYPTION_KEY:-}` and a page that says "auto-generated" agree.
  assert.deepEqual(
    findWrongDefaults(
      new Map([["ENCRYPTION_KEY", { default: "", required: false }]]),
      new Map([["ENCRYPTION_KEY", { default: null }]]),
    ),
    [],
  );
});

test("findWrongDefaults rejects a stated default for a required variable", () => {
  const problems = findWrongDefaults(
    new Map([["PINCHY_VERSION", { default: null, required: true }]]),
    new Map([["PINCHY_VERSION", { default: "v0.9.1" }]]),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /required/);
});

test("assertReadNotForwardedAreAbsent flags a caveat that outlived the gap", () => {
  const problems = assertReadNotForwardedAreAbsent(
    new Map([["AUDIT_HMAC_SECRET", {}]]),
    {
      AUDIT_HMAC_SECRET:
        "read by the app, absent from the compose environment block",
    },
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /now expands/);
});

test("assertReadNotForwardedAreAbsent wants a real reason", () => {
  const problems = assertReadNotForwardedAreAbsent(new Map(), { X: "because" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /real reason/);
});

// ── the repo itself ───────────────────────────────────────────────────────

const compose = () => extractComposeVariables(readFileSync(COMPOSE, "utf8"));
const documented = () => extractDocumentedVariables(readFileSync(PAGE, "utf8"));

test("the reference documents every variable docker-compose.yml expands", () => {
  const vars = compose();
  assert.ok(
    vars.size > 8,
    `expected the full variable set, found ${vars.size}`,
  );
  assert.deepEqual(findUndocumentedVariables(vars, documented()), []);
});

test("the reference documents no variable docker-compose.yml ignores", () => {
  assert.deepEqual(findGhostVariables(compose(), documented()), []);
});

test("every default the reference states is the one compose falls back to", () => {
  assert.deepEqual(findWrongDefaults(compose(), documented()), []);
});

test("every READ_NOT_FORWARDED entry is still un-forwarded, with a reason", () => {
  assert.deepEqual(
    assertReadNotForwardedAreAbsent(compose(), READ_NOT_FORWARDED),
    [],
  );
});

test("the page really covers the READ_NOT_FORWARDED variables it claims to", () => {
  // The exception exists so the page can carry the caveat. If the page stops
  // mentioning the variable, the exception is silencing the ghost check for
  // nothing.
  const doc = documented();
  for (const name of Object.keys(READ_NOT_FORWARDED)) {
    assert.ok(
      doc.has(name),
      `READ_NOT_FORWARDED lists ${name}, but the reference page has no row for it`,
    );
  }
});
