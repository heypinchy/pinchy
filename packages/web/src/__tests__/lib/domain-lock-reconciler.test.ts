import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reconcileDomainLockFlag,
  domainLockFlagPath,
} from "../../../scripts/lib/domain-lock-reconciler.mjs";
import { shouldUseSecureCookies, domainLockFlagPath as readerFlagPath } from "@/lib/secure-cookies";

// The Secure-cookie decision (`useSecureCookies` -> Better Auth's `__Secure-`
// cookie NAME prefix) is read by auth.ts at MODULE IMPORT, which — via
// server.ts -> ws-auth -> @/lib/auth — happens BEFORE in-process bootInits can
// write the flag. So the flag must already be on disk at process start. The
// entrypoint runner reconciles it from the `domain` DB setting BEFORE `node`
// starts; this reconciler is its pure, testable core. These tests pin that the
// reconciler's on-disk output is byte-for-byte what the runtime reader honors.

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pinchy-domain-lock-"));
  prev = process.env.ENCRYPTION_KEY_DIR;
});

afterEach(() => {
  if (prev === undefined) delete process.env.ENCRYPTION_KEY_DIR;
  else process.env.ENCRYPTION_KEY_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("reconcileDomainLockFlag", () => {
  it("writes the flag (secure mode) when a domain is locked", () => {
    const result = reconcileDomainLockFlag({ domain: "pinchy.example.com", secretsDir: dir });
    expect(result.locked).toBe(true);
    expect(existsSync(domainLockFlagPath(dir))).toBe(true);
    expect(readFileSync(domainLockFlagPath(dir), "utf8")).toBe("pinchy.example.com\n");
  });

  it("removes the flag (insecure mode) when no domain is set", () => {
    reconcileDomainLockFlag({ domain: "pinchy.example.com", secretsDir: dir });
    const result = reconcileDomainLockFlag({ domain: null, secretsDir: dir });
    expect(result.locked).toBe(false);
    expect(existsSync(domainLockFlagPath(dir))).toBe(false);
  });

  it("treats a whitespace-only domain as not locked", () => {
    const result = reconcileDomainLockFlag({ domain: "   ", secretsDir: dir });
    expect(result.locked).toBe(false);
    expect(existsSync(domainLockFlagPath(dir))).toBe(false);
  });

  it("is idempotent when the flag is already removed", () => {
    const result = reconcileDomainLockFlag({ domain: null, secretsDir: dir });
    expect(result.locked).toBe(false);
    expect(existsSync(domainLockFlagPath(dir))).toBe(false);
  });

  it("never throws and reports a warning when the secrets dir cannot be created", () => {
    // Parent is a regular file -> mkdirSync fails with ENOTDIR (terminal). Do
    // NOT use a /proc/<x> path: on Linux + Node 22 a recursive mkdir of a
    // non-creatable /proc child infinite-loops in MKDirpSync instead of failing
    // fast, which previously hung CI for 6h (#558).
    const blockingFile = join(dir, "blocking-file");
    writeFileSync(blockingFile, "x");
    const result = reconcileDomainLockFlag({
      domain: "pinchy.example.com",
      secretsDir: join(blockingFile, "secrets"),
    });
    expect(result.locked).toBe(null);
    expect(result.warning).toBeTruthy();
  });
});

describe("reconciler <-> runtime reader parity (drift guard)", () => {
  it("targets the exact path the runtime reader reads", () => {
    process.env.ENCRYPTION_KEY_DIR = dir;
    // secure-cookies.ts resolves the path from ENCRYPTION_KEY_DIR; the
    // reconciler takes it explicitly. They must agree on dir + filename.
    expect(readerFlagPath()).toBe(domainLockFlagPath(dir));
  });

  it("a flag written by the reconciler makes shouldUseSecureCookies() true", () => {
    process.env.ENCRYPTION_KEY_DIR = dir;
    reconcileDomainLockFlag({ domain: "pinchy.example.com", secretsDir: dir });
    expect(shouldUseSecureCookies()).toBe(true);
  });

  it("after the reconciler clears the flag, shouldUseSecureCookies() is false", () => {
    process.env.ENCRYPTION_KEY_DIR = dir;
    reconcileDomainLockFlag({ domain: "pinchy.example.com", secretsDir: dir });
    reconcileDomainLockFlag({ domain: null, secretsDir: dir });
    expect(shouldUseSecureCookies()).toBe(false);
  });
});
