/**
 * Pinchy must resolve every name OpenClaw resolves, the same way.
 *
 * Pinchy re-checks a stored Odoo URL / mail host before a plugin uses it, and
 * the plugin connects from the OpenClaw container. A name only OpenClaw can
 * resolve (`ollama.local`, mapped to the Docker host) fails to resolve in
 * Pinchy, which the check treats as allowed — and the plugin connects to the
 * Docker host. See compose-extra-hosts.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  extraHostsByRole,
  normalizeHostEntry,
  parseServiceExtraHosts,
  resolverViewDrift,
  serviceRole,
} from "./compose-extra-hosts.mjs";
import { trackedFilesIn } from "./tracked-files.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BASE = "docker-compose.yml";
const read = (file) => readFileSync(join(ROOT, file), "utf8");

// git, not readdir, as in dev-stack-port-isolation.test.mjs: an untracked
// docker-compose.local.yml is a developer's own business.
const overlayFiles = (trackedFilesIn(ROOT) ?? readdirSync(ROOT)).filter(
  (f) => f.startsWith("docker-compose.") && f.endsWith(".yml") && f !== BASE,
);

// Deploy templates that are not layered on docker-compose.yml. The DigitalOcean
// image downloads docker-compose.yml itself, so it is covered by BASE.
const STANDALONE = ["marketplace/caprover/pinchy.yml"];

/**
 * OpenClaw entries Pinchy deliberately does not share. Each needs a reason, and
 * one that stops matching fails the guard (a reason must not outlive its case).
 */
const EXEMPTIONS = [
  {
    file: "docker-compose.test.yml",
    entry: "api.telegram.org=172.28.0.10",
    reason:
      "Telegram E2E points OpenClaw's real Telegram hostname at telegram-mock. Pinchy reaches the mock through TELEGRAM_API_URL and never resolves this name, and no stored Odoo/mail destination uses it.",
  },
  {
    file: "docker-compose.test.yml",
    entry: "api.anthropic.com=172.28.0.10",
    reason:
      "Telegram E2E points OpenClaw's LLM traffic at the mock. Mapping it in Pinchy too would send Pinchy's own provider-key checks to a self-signed mock; no stored Odoo/mail destination uses the name.",
  },
];

test("every compose stack gives Pinchy each extra_hosts entry OpenClaw has", () => {
  const { missing } = resolverViewDrift({
    base: { file: BASE, text: read(BASE) },
    overlays: overlayFiles.map((file) => ({ file, text: read(file) })),
    standalone: STANDALONE.map((file) => ({ file, text: read(file) })),
    exemptions: EXEMPTIONS,
  });
  assert.deepEqual(
    missing,
    [],
    "Pinchy resolves stored Odoo/mail hosts before OpenClaw connects to them, so it needs the " +
      "same /etc/hosts view. Add these to the pinchy service's extra_hosts:\n" +
      missing
        .map(({ file, entry }) => `  ${file}: "${entry.replace("=", ":")}"`)
        .join("\n"),
  );
});

test("no exemption outlives the entry it excuses", () => {
  const { stale } = resolverViewDrift({
    base: { file: BASE, text: read(BASE) },
    overlays: overlayFiles.map((file) => ({ file, text: read(file) })),
    standalone: STANDALONE.map((file) => ({ file, text: read(file) })),
    exemptions: EXEMPTIONS,
  });
  assert.deepEqual(stale, []);
  for (const { reason } of EXEMPTIONS)
    assert.ok(reason.length > 40, "exemptions carry a reason");
});

test("the scan reads a real corpus: the base file maps ollama.local on both services", () => {
  // A reader that silently finds nothing would make the guard above vacuous.
  const roles = extraHostsByRole(read(BASE), BASE);
  assert.ok(roles.openclaw?.includes("ollama.local=host-gateway"));
  assert.ok(roles.pinchy?.includes("ollama.local=host-gateway"));
  assert.ok(
    overlayFiles.length >= 8,
    `found only ${overlayFiles.length} overlays`,
  );
  const caprover = extraHostsByRole(read(STANDALONE[0]), STANDALONE[0]);
  assert.notEqual(caprover.pinchy, null);
  assert.notEqual(caprover.openclaw, null);
});

// --- the logic, on fixtures -------------------------------------------------

const compose = (pinchyHosts, openclawHosts) =>
  [
    "services:",
    "  pinchy:",
    "    image: pinchy",
    ...(pinchyHosts
      ? ["    extra_hosts:", ...pinchyHosts.map((h) => `      - "${h}"`)]
      : []),
    "",
    "  openclaw:",
    "    image: openclaw",
    ...(openclawHosts
      ? [
          "    extra_hosts:",
          "      # a comment between entries is fine",
          ...openclawHosts.map((h) => `      - "${h}"`),
        ]
      : []),
    "    volumes:",
    "      - x:/y",
    "volumes:",
    "  x:",
  ].join("\n");

