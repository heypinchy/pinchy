import { describe, expect, it } from "vitest";
import { buildRunFingerprint, parseVersionResponse, type VersionResponse } from "../fingerprint";

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

  it("trims surrounding whitespace so a padded-but-valid build stays comparable", () => {
    const fp = buildRunFingerprint(
      { ...version, pinchyVersion: "  0.8.0  ", build: " a1b2c3d4e5f6 " },
      cleanGit,
      AT
    );
    expect(fp.pinchyVersion).toBe("0.8.0");
    expect(fp.build).toBe("a1b2c3d4e5f6");
    expect(fp.comparable).toBe(true);
  });

  it("treats a whitespace-only field as unknown, not comparable", () => {
    const fp = buildRunFingerprint({ ...version, build: "   " }, cleanGit, AT);
    expect(fp.build).toBe("unknown");
    expect(fp.comparable).toBe(false);
  });
});

describe("parseVersionResponse", () => {
  it("keeps the four known string fields", () => {
    expect(
      parseVersionResponse({
        pinchyVersion: "0.8.0",
        openclawVersion: "2026.7.1",
        build: "a1b2c3d4e5f6",
        nodeEnv: "production",
      })
    ).toEqual({
      pinchyVersion: "0.8.0",
      openclawVersion: "2026.7.1",
      build: "a1b2c3d4e5f6",
      nodeEnv: "production",
    });
  });

  it("drops non-string fields to undefined rather than trusting their shape", () => {
    const parsed = parseVersionResponse({
      pinchyVersion: 42,
      openclawVersion: { nested: "object" },
      build: ["a"],
      nodeEnv: null,
    });
    expect(parsed).toEqual({
      pinchyVersion: undefined,
      openclawVersion: undefined,
      build: undefined,
      nodeEnv: undefined,
    });
  });

  it("caps each field at 120 chars so a rogue body can't bloat the scorecard", () => {
    const parsed = parseVersionResponse({ pinchyVersion: "x".repeat(500) });
    expect(parsed.pinchyVersion).toHaveLength(120);
  });

  it("ignores extra keys and never surfaces the raw object", () => {
    const parsed = parseVersionResponse({ pinchyVersion: "0.8.0", evil: "ignored" });
    expect(parsed).not.toHaveProperty("evil");
  });

  it("returns all-undefined for a non-object body rather than throwing", () => {
    for (const body of [null, undefined, "string", 7, []]) {
      expect(parseVersionResponse(body)).toEqual({
        pinchyVersion: undefined,
        openclawVersion: undefined,
        build: undefined,
        nodeEnv: undefined,
      });
    }
  });
});
