/**
 * Keeps the per-worktree dev-stack allocation from reaching stacks it does not
 * own. Both guards here exist because of a concrete regression, not a hunch.
 *
 * 1. THE LEAK. The first version wrote `PINCHY_PORT` into `.env`. That variable
 *    is read by `docker-compose.yml` — the base file EVERY E2E stack layers on
 *    — and Compose reads `.env` on every invocation from the repo root. So one
 *    `pnpm worktree:env` moved six E2E suites off the :7777 their Playwright
 *    configs expect (web, setup-wizard, odoo, email, imap, telegram; telegram
 *    hard-codes the URL and has no escape hatch at all). The rename to DEV_*
 *    fixes it; this guard keeps those keys out of every file but the dev
 *    overlay, and forces any stack that DOES layer the dev overlay to pin its
 *    ports back.
 *
 * 2. THE COLLISION. The allocator hands out bands around 7777/5434/8443, and
 *    the repo already hard-codes 7778, 7779, 7781, 5433, 5435 and 5437 inside
 *    those bands. A probe only sees what is bound right now and allocation is
 *    sticky, so a worktree allocated while the integration stack was down
 *    would take 7779 and keep it — breaking `pnpm test:e2e:integration` in
 *    that worktree forever, with nothing pointing back at the cause. Every
 *    such port must be in RESERVED_PORTS.
 *
 * The lesson both encode is the repo's own: assert the value a concrete stack
 * RESOLVES to, not the value one file asks for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { unreservedBandConflicts } from "./worktree-ports.mjs";
import { MANAGED_KEYS } from "./env-file.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WEB = join(ROOT, "packages", "web");
const DEV_OVERLAY = "docker-compose.dev.yml";

const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

const composeFiles = readdirSync(ROOT).filter(
  (f) => f.startsWith("docker-compose") && f.endsWith(".yml"),
);

const playwrightConfigs = [
  ...readdirSync(WEB)
    .filter((f) => f.startsWith("playwright") && f.endsWith(".config.ts"))
    .map((f) => join("packages", "web", f)),
  join("packages", "web", "eval", "playwright.eval.config.ts"),
];

/**
 * Host ports a compose file publishes. `${VAR:-default}` resolves to its
 * default — that is what a checkout without `.env` actually binds. A
 * single-element entry ("9100") publishes on a random host port and is not a
 * claim on anything.
 */
function publishedHostPorts(text) {
  const ports = [];
  for (const line of text.split("\n")) {
    const entry = /^\s*-\s*"?([^"#\s]+)"?\s*$/.exec(line);
    if (!entry) continue;
    const resolved = entry[1].replace(/\$\{[^:}]+:-([^}]*)\}/g, "$1");
    const parts = resolved.split(":");
    if (parts.length < 2) continue;
    const host = parts.length >= 3 ? parts[1] : parts[0];
    if (/^\d+$/.test(host)) ports.push(Number(host));
  }
  return ports;
}

/** Ports a Playwright config or package script expects to talk to. */
function expectedPorts(text) {
  return [...text.matchAll(/localhost:(\d{4,5})/g)].map((m) => Number(m[1]));
}

/** The `  <service>:` block of a compose file, or null. */
function serviceBlock(text, service) {
  const lines = text.split("\n");
  const start = lines.indexOf(`  ${service}:`);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^ {2}\S/.test(lines[end])) end++;
  return lines.slice(start, end).join("\n");
}

/** Compose stacks a config documents, as `docker compose -f a -f b …`. */
function documentedStacks(text) {
  const flat = text.replace(/\n\s*\*/g, " ").replace(/\\\s+/g, " ");
  return [...flat.matchAll(/docker compose((?:\s+-f\s+[\w.-]+)+)/g)].map((m) =>
    [...m[1].matchAll(/-f\s+([\w.-]+)/g)].map((f) => f[1]),
  );
}

// ---------------------------------------------------------------------------
// 1. The leak
// ---------------------------------------------------------------------------

test("the generated .env keys are read by the dev overlay and nothing else", () => {
  for (const file of composeFiles) {
    if (file === DEV_OVERLAY) continue;
    const text = read(file);
    for (const key of MANAGED_KEYS) {
      if (key === "COMPOSE_PROJECT_NAME") continue; // Compose reads it itself.
      assert.ok(
        !text.includes(key),
        `${file} reads ${key}. That key is written into .env per worktree, and ` +
          `Compose reads .env for EVERY stack started from the repo root — so ` +
          `this stack would silently move with the dev allocation. Keep the ` +
          `variable in ${DEV_OVERLAY} and pin a fixed port here.`,
      );
    }
  }
});

