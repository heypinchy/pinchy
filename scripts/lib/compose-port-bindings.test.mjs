/**
 * Keeps every compose stack in this repo bound to the machine it runs on.
 *
 * The defect this exists for: every `ports:` entry in the test and dev overlays
 * was written host-IP-less ("5434:5432"), which Docker publishes on 0.0.0.0. On
 * a shared dev box or a CI runner with a routable address that made the test
 * Postgres instances, each suite's Pinchy override and all eight mock servers
 * answerable from the network — the odoo mock accepts writes, greenmail hands
 * out mail, and the databases hold seeded credentials.
 *
 * Prefixing each entry fixes today. It does not fix the next overlay: the
 * convention lives in nine files, is one token wide, and has no failure mode
 * that anyone would notice locally. That is the shape of every drift this repo
 * has already paid for, so it gets a tripwire rather than a habit — the same
 * argument as `contracts.tools` in AGENTS.md.
 *
 * The escape hatch is deliberately not a list of accepted exceptions. A stack
 * that genuinely needs a routable bind writes it the way `docker-compose.yml`
 * does — `"${PINCHY_PORT:-127.0.0.1:7777}:7777"` — so the DEFAULT is loopback
 * and an operator who wants more has to say so in their own environment. A
 * checkout binds what its files say; nobody is exposed by omission.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  expandComposeVars,
  isLoopbackHost,
  nonLoopbackPublishes,
  publishedHostPorts,
  publishedPortEntries,
} from "./compose-port-bindings.mjs";
import { MANAGED_KEYS, managedValues } from "./env-file.mjs";
import { allocatePorts, projectSlug } from "./worktree-ports.mjs";
import { trackedFilesIn } from "./tracked-files.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

// git, not readdir: an untracked `docker-compose.local.yml` is a developer's
// own business, and this guard asserts about what the repo publishes. Falls
// back to the listing when git cannot answer — a guard may check too much,
// never too little.
const composeFiles = (trackedFilesIn(ROOT) ?? readdirSync(ROOT)).filter(
  (f) => f.startsWith("docker-compose") && f.endsWith(".yml"),
);

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

test("every compose file in the repo publishes on loopback only", () => {
  const offenders = [];
  let entries = 0;
  for (const file of composeFiles) {
    const found = publishedPortEntries(read(file));
    entries += found.length;
    for (const bad of nonLoopbackPublishes(read(file))) {
      offenders.push(`${file}:${bad.line} "${bad.raw}" — ${bad.why}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `These entries publish beyond this machine:\n  ${offenders.join("\n  ")}\n` +
      `Prefix the host port with 127.0.0.1 ("127.0.0.1:5434:5432"). If the ` +
      `bind address must stay operator-controlled, put it in the variable's ` +
      `default the way docker-compose.yml does: "\${PINCHY_PORT:-127.0.0.1:7777}:7777".`,
  );

  // A walker that finds nothing passes cheerfully. Both floors are well under
  // today's numbers (12 files, 24 entries) and well over zero.
  assert.ok(
    composeFiles.length >= 8,
    `Only found ${composeFiles.length} compose files — the walker is broken.`,
  );
  assert.ok(
    entries >= 20,
    `Only read ${entries} port entries across ${composeFiles.length} compose ` +
      `files — the parser is reading past them.`,
  );
});

// ---------------------------------------------------------------------------
// The dev overlay, resolved against a real allocation
// ---------------------------------------------------------------------------

/**
 * The corpus test reads what a fresh checkout binds — the `${VAR:-default}`
 * side. A worktree that has run `pnpm worktree:env` binds something else
 * entirely, and the two halves of that value are written in two different
 * places: `127.0.0.1:` is inside DEV_PINCHY_PORT but outside DEV_DB_PORT and
 * DEV_CADDY_PORT, where the compose file supplies it.
 *
 * Nothing about either file says so, which is how the next person "harmonises"
 * them and produces `127.0.0.1:127.0.0.1:5444:5432` — a compose error that only
 * appears in an allocated worktree, never in CI, never in a fresh clone.
 */
test("the dev overlay binds loopback for a worktree that ran `pnpm worktree:env`", () => {
  const slug = projectSlug("/tmp/some-worktree");
  const ports = allocatePorts(slug, () => true);
  const env = managedValues({ slug, ports });

  const entries = publishedPortEntries(read("docker-compose.dev.yml"), env);

  assert.equal(
    entries.length,
    3,
    `Expected the dev overlay to publish pinchy, db and caddy; got ${entries.length}.`,
  );
  for (const entry of entries) {
    assert.ok(
      isLoopbackHost(entry.hostIp),
      `docker-compose.dev.yml:${entry.line} resolves to "${entry.resolved}" ` +
        `once .env exists, which binds ${entry.hostIp ?? "0.0.0.0"}.`,
    );
  }
  assert.deepEqual(
    entries.map((e) => Number(e.hostPort)).sort((a, b) => a - b),
    [ports.pinchyPort, ports.dbPort, ports.caddyPort].sort((a, b) => a - b),
    `The dev overlay does not bind the ports the allocator handed out.`,
  );
});

test("the generated block writes exactly the keys it declares", () => {
  const values = managedValues({
    slug: "x",
    ports: { pinchyPort: 7777, dbPort: 5434, caddyPort: 8443 },
  });
  assert.deepEqual(Object.keys(values).sort(), [...MANAGED_KEYS].sort());
});

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

