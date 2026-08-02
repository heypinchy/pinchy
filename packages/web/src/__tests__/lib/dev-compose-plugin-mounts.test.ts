import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KNOWN_PINCHY_PLUGINS } from "@/lib/openclaw-config/plugin-manifest-loader";

/**
 * The dev stack does NOT get its plugins the way production does.
 *
 * Production: `Dockerfile.pinchy` COPYs every plugin into the image, and
 * `entrypoint.sh` syncs them into the shared `openclaw-extensions` volume —
 * with a hard `exit 1` when one is missing (entrypoint-runtime-check.test.ts).
 *
 * Dev: `docker-compose.dev.yml` bind-mounts each plugin source directory into
 * the OpenClaw container ONE LINE AT A TIME, so a developer's edits take effect
 * without a rebuild. That list is hand-maintained, nothing derived it from
 * `KNOWN_PINCHY_PLUGINS`, and a plugin missing from it fails in the quietest
 * possible way: `regenerateOpenClawConfig()` still writes the plugin's config
 * entry, OpenClaw logs one line — `plugin not found: <name> (stale config entry
 * ignored)` — and then runs happily without it. The container is healthy, the
 * app works, and the feature is simply absent.
 *
 * That is exactly how `pinchy-approvals` shipped in #865: every unit test,
 * every drift guard and the whole E2E suite were green (E2E builds the
 * PRODUCTION image, which had the plugin), while the dev stack silently ran
 * without the confirmation gate — a security control that fails OPEN when it
 * is not loaded at all.
 *
 * So this is the dev-stack sibling of entrypoint-runtime-check.test.ts:
 * one list per environment, both pinned to KNOWN_PINCHY_PLUGINS.
 */

const REPO_ROOT = resolve(__dirname, "../../../../..");
const DEV_COMPOSE = readFileSync(resolve(REPO_ROOT, "docker-compose.dev.yml"), "utf8");

describe("docker-compose.dev.yml plugin mounts", () => {
  it("bind-mounts every known Pinchy plugin into the OpenClaw container", () => {
    const missing = KNOWN_PINCHY_PLUGINS.filter(
      (plugin) =>
        !DEV_COMPOSE.includes(`./packages/plugins/${plugin}:/root/.openclaw/extensions/${plugin}`)
    );

    expect(
      missing,
      missing.length === 0
        ? ""
        : `\n  These plugins are never loaded by the dev stack — OpenClaw logs\n` +
            `  "plugin not found" and runs without them, with no failing check:\n\n` +
            missing.map((p) => `    • ${p}`).join("\n") +
            `\n\n  Add to the openclaw service's volumes in docker-compose.dev.yml:\n\n` +
            missing
              .map((p) => `      - ./packages/plugins/${p}:/root/.openclaw/extensions/${p}`)
              .join("\n") +
            `\n`
    ).toEqual([]);
  });

  it("mounts no plugin that is not a known Pinchy plugin", () => {
    // The other direction: a mount left behind after a plugin was renamed or
    // removed shadows a path OpenClaw would otherwise ignore, and the stale
    // name is not obviously wrong when read in the compose file.
    const mounted = [
      ...DEV_COMPOSE.matchAll(
        /\.\/packages\/plugins\/([\w-]+):\/root\/\.openclaw\/extensions\/[\w-]+/g
      ),
    ].map((m) => m[1]);
    const unknown = mounted.filter(
      (name) => !(KNOWN_PINCHY_PLUGINS as readonly string[]).includes(name)
    );

    expect(unknown, `Mounted but not in KNOWN_PINCHY_PLUGINS: ${unknown.join(", ")}`).toEqual([]);
  });
});
