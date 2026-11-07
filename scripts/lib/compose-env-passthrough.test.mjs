import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  NOT_FORWARDED_ON_PURPOSE,
  checkExemptions,
  extractEnvReads,
  extractServiceEnvironment,
  findUnforwardedOperatorSettings,
  mentionedIn,
  readDocsCorpus,
  readWebEnvReads,
} from "./compose-env-passthrough.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COMPOSE = join(REPO_ROOT, "docker-compose.yml");

// ── pure logic ────────────────────────────────────────────────────────────

test("extractEnvReads reads dot and bracket access", () => {
  const reads = extractEnvReads(
    [
      "const a = process.env.PINCHY_KB_OCR?.trim();",
      'if (process.env["ALLOW_PRIVATE_URLS"] === "1") {}',
      "const b = process.env[`X_${name}`];",
      "const c = process.env[dynamicName];",
    ].join("\n"),
  );
  assert.deepEqual([...reads].sort(), ["ALLOW_PRIVATE_URLS", "PINCHY_KB_OCR"]);
});

test("extractServiceEnvironment reads one service's block, both spellings", () => {
  const compose = [
    "services:",
    "  pinchy:",
    "    image: pinchy:${PINCHY_VERSION}",
    "    environment:",
    "      - DATABASE_URL=postgresql://x",
    "      # a comment inside the block",
    "      - PINCHY_KB_OCR=${PINCHY_KB_OCR:-}",
    "      - AUDIT_HMAC_SECRET",
    "    volumes:",
    "      - NOT_ENV:/data",
    "  db:",
    "    environment:",
    "      - POSTGRES_DB=pinchy",
  ].join("\n");
  assert.deepEqual([...extractServiceEnvironment(compose, "pinchy")].sort(), [
    "AUDIT_HMAC_SECRET",
    "DATABASE_URL",
    "PINCHY_KB_OCR",
  ]);
  // Another service's block is not the pinchy container's environment.
  assert.deepEqual(
    [...extractServiceEnvironment(compose, "db")],
    ["POSTGRES_DB"],
  );
});

test("extractServiceEnvironment throws when the service or block is missing", () => {
  assert.throws(
    () =>
      extractServiceEnvironment("services:\n  db:\n    image: x\n", "pinchy"),
    /no `pinchy:` service/,
  );
  assert.throws(
    () =>
      extractServiceEnvironment(
        "services:\n  pinchy:\n    image: x\n  db:\n    environment:\n      - A=1\n",
        "pinchy",
      ),
    /no `environment:` entries/,
  );
});

test("extractServiceEnvironment refuses the map form instead of reading nothing", () => {
  assert.throws(
    () =>
      extractServiceEnvironment(
        "services:\n  pinchy:\n    environment:\n      DATABASE_URL: x\n",
        "pinchy",
      ),
    /cannot read/,
  );
});

test("mentionedIn matches whole names only", () => {
  const docs = "Set `PINCHY_KB_OCR=off` in your `.env`.";
  assert.equal(mentionedIn(docs, "PINCHY_KB_OCR"), true);
  assert.equal(mentionedIn(docs, "KB_OCR"), false);
  assert.equal(mentionedIn(docs, "PINCHY_KB"), false);
});

test("findUnforwardedOperatorSettings flags a documented read compose drops", () => {
  const problems = findUnforwardedOperatorSettings({
    reads: new Set(["PINCHY_KB_OCR", "INTERNAL_ONLY", "DATABASE_URL"]),
    docs: "Set `PINCHY_KB_OCR=off`. `DATABASE_URL` is set for you.",
    forwarded: new Set(["DATABASE_URL"]),
    exemptions: {},
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /PINCHY_KB_OCR/);
  assert.match(problems[0], /- PINCHY_KB_OCR=\$\{PINCHY_KB_OCR:-\}/);
});

test("findUnforwardedOperatorSettings honours an exemption", () => {
  assert.deepEqual(
    findUnforwardedOperatorSettings({
      reads: new Set(["NODE_ENV"]),
      docs: "`NODE_ENV`",
      forwarded: new Set(),
      exemptions: { NODE_ENV: "set by the image itself, not by an operator" },
    }),
    [],
  );
});

test("checkExemptions rejects every way an exemption can go stale", () => {
  const base = {
    reads: new Set(["NODE_ENV", "FORWARDED_NOW", "UNMENTIONED"]),
    docs: "`NODE_ENV` `FORWARDED_NOW` `GONE_FROM_CODE`",
    forwarded: new Set(["FORWARDED_NOW"]),
  };
  const problems = checkExemptions({
    ...base,
    exemptions: {
      NODE_ENV: "short",
      FORWARDED_NOW: "a reason that is long enough to count as one",
      GONE_FROM_CODE: "a reason that is long enough to count as one",
      UNMENTIONED: "a reason that is long enough to count as one",
    },
  });
  assert.equal(problems.length, 4);
  assert.match(problems.join("\n"), /NODE_ENV.*real reason/);
  assert.match(problems.join("\n"), /FORWARDED_NOW.*now forwards it/);
  assert.match(problems.join("\n"), /GONE_FROM_CODE.*no longer reads it/);
  assert.match(problems.join("\n"), /UNMENTIONED.*docs no longer name it/);
});

// ── the repo itself ───────────────────────────────────────────────────────

const forwarded = () =>
  extractServiceEnvironment(readFileSync(COMPOSE, "utf8"), "pinchy");

test("the corpora are real, so the check below cannot pass vacuously", () => {
  const reads = readWebEnvReads(REPO_ROOT);
  assert.ok(
    reads.size > 20,
    `expected the web app's env reads, got ${reads.size}`,
  );
  assert.ok(reads.has("DATABASE_URL"), "env-read scan missed DATABASE_URL");
  // Read only by packages/web/server.ts, the custom server the image starts.
  // A scan of src/ alone misses it, and with it every switch the server reads.
  assert.ok(
    reads.has("TELEGRAM_CONFLICT_AUTO_DISABLE"),
    "env-read scan missed server.ts",
  );
  assert.ok(
    forwarded().has("DATABASE_URL"),
    "pinchy environment did not parse",
  );
  const docs = readDocsCorpus(REPO_ROOT);
  assert.ok(
    docs.length > 100_000,
    `docs corpus suspiciously small: ${docs.length}`,
  );
});

test("every env var the docs tell operators about reaches the pinchy container", () => {
  assert.deepEqual(
    findUnforwardedOperatorSettings({
      reads: readWebEnvReads(REPO_ROOT),
      docs: readDocsCorpus(REPO_ROOT),
      forwarded: forwarded(),
      exemptions: NOT_FORWARDED_ON_PURPOSE,
    }),
    [],
  );
});

test("every NOT_FORWARDED_ON_PURPOSE entry is still true, with a reason", () => {
  assert.deepEqual(
    checkExemptions({
      reads: readWebEnvReads(REPO_ROOT),
      docs: readDocsCorpus(REPO_ROOT),
      forwarded: forwarded(),
      exemptions: NOT_FORWARDED_ON_PURPOSE,
    }),
    [],
  );
});
