/**
 * Drift guard for the OpenClaw version pin.
 *
 * OpenClaw's version lives in two manifests that must stay in lockstep:
 *
 *   1. `packages/openclaw-runtime/package.json` — the workspace package the
 *      pinchy-openclaw image installs (`Dockerfile.openclaw`), i.e. the runtime
 *      that actually answers Gateway RPCs.
 *   2. `packages/web/package.json` — `devDependencies.openclaw` is the SINGLE
 *      source `next.config.ts` reads to populate `NEXT_PUBLIC_OPENCLAW_VERSION`,
 *      which `/api/version` and the diagnostics bundle report to operators.
 *
 * If these drift, `/api/version` lies: it reports a version the container is not
 * running. That is the exact failure class the release-version guards exist to
 * stop for Pinchy's own version (assert-package-version.mjs) — this test extends
 * the same contract to the OpenClaw pin, which has no other guard.
 *
 * The image used to `npm install -g openclaw@X`. That honoured the
 * npm-shrinkwrap.json OpenClaw publishes and nothing in this repo, so the
 * runtime shipped versions neither pnpm-lock.yaml nor `pnpm.overrides` (nor the
 * osv-scanner job reading them) ever saw: undici 8.5.0 and MCP SDK 1.29.0 among
 * ten such packages, while every scanner was green. The image now installs the
 * runtime package from the workspace lockfile, so the tree it ships is the tree
 * `vuln-scan` checks. The install-shape assertions below keep it that way.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../../../..");
const DOCKERFILE_OPENCLAW = readFileSync(resolve(REPO_ROOT, "Dockerfile.openclaw"), "utf8");

type Manifest = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readManifest(relativePath: string): Manifest {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relativePath), "utf8")) as Manifest;
}

const WEB_PACKAGE_JSON = readManifest("packages/web/package.json");
const RUNTIME_PACKAGE_JSON = readManifest("packages/openclaw-runtime/package.json");

/** Dockerfile instructions only — the file explains its history in comments. */
function dockerfileInstructions(dockerfile: string): string {
  return dockerfile
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

const INSTRUCTIONS = dockerfileInstructions(DOCKERFILE_OPENCLAW);

describe("OpenClaw version pin drift guard", () => {
  it("the runtime package declares an exact openclaw version", () => {
    expect(RUNTIME_PACKAGE_JSON.dependencies?.openclaw).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });

  it("package.json declares an openclaw dependency", () => {
    const pkgVersion =
      WEB_PACKAGE_JSON.devDependencies?.openclaw ?? WEB_PACKAGE_JSON.dependencies?.openclaw;
    expect(pkgVersion).toBeDefined();
  });

  it("runtime package version matches packages/web (so /api/version is truthful)", () => {
    const pkgVersion =
      WEB_PACKAGE_JSON.devDependencies?.openclaw ?? WEB_PACKAGE_JSON.dependencies?.openclaw;
    expect(RUNTIME_PACKAGE_JSON.dependencies?.openclaw).toBe(pkgVersion);
  });
});

describe("pinchy-openclaw installs OpenClaw from the workspace lockfile", () => {
  it("installs the runtime package with a frozen lockfile", () => {
    expect(INSTRUCTIONS).toMatch(
      new RegExp(
        `pnpm install[^\\n]*--frozen-lockfile[^\\n]*--filter ${RUNTIME_PACKAGE_JSON.name}(\\s|$)`
      )
    );
  });

  it("never installs openclaw from the registry directly", () => {
    // `npm install -g openclaw@…` (or any npm/pnpm add of the bare package)
    // bypasses pnpm-lock.yaml and the overrides — the original bug.
    expect(INSTRUCTIONS).not.toMatch(/(npm|pnpm)\s+(install|i|add)\s+(-g\s+)?openclaw(@|\s|$)/m);
  });

  it("pins the llama.cpp provider to the OpenClaw release it ships with", () => {
    // The provider is published in lockstep with OpenClaw and peers
    // `openclaw >=<its own version>`. A `-N` suffix marks a repack of the same
    // release (2026.7.1-2 is 2026.7.1), so the provider carries the base version.
    const release = RUNTIME_PACKAGE_JSON.dependencies?.openclaw?.replace(/-\d+$/, "");
    const match = INSTRUCTIONS.match(/@openclaw\/llama-cpp-provider@(\S+)/);
    expect(match?.[1]).toBe(release);
  });
});
