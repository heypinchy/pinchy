import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDiagnosticsVersions } from "@/lib/diagnostics/versions";

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
