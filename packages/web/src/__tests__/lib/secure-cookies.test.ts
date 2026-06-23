import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  shouldUseSecureCookies,
  writeDomainLockFlag,
  domainLockFlagPath,
} from "@/lib/secure-cookies";

// The session cookie's `Secure` flag -- and therefore Better Auth's `__Secure-`
// cookie NAME prefix -- must be DETERMINISTIC across container restarts. The old
// code derived it from an async-loaded in-memory domain cache read once at
// module-import time, so the value flipped between deploys and the cookie name
// changed, logging every user out on each update. These tests pin the
// replacement: a synchronously-readable persistent flag mirroring the
// domain-lock state, so the value is stable and survives restarts.

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pinchy-secure-cookies-"));
  prev = process.env.ENCRYPTION_KEY_DIR;
  process.env.ENCRYPTION_KEY_DIR = dir;
});

afterEach(() => {
  if (prev === undefined) delete process.env.ENCRYPTION_KEY_DIR;
  else process.env.ENCRYPTION_KEY_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("shouldUseSecureCookies", () => {
  it("is false (insecure default) when no domain-lock flag exists", () => {
    expect(shouldUseSecureCookies()).toBe(false);
  });

  it("is true once a domain is persisted (locked = HTTPS/secure mode)", () => {
    writeDomainLockFlag("pinchy.example.com");
    expect(shouldUseSecureCookies()).toBe(true);
  });

  it("is false again after the lock is removed (domain = null)", () => {
    writeDomainLockFlag("pinchy.example.com");
    writeDomainLockFlag(null);
    expect(shouldUseSecureCookies()).toBe(false);
  });

  it("is deterministic across repeated reads (no flip)", () => {
    writeDomainLockFlag("pinchy.example.com");
    const a = shouldUseSecureCookies();
    const b = shouldUseSecureCookies();
    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  it("treats an empty/whitespace flag file as not-locked", () => {
    writeFileSync(domainLockFlagPath(), "   \n");
    expect(shouldUseSecureCookies()).toBe(false);
  });

  it("never throws and returns false when the secrets dir is unreadable", () => {
    // Point the secrets dir BELOW a regular file so every fs call fails with
    // ENOTDIR. Do NOT use a /proc/<x> path here: on Linux + Node 22 a recursive
    // mkdir of a non-creatable /proc child infinite-loops in MKDirpSync instead
    // of failing fast, which hung CI for 6h on this PR (#558).
    const blockingFile = join(dir, "blocking-file");
    writeFileSync(blockingFile, "x");
    process.env.ENCRYPTION_KEY_DIR = join(blockingFile, "secrets");
    expect(() => shouldUseSecureCookies()).not.toThrow();
    expect(shouldUseSecureCookies()).toBe(false);
  });
});

describe("writeDomainLockFlag", () => {
  it("ignores an empty-string domain (treated as unlocked)", () => {
    writeDomainLockFlag("   ");
    expect(shouldUseSecureCookies()).toBe(false);
  });

  it("never throws when the target dir cannot be created", () => {
    // Parent is a regular file -> mkdirSync fails with ENOTDIR (terminal).
    // Avoid a /proc/<x> path: on Linux + Node 22, mkdirSync(path, { recursive:
    // true }) of a non-creatable /proc child infinite-loops in MKDirpSync
    // instead of throwing, which hung CI for 6h on this PR (#558).
    const blockingFile = join(dir, "blocking-file");
    writeFileSync(blockingFile, "x");
    process.env.ENCRYPTION_KEY_DIR = join(blockingFile, "secrets");
    expect(() => writeDomainLockFlag("pinchy.example.com")).not.toThrow();
    expect(() => writeDomainLockFlag(null)).not.toThrow();
  });
});
