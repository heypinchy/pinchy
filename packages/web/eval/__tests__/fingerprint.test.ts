import { describe, expect, it } from "vitest";
import { buildRunFingerprint, type VersionResponse } from "../fingerprint";

const version: VersionResponse = {
  pinchyVersion: "0.8.0",
  openclawVersion: "2026.7.1",
  build: "a1b2c3d4e5f6",
  nodeEnv: "production",
};

const cleanGit = { sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", dirty: false };
const AT = "2026-07-17T12:00:00.000Z";

describe("buildRunFingerprint", () => {
  it("carries every field a version-regression comparison needs", () => {
    const fp = buildRunFingerprint(version, cleanGit, AT);
    expect(fp).toMatchObject({
      pinchyVersion: "0.8.0",
      openclawVersion: "2026.7.1",
      build: "a1b2c3d4e5f6",
      nodeEnv: "production",
      harnessSha: cleanGit.sha,
      harnessDirty: false,
      sweptAt: AT,
    });
  });

  it("is comparable when the platform build and the harness are both pinned", () => {
    expect(buildRunFingerprint(version, cleanGit, AT).comparable).toBe(true);
  });

  it("is NOT comparable when the stack reports build 'dev' (no PINCHY_BUILD_SHA)", () => {
    // The exact case observed locally: /api/version returns build:"dev", so two
    // different builds of 0.8.0 are indistinguishable. A sweep on this build may
    // be published, but it cannot anchor a cross-version regression baseline.
    const fp = buildRunFingerprint({ ...version, build: "dev" }, cleanGit, AT);
    expect(fp.comparable).toBe(false);
  });

  it("is NOT comparable when the harness tree is dirty", () => {
    // Uncommitted harness changes mean the code that produced the numbers is not
    // recoverable from a git sha — the sha names a tree that never ran.
    const fp = buildRunFingerprint(version, { ...cleanGit, dirty: true }, AT);
    expect(fp.comparable).toBe(false);
  });

  it("is NOT comparable when a version field is missing", () => {
    const fp = buildRunFingerprint({ ...version, pinchyVersion: undefined }, cleanGit, AT);
    expect(fp.pinchyVersion).toBe("unknown");
    expect(fp.comparable).toBe(false);
  });

  it("fills missing fields with 'unknown' rather than throwing", () => {
    const fp = buildRunFingerprint({}, { sha: "", dirty: false }, AT);
    expect(fp.pinchyVersion).toBe("unknown");
    expect(fp.openclawVersion).toBe("unknown");
    expect(fp.build).toBe("unknown");
    expect(fp.nodeEnv).toBe("unknown");
    expect(fp.harnessSha).toBe("unknown");
    expect(fp.comparable).toBe(false);
  });
});
