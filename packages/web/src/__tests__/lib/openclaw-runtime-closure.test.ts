/**
 * The OpenClaw runtime's dependency closure stays inside the ranges its
 * packages declare.
 *
 * Dockerfile.openclaw installs packages/openclaw-runtime from pnpm-lock.yaml, so
 * the root `pnpm.overrides` now govern the production gateway. They were written
 * for the dev tree, and a version-range override has no notion of the
 * dependent's declared major: `protobufjs@<7.5.8: ">=7.5.8"` handed
 * @google/genai (which declares ^7.5.4) protobufjs 8.7.1. That one happened to
 * be harmless — and nothing would have said so either way, because the gateway
 * code that breaks on a foreign major runs nowhere in this suite.
 *
 * So this walks the INSTALLED closure — the same Node resolution the gateway
 * uses — and fails when a resolved version lands in a different major than the
 * dependent asked for. Exact-pin overrides that stay in-major (undici 8.5.0 ->
 * 8.12.2) are what overrides are for and pass. A deliberate cross-major
 * override needs an entry in ACCEPTED_CROSS_MAJOR with its reason, and an entry
 * whose edge no longer exists fails too.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import semver from "semver";

const REPO_ROOT = resolve(__dirname, "../../../../..");
const RUNTIME_OPENCLAW = join(REPO_ROOT, "packages/openclaw-runtime/node_modules/openclaw");

type Manifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

/** `<dependent name>><dependency name>` → why crossing the major is intended. */
const ACCEPTED_CROSS_MAJOR: Record<string, string> = {
  "ajv>fast-uri":
    "Root override `ajv>fast-uri` (3b7278ddb) moves ajv@8's fast-uri to 4.x on purpose to clear the 4.x advisory line. Measured 2026-10-21: ajv 8.20.0's $ref resolution works on fast-uri 4.2.2.",
};

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
}

/** Node's lookup: walk up from the dependent's real directory. */
function resolveDependency(fromDir: string, name: string): string | null {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

type Edge = { from: string; to: string; range: string; resolved: string };

function closureEdges(root: string): { packages: number; edges: Edge[] } {
  const seen = new Set<string>();
  const queue = [realpathSync(root)];
  const edges: Edge[] = [];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    const manifest = readManifest(dir);
    const declared = { ...manifest.dependencies, ...manifest.optionalDependencies };
    for (const [name, range] of Object.entries(declared)) {
      const target = resolveDependency(dir, name);
      if (!target) continue; // an optional dependency for another platform
      queue.push(target);
      edges.push({
        from: `${manifest.name}@${manifest.version}`,
        to: name,
        range,
        resolved: readManifest(target).version,
      });
    }
  }
  return { packages: seen.size, edges };
}

function crossesMajor(edge: Edge): boolean {
  // `npm:` aliases, tags, URLs: not a semver range, nothing to compare.
  if (!semver.validRange(edge.range)) return false;
  if (semver.satisfies(edge.resolved, edge.range, { includePrerelease: true })) return false;
  const floor = semver.minVersion(edge.range);
  if (!floor) return false;
  const major = (v: string) =>
    semver.major(v) === 0 ? `0.${semver.minor(v)}` : `${semver.major(v)}`;
  return major(edge.resolved) !== major(floor.version);
}

const nameOf = (spec: string) => spec.slice(0, spec.lastIndexOf("@"));

describe("OpenClaw runtime closure", () => {
  const { packages, edges } = closureEdges(RUNTIME_OPENCLAW);

  it("walks a real install", () => {
    // A broken walk would find nothing and pass everything below.
    expect(packages).toBeGreaterThan(200);
  });

  it("resolves every dependency inside the major its dependent declared", () => {
    const offenders = edges
      .filter(crossesMajor)
      .filter((e) => !(`${nameOf(e.from)}>${e.to}` in ACCEPTED_CROSS_MAJOR))
      .map((e) => `${e.from} declares ${e.to}@${e.range}, gets ${e.resolved}`);
    expect(offenders).toEqual([]);
  });

  it("has no acceptance for an edge that no longer crosses a major", () => {
    const live = new Set(edges.filter(crossesMajor).map((e) => `${nameOf(e.from)}>${e.to}`));
    const stale = Object.keys(ACCEPTED_CROSS_MAJOR).filter((key) => !live.has(key));
    expect(stale).toEqual([]);
  });
});
