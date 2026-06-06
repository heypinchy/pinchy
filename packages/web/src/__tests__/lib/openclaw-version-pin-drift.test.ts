/**
 * Drift guard for the OpenClaw version pin.
 *
 * OpenClaw's version lives in two places that must stay in lockstep:
 *
 *   1. `Dockerfile.openclaw` — `RUN npm install -g openclaw@X.Y.Z` installs the
 *      runtime that actually answers Gateway RPCs.
 *   2. `packages/web/package.json` — `devDependencies.openclaw` is the SINGLE
 *      source `next.config.ts` reads to populate `NEXT_PUBLIC_OPENCLAW_VERSION`,
 *      which `/api/version` and the diagnostics bundle report to operators.
 *
 * If these drift, `/api/version` lies: it reports a version the container is not
 * running. That is the exact failure class the release-version guards exist to
 * stop for Pinchy's own version (assert-package-version.mjs) — this test extends
 * the same contract to the OpenClaw pin, which has no other guard.
 *
 * Structural check so the drift trips here at `pnpm test` instead of in a
 * post-release `/api/version` smoke test.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../../../..");
const DOCKERFILE_OPENCLAW = readFileSync(resolve(REPO_ROOT, "Dockerfile.openclaw"), "utf8");
const WEB_PACKAGE_JSON = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "packages/web/package.json"), "utf8")
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/**
 * Extract the version from the canonical
 * `RUN npm install -g openclaw@<version>` line in Dockerfile.openclaw.
 * Intentionally narrow: a `@scope/openclaw` or a differently-named package
 * must not match, so a refactor that renames the install can't silently
 * defeat the guard.
 */
function dockerfileOpenclawVersion(dockerfile: string): string | undefined {
  const match = dockerfile.match(/npm install -g openclaw@(\d[^\s"']*)/);
  return match?.[1];
}

describe("OpenClaw version pin drift guard", () => {
  it("Dockerfile.openclaw declares an openclaw@<version> install", () => {
    expect(dockerfileOpenclawVersion(DOCKERFILE_OPENCLAW)).toBeDefined();
  });

  it("package.json declares an openclaw dependency", () => {
    const pkgVersion =
      WEB_PACKAGE_JSON.devDependencies?.openclaw ?? WEB_PACKAGE_JSON.dependencies?.openclaw;
    expect(pkgVersion).toBeDefined();
  });

  it("Dockerfile install version matches package.json (so /api/version is truthful)", () => {
    const dockerfileVersion = dockerfileOpenclawVersion(DOCKERFILE_OPENCLAW);
    const pkgVersion =
      WEB_PACKAGE_JSON.devDependencies?.openclaw ?? WEB_PACKAGE_JSON.dependencies?.openclaw;
    expect(dockerfileVersion).toBe(pkgVersion);
  });
});