const wrap = (...entries) =>
  [
    "services:",
    "  svc:",
    "    ports:",
    ...entries.map((e) => `      - ${e}`),
  ].join("\n");

test("reads the short-form shapes compose actually accepts", () => {
  assert.deepEqual(
    publishedPortEntries(wrap('"127.0.0.1:5434:5432"')).map((e) => [
      e.hostIp,
      e.hostPort,
      e.containerPort,
    ]),
    [["127.0.0.1", "5434", "5432"]],
  );
  assert.deepEqual(
    publishedPortEntries(wrap('"5434:5432"')).map((e) => e.hostIp),
    [null],
  );
  assert.deepEqual(
    publishedPortEntries(wrap('"9100"')).map((e) => [
      e.hostPort,
      e.containerPort,
    ]),
    [[null, "9100"]],
  );
  assert.deepEqual(
    publishedPortEntries(wrap('"[::1]:8080:80"')).map((e) => e.hostIp),
    ["[::1]"],
  );
  assert.deepEqual(
    publishedPortEntries(wrap('"127.0.0.1:5434:5432/udp"')).map(
      (e) => e.hostPort,
    ),
    ["5434"],
  );
});

test("resolves ${VAR:-default} both ways round", () => {
  // The IP inside the variable's default (docker-compose.yml's shape) …
  assert.deepEqual(
    publishedPortEntries(wrap('"${PINCHY_PORT:-127.0.0.1:7777}:7777"')).map(
      (e) => [e.hostIp, e.hostPort],
    ),
    [["127.0.0.1", "7777"]],
  );
  // … and the IP outside it (docker-compose.dev.yml's shape for db/caddy).
  assert.deepEqual(
    publishedPortEntries(wrap('"127.0.0.1:${DEV_DB_PORT:-5434}:5432"')).map(
      (e) => [e.hostIp, e.hostPort],
    ),
    [["127.0.0.1", "5434"]],
  );
  // A supplied value wins over the default.
  assert.deepEqual(
    publishedPortEntries(wrap('"127.0.0.1:${DEV_DB_PORT:-5434}:5432"'), {
      DEV_DB_PORT: "5444",
    }).map((e) => e.hostPort),
    ["5444"],
  );
  assert.equal(expandComposeVars("${NOPE}x"), "x");
});

test("flags every way an entry reaches past this machine", () => {
  const cases = [
    ['"5434:5432"', "no host IP"],
    ['"0.0.0.0:9001:9001"', "explicit 0.0.0.0"],
    ['"192.168.1.5:9001:9001"', "a LAN address"],
    ['"9100"', "a random host port"],
    ['"${DEV_DB_PORT:-5434}:5432"', "a variable default with no IP"],
  ];
  for (const [entry, why] of cases) {
    assert.equal(
      nonLoopbackPublishes(wrap(entry)).length,
      1,
      `${entry} (${why}) should be flagged.`,
    );
  }
  assert.deepEqual(nonLoopbackPublishes(wrap('"127.0.0.1:5434:5432"')), []);
  // 127.0.0.0/8 is all loopback, not just .0.1.
  assert.deepEqual(nonLoopbackPublishes(wrap('"127.0.0.2:5434:5432"')), []);
});

test("throws on a doubled host IP instead of reading past it", () => {
  // The exact shape a "harmonised" DEV_DB_PORT produces.
  assert.throws(
    () =>
      publishedPortEntries(wrap('"127.0.0.1:${DEV_DB_PORT:-5434}:5432"'), {
        DEV_DB_PORT: "127.0.0.1:5444",
      }),
    /doubled host IP|colon-separated fields/,
  );
});

test("throws on the long port syntax rather than reporting on the lines it understands", () => {
  const long = [
    "services:",
    "  svc:",
    "    ports:",
    "      - target: 9001",
    "        published: 9001",
  ].join("\n");
  assert.throws(
    () => publishedPortEntries(long),
    /long port syntax|short-form/,
  );
});

test("reads only ports blocks, so volumes, env and extra_hosts cannot be mistaken for binds", () => {
  const noise = [
    "services:",
    "  svc:",
    "    environment:",
    "      - OPENCLAW_WS_URL=ws://openclaw:18789",
    "      - BRAVE_API_BASE_URL=http://brave-mock:9003",
    "    extra_hosts:",
    '      - "api.telegram.org:172.28.0.10"',
    "    volumes:",
    "      - ./Caddyfile.dev:/etc/caddy/Caddyfile:ro",
    "      - caddy_data_dev:/data",
    "    ports:",
    '      - "127.0.0.1:9003:9003"',
  ].join("\n");
  assert.deepEqual(publishedHostPorts(noise), [9003]);
});

test("tolerates the tag and comment shapes the overlays already use", () => {
  const tagged = [
    "services:",
    "  db:",
    "    ports:",
    "      !override # Playwright/setup helpers read/seed the DB from the host.",
    '      - "127.0.0.1:5437:5432"',
    "  pinchy:",
    "    ports: !override",
    "      # the eval stack sits on 7781",
    '      - "127.0.0.1:7781:7777"',
  ].join("\n");
  assert.deepEqual(publishedHostPorts(tagged), [5437, 7781]);
});
