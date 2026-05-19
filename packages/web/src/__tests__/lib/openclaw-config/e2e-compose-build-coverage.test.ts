/**
 * Drift guard for `docker-compose.e2e.yml`.
 *
 * The E2E / integration / Odoo / Web / Email suites all layer the same
 * compose chain: `docker-compose.yml` (production, references images by
 * `${PINCHY_VERSION:?}`) + `docker-compose.e2e.yml` (turns the image refs
 * into `build:` directives from `Dockerfile.pinchy` / `Dockerfile.openclaw`)
 * + a suite-specific overlay.
 *
 * If `e2e.yml` ever loses the `build:` directive for `pinchy` or `openclaw`,
 * CI silently flips from "build locally from prod Dockerfile" to "pull image
 * tagged `:latest` from the registry" — which may not exist, or worse, may
 * be stale and mask the very dev/prod-parity bug class issue #196 closed.
 * That switch is invisible at PR review time because the workflows still
 * say `up --build -d`; compose just no-ops the build flag if no service
 * declares `build:`.
 *
 * This test enforces the contract structurally so the drift trips here
 * instead of in a flaky CI run.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../../../../..");
const COMPOSE_E2E = readFileSync(resolve(REPO_ROOT, "docker-compose.e2e.yml"), "utf8");

/**
 * Walk the YAML line-by-line and collect the lines belonging to one
 * top-level service block under `services:`. Returns the lines indented
 * deeper than the service header until either the next service header
 * (same indent) or end-of-file. This is cheap and avoids regex
 * backtracking pitfalls with multiline lazy quantifiers.
 *
 * Compose files we care about all use 2-space indent for services and
 * 4-space indent for service-internal keys; we hardcode that shape
 * because it is consistent across the repo.
 */
function serviceBlockLines(yaml: string, service: string): string[] {
  const lines = yaml.split("\n");
  const headerIdx = lines.findIndex((l) => l === `  ${service}:`);
  if (headerIdx === -1) return [];
  const block: string[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    // End of block: blank line OR a line indented at the same level
    // (next top-level key under services, e.g. `  openclaw:`).
    if (line === "") break;
    if (line.startsWith("  ") && !line.startsWith("    ")) break;
    block.push(line);
  }
  return block;
}

function serviceHasKey(block: string[], key: string): boolean {
  return block.some((l) => l.startsWith(`    ${key}:`));
}

function serviceKeyValue(block: string[], key: string): string | undefined {
  const line = block.find((l) => l.startsWith(`    ${key}:`));
  if (!line) return undefined;
  return line.slice(`    ${key}:`.length).trim();
}

function buildSubKeyValue(block: string[], key: string): string | undefined {
  // `build:` is followed by an indented sub-block; sub-keys sit at 6-space
  // indent. Find the build header, then walk forward collecting sub-lines
  // that start with 6+ spaces.
  const buildIdx = block.findIndex((l) => l === "    build:");
  if (buildIdx === -1) return undefined;
  for (const line of block.slice(buildIdx + 1)) {
    if (!line.startsWith("      ")) break;
    const trimmed = line.slice(6);
    if (trimmed.startsWith(`${key}:`)) {
      return trimmed.slice(`${key}:`.length).trim();
    }
  }
  return undefined;
}

describe("docker-compose.e2e.yml build-directive coverage", () => {
  it("pinchy service builds from Dockerfile.pinchy (not a registry pull)", () => {
    const block = serviceBlockLines(COMPOSE_E2E, "pinchy");
    expect(block.length).toBeGreaterThan(0);
    expect(serviceHasKey(block, "build")).toBe(true);
    expect(buildSubKeyValue(block, "context")).toBe(".");
    expect(buildSubKeyValue(block, "dockerfile")).toBe("Dockerfile.pinchy");
  });

  it("openclaw service builds from Dockerfile.openclaw (not a registry pull)", () => {
    const block = serviceBlockLines(COMPOSE_E2E, "openclaw");
    expect(block.length).toBeGreaterThan(0);
    expect(serviceHasKey(block, "build")).toBe(true);
    expect(buildSubKeyValue(block, "context")).toBe(".");
    expect(buildSubKeyValue(block, "dockerfile")).toBe("Dockerfile.openclaw");
  });

  it("does not pin pinchy or openclaw to a published image tag", () => {
    // If someone replaces `build:` with `image:` (e.g. to speed up CI), the
    // suite would pull from the registry and stop exercising the local
    // production Dockerfile. Reject any `image:` on these services in this
    // overlay specifically.
    expect(serviceKeyValue(serviceBlockLines(COMPOSE_E2E, "pinchy"), "image")).toBeUndefined();
    expect(serviceKeyValue(serviceBlockLines(COMPOSE_E2E, "openclaw"), "image")).toBeUndefined();
  });
});
