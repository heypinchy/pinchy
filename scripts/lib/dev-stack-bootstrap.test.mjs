/**
 * The documented dev command must work on a fresh checkout, and every service
 * that runs web source in dev must be able to resolve what that source imports.
 * Both broke on `main` without any test noticing, because no test starts a dev
 * stack.
 *
 * 1. NO PINCHY_VERSION. `docker-compose.yml` makes PINCHY_VERSION mandatory
 *    (`${PINCHY_VERSION:?…}`) — right for production, where an unset tag would
 *    pull whatever is newest. Compose interpolates each file BEFORE merging, so
 *    the dev overlay cannot default it; `pnpm worktree:env` writes
 *    `PINCHY_VERSION=dev` into `.env` instead (env-file.test.mjs). The base
 *    file stays strict, pinned here.
 *
 * 2. THE CONVERTER'S ESCAPING IMPORT. `office-converter` mounts only
 *    `packages/web/src`, but `log-line.ts` imports
 *    `../../../plugins/pinchy-files/docx-zip-guard` — outside `web/`. In
 *    production the image COPYs that file; in dev the mount has to supply it,
 *    or the converter crash-loops with "Cannot find module". The `pinchy`
 *    service has the same mount for the same reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (f) => readFileSync(join(ROOT, f), "utf8");

/** Top-level `services:` blocks of a compose file, as name -> body lines. */
function services(text) {
  const out = {};
  let current = null;
  let inServices = false;
  for (const line of text.split("\n")) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (/^\S/.test(line) && !/^#/.test(line)) inServices = false;
    if (!inServices) continue;
    const m = line.match(/^ {2}([\w-]+):\s*$/);
    if (m) {
      current = m[1];
      out[current] = [];
    } else if (current) out[current].push(line);
  }
  return out;
}

const mounts = (body) =>
  body.map((l) => l.match(/^\s+-\s+["']?(\.\/[^\s#"']+)/)?.[1]).filter(Boolean);

test("every dev service mounting web/src alone also mounts the plugins read-only", () => {
  const dev = services(read("docker-compose.dev.yml"));
  const sourceOnly = Object.entries(dev).filter(([, body]) => {
    const m = mounts(body);
    return (
      m.some((x) => x.startsWith("./packages/web/src")) &&
      !m.some((x) => x.startsWith("./packages/web:"))
    );
  });
  assert.ok(sourceOnly.length > 0, "expected office-converter to be found");
  for (const [name, body] of sourceOnly) {
    assert.ok(
      body.some((l) =>
        /-\s+\.\/packages\/plugins:\/app\/packages\/plugins:ro\b/.test(l),
      ),
      `${name} mounts web/src but not ./packages/plugins:/app/packages/plugins:ro — ` +
        `log-line.ts imports ../../../plugins/pinchy-files/docx-zip-guard`,
    );
  }
});

test("the dev overlay does not loosen the converter (no network, caps or privilege)", () => {
  const body = services(read("docker-compose.dev.yml"))[
    "office-converter"
  ].join("\n");
  assert.doesNotMatch(body, /network_mode:(?!\s*none\b)/);
  assert.doesNotMatch(body, /cap_add|privileged/);
});

test("production compose stays strict about PINCHY_VERSION", () => {
  const base = read("docker-compose.yml");
  const strict = base.match(/\$\{PINCHY_VERSION:\?/g) ?? [];
  const images = base.match(/image:.*\$\{PINCHY_VERSION[^}]*\}/g) ?? [];
  assert.equal(strict.length, images.length);
  assert.ok(images.length >= 3);
});
