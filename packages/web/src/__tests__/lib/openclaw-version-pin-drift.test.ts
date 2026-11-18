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
 * runtime package from the workspace lockfile, so OpenClaw's own tree in the
 * image is the tree `vuln-scan` checks. The install-shape assertions below keep
 * it that way. (The llama-cpp provider and the /opt/pinchy-*-deps bundles are
 * still npm installs outside the lockfile.)
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../../../..");
const DOCKERFILE_OPENCLAW = readFileSync(resolve(REPO_ROOT, "Dockerfile.openclaw"), "utf8");

type Manifest = {
  name?: string;
  pnpm?: { ignoredBuiltDependencies?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readManifest(relativePath: string): Manifest {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relativePath), "utf8")) as Manifest;
}

const WEB_PACKAGE_JSON = readManifest("packages/web/package.json");
const RUNTIME_PACKAGE_JSON = readManifest("packages/openclaw-runtime/package.json");
const ROOT_PACKAGE_JSON = readManifest("package.json");

/** Dockerfile instructions only — the file explains its history in comments. */
function dockerfileInstructions(dockerfile: string): string {
  return dockerfile
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

const INSTRUCTIONS = dockerfileInstructions(DOCKERFILE_OPENCLAW);

/** The instructions of one `FROM … AS <name>` stage. */
function stage(name: string): string {
  const stages = INSTRUCTIONS.split(/^(?=FROM\s)/m);
  const found = stages.find((s) => new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${name}\\s`).test(s));
  if (!found) throw new Error(`Dockerfile.openclaw has no stage "${name}"`);
  return found;
}

// `npm`/`pnpm`/`yarn`/`bun` installing the bare `openclaw` package from the
// registry, whatever flags sit between the verb and the name.
const REGISTRY_INSTALL =
  /\b(?:npm\s+(?:install|i|add)|pnpm\s+(?:install|i|add)|yarn\s+(?:global\s+)?add|bun\s+(?:add|install|i))(?:\s+-{1,2}[\w=.-]+)*\s+openclaw(?:@|\s|$)|\bnpx\s+(?:-{1,2}[\w=.-]+\s+)*openclaw@/m;

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
    // `npm install -g openclaw@…` (or any other registry install of the bare
    // package) bypasses pnpm-lock.yaml and the overrides — the original bug.
    expect(INSTRUCTIONS).not.toMatch(REGISTRY_INSTALL);
  });

  it("the registry-install pattern catches the spellings that reintroduce the bug", () => {
    for (const spelling of [
      "RUN npm install -g openclaw@2026.7.1-2",
      "RUN npm install --global openclaw@2026.7.1-2",
      "RUN npm i -g --no-fund openclaw@2026.7.1-2",
      "RUN npm install -g --omit=dev openclaw",
      "RUN pnpm add -g openclaw@2026.7.1-2",
      "RUN yarn global add openclaw@2026.7.1-2",
      "RUN bun add -g openclaw",
      "RUN npx -y openclaw@2026.7.1-2 --version",
    ]) {
      expect(spelling, spelling).toMatch(REGISTRY_INSTALL);
    }
    for (const allowed of [
      "RUN openclaw plugins install @openclaw/llama-cpp-provider@2026.7.1",
      "RUN npm install --omit=dev",
      "RUN pnpm install --prod --frozen-lockfile --filter @pinchy/openclaw-runtime",
    ]) {
      expect(allowed, allowed).not.toMatch(REGISTRY_INSTALL);
    }
  });

  it("fails the build on any dependency install script nobody reviewed", () => {
    // pnpm only WARNS when it skips a build script, where npm ran them all. A
    // bump that brings a native binary without a prebuild would otherwise
    // build green and break at runtime.
    expect(INSTRUCTIONS).toMatch(
      new RegExp(
        `pnpm install[^\\n]*--config\\.strict-dep-builds=true[^\\n]*--filter ${RUNTIME_PACKAGE_JSON.name}(\\s|$)`
      )
    );
    // openclaw's own postinstall is skipped by pnpm and run explicitly below —
    // the review verdict that makes strict-dep-builds accept it.
    expect(ROOT_PACKAGE_JSON.pnpm?.ignoredBuiltDependencies).toContain("openclaw");
  });

  it("runs the postinstall openclaw DECLARES, not a copied script path", () => {
    // A hard-coded `node …/scripts/postinstall-*.mjs` keeps running the old
    // script after a bump changes what package.json declares.
    expect(INSTRUCTIONS).toMatch(/cd [^\n&]*node_modules\/openclaw && npm run postinstall/);
    expect(INSTRUCTIONS).not.toMatch(/node_modules\/openclaw\/scripts\//);
  });

  it("keeps lockfile-independent layers ahead of the lockfile COPY", () => {
    // Everything after the workspace-lockfile COPY rebuilds on any dependency
    // change in the repo. The plugin bundles read only their own manifests, and
    // the 329 MB GGUF download lives in its own stage.
    const builder = stage("builder");
    const lockfileCopy = builder.search(/^COPY [^\n]*pnpm-lock\.yaml/m);
    expect(lockfileCopy).toBeGreaterThan(-1);
    const pluginInstalls = [...builder.matchAll(/npm install --omit=dev/g)].map((m) => m.index);
    expect(pluginInstalls.length).toBeGreaterThanOrEqual(4);
    for (const at of pluginInstalls) expect(at).toBeLessThan(lockfileCopy);
    expect(builder).not.toMatch(/\.gguf/);
    expect(stage("embedding-model")).toMatch(/curl [^\n]*\n?[^\n]*-o \S+\.gguf/);
  });

  it("ships only node_modules into the runtime, not the install inputs", () => {
    const copies = [
      ...stage("runtime").matchAll(/^COPY --from=builder (\/opt\/openclaw\S*)/gm),
    ].map((m) => m[1]);
    expect(copies.length).toBeGreaterThan(0);
    for (const source of copies) expect(source).toMatch(/\/node_modules$/);
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