test("a stack layering the dev overlay pins the ports back", () => {
  const checked = [];
  for (const config of playwrightConfigs) {
    for (const stack of documentedStacks(read(config))) {
      if (!stack.includes(DEV_OVERLAY)) continue;
      const last = stack[stack.length - 1];
      const text = read(last);
      for (const service of ["pinchy", "db"]) {
        const block = serviceBlock(text, service);
        assert.ok(
          block,
          `${config} runs a stack on ${DEV_OVERLAY} whose last overlay ` +
            `(${last}) has no ${service} service to pin the port in.`,
        );
        assert.match(
          block,
          /ports:\s*!override/,
          `${last} inherits ${DEV_OVERLAY}'s movable ${service} port. ` +
            `${config} expects a fixed one, so a single \`pnpm worktree:env\` ` +
            `would break that suite. Add \`ports: !override\` to ${service}.`,
        );
        for (const key of MANAGED_KEYS) {
          assert.ok(
            !block.includes(key),
            `${last}'s ${service} port still depends on ${key}.`,
          );
        }
      }
      checked.push(`${config} -> ${last}`);
    }
  }
  // A rename or a moved comment must not turn this guard into a no-op.
  assert.ok(
    checked.length >= 2,
    `Expected to check at least the odoo and eval stacks, checked: ${checked}`,
  );
});

// ---------------------------------------------------------------------------
// 2. The collision
// ---------------------------------------------------------------------------

test("no hard-coded port in the repo sits inside an allocation band", () => {
  const claims = [];
  for (const file of composeFiles) {
    for (const port of publishedHostPorts(read(file))) {
      claims.push({ file, port });
    }
  }
  for (const file of [
    ...playwrightConfigs,
    join("packages", "web", "package.json"),
  ]) {
    for (const port of expectedPorts(read(file))) claims.push({ file, port });
  }

  const conflicts = unreservedBandConflicts(claims.map((c) => c.port));
  const where = conflicts.map(
    (port) =>
      `${port} (${[...new Set(claims.filter((c) => c.port === port).map((c) => c.file))].join(", ")})`,
  );
  assert.deepEqual(
    conflicts,
    [],
    `These ports are hard-coded in the repo AND inside a band the worktree ` +
      `allocator hands out: ${where.join("; ")}. A worktree allocated while ` +
      `that stack was down would take the port and keep it. Either move the ` +
      `port out of the bands or add it to RESERVED_PORTS in worktree-ports.mjs.`,
  );
});

// ---------------------------------------------------------------------------

/**
 * 3. THE SPLIT BRAIN. `vitest.integration.config.ts` resolves the test-DB port
 *    from this worktree's allocation; `test-helpers/integration/global-setup.ts`
 *    used to carry its OWN `localhost:5434` default. So in any allocated
 *    worktree the two halves of `pnpm test:db` addressed different servers: the
 *    config pointed the tests at :5444 while global-setup ran DROP DATABASE /
 *    CREATE DATABASE plus migrations on :5434.
 *
 *    Nothing listening on 5434 makes that a loud ECONNREFUSED, which is the
 *    lucky case. The unlucky case is another worktree's dev stack sitting there:
 *    then `pnpm test:db` in worktree A drops and recreates `pinchy_test_vitest`
 *    on worktree B's Postgres. That is the exact hazard the config file's own
 *    comment warns about ("or, worse, quietly run against ANOTHER worktree's
 *    Postgres and truncate its tables") — written next to the half that was
 *    fixed, while the other half still had the default.
 *
 *    Guard 2 cannot catch this: 5434 is the allocator's own base port and is
 *    legitimately in RESERVED_PORTS, so a hard-coded 5434 looks fine to it. The
 *    defect is not the number, it is having a SECOND source for it.
 */
test("the test-db URL has exactly one source, shared by config and global-setup", () => {
  const files = [
    join("packages", "web", "vitest.integration.config.ts"),
    join(
      "packages",
      "web",
      "src",
      "test-helpers",
      "integration",
      "global-setup.ts",
    ),
  ];

  const offenders = [];
  for (const file of files) {
    const text = read(file);
    // A literal postgres:// URL in either file is a second source of truth,
    // whichever port it names.
    const literals = text.match(/postgres(?:ql)?:\/\/[^\s"'`]+/g) ?? [];
    if (literals.length > 0) offenders.push(`${file}: ${literals.join(", ")}`);
  }

  assert.deepEqual(
    offenders,
    [],
    `These files hard-code a Postgres URL instead of importing the shared ` +
      `resolver (packages/web/src/test-helpers/integration/db-url.ts): ` +
      `${offenders.join("; ")}. Two sources means the suite can provision one ` +
      `database and test against another — and DROP DATABASE on a port this ` +
      `worktree does not own.`,
  );
});