test("reports the original bug: ollama.local on OpenClaw only", () => {
  const { missing } = resolverViewDrift({
    base: {
      file: "base.yml",
      text: compose(null, ["ollama.local:host-gateway"]),
    },
  });
  assert.deepEqual(missing, [
    { file: "base.yml", entry: "ollama.local=host-gateway" },
  ]);
});

test("passes when Pinchy has the same mapping, whatever the spelling", () => {
  const { missing } = resolverViewDrift({
    base: {
      file: "base.yml",
      text: compose(
        ["ollama.local=host-gateway"],
        ["ollama.local:host-gateway"],
      ),
    },
  });
  assert.deepEqual(missing, []);
});

test("a different address for the same name is a different mapping", () => {
  const { missing } = resolverViewDrift({
    base: {
      file: "base.yml",
      text: compose(["db.lan:10.0.0.1"], ["db.lan:10.0.0.2"]),
    },
  });
  assert.deepEqual(missing, [{ file: "base.yml", entry: "db.lan=10.0.0.2" }]);
});

test("an overlay is checked merged onto the base", () => {
  const base = {
    file: "base.yml",
    text: compose(["ollama.local:host-gateway"], null),
  };
  const overlay = (p, o) => ({ file: "overlay.yml", text: compose(p, o) });

  // OpenClaw gains a name in the overlay, Pinchy has it from the base: fine.
  assert.deepEqual(
    resolverViewDrift({
      base,
      overlays: [overlay(null, ["ollama.local:host-gateway"])],
    }).missing,
    [],
  );
  // OpenClaw gains a name Pinchy has nowhere: reported against the overlay.
  assert.deepEqual(
    resolverViewDrift({
      base,
      overlays: [overlay(null, ["mock.test:172.28.0.10"])],
    }).missing,
    [{ file: "overlay.yml", entry: "mock.test=172.28.0.10" }],
  );
});

test("an overlay that only defines one of the services still inherits the other", () => {
  const base = {
    file: "base.yml",
    text: compose(null, ["ollama.local:host-gateway"]),
  };
  const pinchyOnly = [
    "services:",
    "  pinchy:",
    "    extra_hosts:",
    '      - "ollama.local:host-gateway"',
  ].join("\n");
  const result = resolverViewDrift({
    base,
    overlays: [{ file: "o.yml", text: pinchyOnly }],
  });
  // The base on its own still lacks it; the merged overlay does not.
  assert.deepEqual(result.missing, [
    { file: "base.yml", entry: "ollama.local=host-gateway" },
  ]);
});

test("an exemption silences exactly its entry, and goes stale once unused", () => {
  const base = {
    file: "base.yml",
    text: compose(null, ["a.test:1.2.3.4", "b.test:1.2.3.4"]),
  };
  const exemptions = [
    { file: "base.yml", entry: "a.test=1.2.3.4", reason: "x" },
    { file: "base.yml", entry: "gone.test=1.2.3.4", reason: "x" },
  ];
  const { missing, stale } = resolverViewDrift({ base, exemptions });
  assert.deepEqual(missing, [{ file: "base.yml", entry: "b.test=1.2.3.4" }]);
  assert.deepEqual(stale, [{ file: "base.yml", entry: "gone.test=1.2.3.4" }]);
});

test("reads the map form and IPv6 addresses", () => {
  const text = [
    "services:",
    "  openclaw:",
    "    extra_hosts:",
    '      ollama.local: "host-gateway"',
    "      v6.test: ::1 # trailing comment",
  ].join("\n");
  assert.deepEqual(parseServiceExtraHosts(text, "f.yml").get("openclaw"), [
    "ollama.local=host-gateway",
    "v6.test=::1",
  ]);
  assert.equal(normalizeHostEntry('"v6.test:::1"', "f"), "v6.test=::1");
});

test("throws on a form it cannot read instead of skipping it", () => {
  for (const form of ["!override", "!reset []", '["a:1.2.3.4"]']) {
    const text = ["services:", "  openclaw:", `    extra_hosts: ${form}`].join(
      "\n",
    );
    assert.throws(
      () => parseServiceExtraHosts(text, "f.yml"),
      /unsupported extra_hosts form/,
    );
  }
  const garbled = [
    "services:",
    "  openclaw:",
    "    extra_hosts:",
    "      - nonsense",
  ].join("\n");
  assert.throws(
    () => parseServiceExtraHosts(garbled, "f.yml"),
    /cannot read extra_hosts entry/,
  );
});

test("recognises the CapRover service names", () => {
  assert.equal(serviceRole("$$cap_appname-pinchy"), "pinchy");
  assert.equal(serviceRole("$$cap_appname-openclaw"), "openclaw");
  assert.equal(serviceRole("$$cap_appname-db"), null);
  assert.equal(serviceRole("fake-ollama"), null);
});
