import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDiagnosticsVersions, readOpenclawNodeVersionFrom } from "@/lib/diagnostics/versions";

const ENV_KEYS = ["NEXT_PUBLIC_PINCHY_VERSION", "NEXT_PUBLIC_OPENCLAW_VERSION"] as const;
const original: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    original[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe("getDiagnosticsVersions", () => {
  it("reads pinchy and openclaw versions from env vars", () => {
    process.env.NEXT_PUBLIC_PINCHY_VERSION = "1.2.3";
    process.env.NEXT_PUBLIC_OPENCLAW_VERSION = "2026.5.7";

    const versions = getDiagnosticsVersions();
    expect(versions.pinchy).toBe("1.2.3");
    expect(versions.openclaw).toBe("2026.5.7");
  });

  it("falls back to 'unknown' when env vars are missing", () => {
    const versions = getDiagnosticsVersions();
    expect(versions.pinchy).toBe("unknown");
    expect(versions.openclaw).toBe("unknown");
  });

  it("reads openclawNode from the openclaw-node package metadata", () => {
    const versions = getDiagnosticsVersions();
    // Match a semver-shaped string (e.g. "0.9.0"). The exact value depends on
    // the lockfile; if the package can't be resolved at all we'd see
    // "unknown", which would also be a failure here.
    expect(versions.openclawNode).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("readOpenclawNodeVersionFrom (bundler-proof path strategy)", () => {
  // The createRequire-based resolution silently broke in the production
  // bundle: webpack statically rewrites `require.resolve("openclaw-node")`
  // (the local was named `require`), so dirname() threw and the route
  // degraded to "unknown" — the v0.5.7 staging finding. This strategy reads
  // <baseDir>/node_modules/openclaw-node/package.json directly off the
  // filesystem, which no bundler can interfere with.
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pinchy-versions-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writePkg(content: unknown) {
    const pkgDir = join(dir, "node_modules", "openclaw-node");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify(content));
  }

  it("reads the version from <baseDir>/node_modules/openclaw-node/package.json", () => {
    writePkg({ name: "openclaw-node", version: "0.12.1" });
    expect(readOpenclawNodeVersionFrom(dir)).toBe("0.12.1");
  });

  it("returns null when the package.json is missing", () => {
    expect(readOpenclawNodeVersionFrom(dir)).toBeNull();
  });

  it("returns null when the package.json belongs to a different package", () => {
    writePkg({ name: "something-else", version: "9.9.9" });
    expect(readOpenclawNodeVersionFrom(dir)).toBeNull();
  });

  it("returns null when the version field is missing or not a string", () => {
    writePkg({ name: "openclaw-node", version: 42 });
    expect(readOpenclawNodeVersionFrom(dir)).toBeNull();
  });

  it("is used by getDiagnosticsVersions: the real package resolves from cwd", () => {
    // process.cwd() in vitest is packages/web — the same layout the
    // production container has (/app/packages/web), verified on staging.
    expect(readOpenclawNodeVersionFrom(process.cwd())).toMatch(/^\d+\.\d+\.\d+/);
  });
});
