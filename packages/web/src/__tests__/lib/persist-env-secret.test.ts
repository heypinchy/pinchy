import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Real filesystem, with two switchable faults for the key-generation tests
// below: a disk that fills up mid-write, and another process winning the race
// to create the key file. Off by default, so every other test sees plain fs.
const faults = vi.hoisted(() => ({ diskFull: false, rivalKey: null as string | null }));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const enospc = () =>
    Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  const patched = {
    ...actual,
    // A full disk lets open() create the file and then fails the write, which
    // is what leaves a 0-byte file behind when the write goes to the final path.
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      if (faults.diskFull) {
        actual.closeSync(actual.openSync(args[0] as string, "w"));
        throw enospc();
      }
      return actual.writeFileSync(...args);
    }) as typeof actual.writeFileSync,
    writeSync: ((...args: unknown[]) => {
      if (faults.diskFull) throw enospc();
      return (actual.writeSync as (...a: unknown[]) => number)(...args);
    }) as typeof actual.writeSync,
    linkSync: ((existing: string, target: string) => {
      if (faults.rivalKey !== null) actual.writeFileSync(target, faults.rivalKey, { mode: 0o600 });
      return actual.linkSync(existing, target);
    }) as typeof actual.linkSync,
  };
  return { ...patched, default: patched };
});

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { persistEnvSecretToKeyFile, getPreviousSecret, getOrCreateSecret } from "@/lib/encryption";

// The earlier key Pinchy verifies against is always the key FILE
// (getPreviousSecret). An install that pinned AUDIT_HMAC_SECRET from day one
// never had that file, so switching the variable to a new value left every
// earlier entry verifying under no key at all. Writing the variable's value
// into the file at startup makes the next switch safe by construction.
//
// Real filesystem on purpose: the properties under test (mode 0600, no
// overwrite, no leftover temp file) are what the filesystem does, not what a
// mock was told to say.

const NAME = "audit_hmac_secret";
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

describe("persistEnvSecretToKeyFile", () => {
  let dir: string;
  let keyFile: string;
  const savedDir = process.env.ENCRYPTION_KEY_DIR;
  const savedSecret = process.env.AUDIT_HMAC_SECRET;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pinchy-keyfile-"));
    keyFile = join(dir, `.${NAME}`);
    process.env.ENCRYPTION_KEY_DIR = dir;
    delete process.env.AUDIT_HMAC_SECRET;
  });

  afterEach(() => {
    faults.diskFull = false;
    faults.rivalKey = null;
    rmSync(dir, { recursive: true, force: true });
    if (savedDir === undefined) delete process.env.ENCRYPTION_KEY_DIR;
    else process.env.ENCRYPTION_KEY_DIR = savedDir;
    if (savedSecret === undefined) delete process.env.AUDIT_HMAC_SECRET;
    else process.env.AUDIT_HMAC_SECRET = savedSecret;
  });

  it("writes the variable's value to the key file when no file exists", () => {
    process.env.AUDIT_HMAC_SECRET = KEY_A;

    expect(persistEnvSecretToKeyFile(NAME)).toEqual({ status: "written" });

    // Same format as the file Pinchy generates: 64 lowercase hex, no newline.
    expect(readFileSync(keyFile, "utf-8")).toBe(KEY_A);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    // Atomic write: the temporary file it went through is gone.
    expect(readdirSync(dir)).toEqual([`.${NAME}`]);
  });

  it("writes the same format as a generated file even for an uppercase variable", () => {
    process.env.AUDIT_HMAC_SECRET = "AB".repeat(32);

    persistEnvSecretToKeyFile(NAME);

    expect(readFileSync(keyFile, "utf-8")).toBe("ab".repeat(32));
  });

  it("makes a later switch of the variable keep the old key as the earlier key", () => {
    // The point of the whole change: before it, this returned null and every
    // entry signed with KEY_A verified under no key after the switch.
    process.env.AUDIT_HMAC_SECRET = KEY_A;
    persistEnvSecretToKeyFile(NAME);
    expect(getPreviousSecret(NAME)).toBeNull();

    process.env.AUDIT_HMAC_SECRET = KEY_B;
    expect(getPreviousSecret(NAME)?.toString("hex")).toBe(KEY_A);
  });

  it("never overwrites an existing key file holding a different key", () => {
    // That file is the earlier key. Overwriting it would destroy the only way
    // to verify the entries signed with it.
    writeFileSync(keyFile, KEY_A, { mode: 0o600 });
    process.env.AUDIT_HMAC_SECRET = KEY_B;

    expect(persistEnvSecretToKeyFile(NAME)).toEqual({ status: "file-exists" });
    expect(readFileSync(keyFile, "utf-8")).toBe(KEY_A);
  });

  it("leaves a key file holding the same key untouched", () => {
    writeFileSync(keyFile, KEY_A + "\n", { mode: 0o600 });
    process.env.AUDIT_HMAC_SECRET = KEY_A;

    expect(persistEnvSecretToKeyFile(NAME)).toEqual({ status: "file-exists" });
    expect(readFileSync(keyFile, "utf-8")).toBe(KEY_A + "\n");
  });

  it("leaves a corrupt key file untouched, but reports it as invalid rather than as a saved key", () => {
    // "file-exists" is silent, and a corrupt file is not a key anything can
    // verify against. Reporting it as present would let an operator switch the
    // variable believing the current value is kept, and lose it.
    writeFileSync(keyFile, "not a key", { mode: 0o600 });
    process.env.AUDIT_HMAC_SECRET = KEY_A;

    expect(persistEnvSecretToKeyFile(NAME)).toEqual({ status: "file-invalid" });
    expect(readFileSync(keyFile, "utf-8")).toBe("not a key");
  });

  it("reports an empty key file as invalid and leaves it in place", () => {
    // What a disk that filled up during an earlier, non-atomic write leaves.
    writeFileSync(keyFile, "", { mode: 0o600 });
    process.env.AUDIT_HMAC_SECRET = KEY_A;

    const outcome = persistEnvSecretToKeyFile(NAME);

    expect(outcome).toEqual({ status: "file-invalid" });
    expect(readFileSync(keyFile, "utf-8")).toBe("");
  });

  it("removes temp files a crash left behind, and nothing else", () => {
    // A crash between writing the temp file and unlinking it leaves a copy of
    // the key next to the key file, and nothing would ever clean it up.
    process.env.AUDIT_HMAC_SECRET = KEY_A;
    const stale = [`.${NAME}.4242.deadbeef.tmp`, `.${NAME}.1.0123abcd.tmp`];
    for (const f of stale) writeFileSync(join(dir, f), KEY_B, { mode: 0o600 });
    const kept = [
      `.${NAME}.backup`,
      `.${NAME}.tmp`,
      `.${NAME}.4242.deadbeef.tmp.keep`,
      `.encryption_key.4242.deadbeef.tmp`,
      "other.tmp",
    ];
    for (const f of kept) writeFileSync(join(dir, f), "x");

    expect(persistEnvSecretToKeyFile(NAME)).toEqual({ status: "written" });

    expect(readdirSync(dir).sort()).toEqual([`.${NAME}`, ...kept].sort());
  });

  it("removes a stale temp file also when the key file is already in place", () => {
    // The crash can land between link and unlink: the key file is written and
    // the temp copy is still there.
    writeFileSync(keyFile, KEY_A, { mode: 0o600 });
    writeFileSync(join(dir, `.${NAME}.77.cafef00d.tmp`), KEY_A, { mode: 0o600 });
    process.env.AUDIT_HMAC_SECRET = KEY_A;

    expect(persistEnvSecretToKeyFile(NAME)).toEqual({ status: "file-exists" });

    expect(readdirSync(dir)).toEqual([`.${NAME}`]);
  });

  it("does nothing when the variable is unset, so the generated-file path is unchanged", () => {
    expect(persistEnvSecretToKeyFile(NAME)).toEqual({ status: "not-envvar" });
    expect(existsSync(keyFile)).toBe(false);

    // getOrCreateSecret still generates the file on first use, as before.
    const generated = getOrCreateSecret(NAME);
    expect(readFileSync(keyFile, "utf-8")).toBe(generated.toString("hex"));
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual([`.${NAME}`]);
  });

  it("does nothing when the variable is not a valid key (it never becomes active)", () => {
    process.env.AUDIT_HMAC_SECRET = "too-short";

    expect(persistEnvSecretToKeyFile(NAME)).toEqual({ status: "not-envvar" });
    expect(existsSync(keyFile)).toBe(false);
  });

  it("reports a failed write instead of throwing", () => {
    // Fail open: a startup step that cannot write a file must never hold the
    // install down. The caller logs the reason.
    process.env.ENCRYPTION_KEY_DIR = join(dir, "does-not-exist");
    process.env.AUDIT_HMAC_SECRET = KEY_A;

    const outcome = persistEnvSecretToKeyFile(NAME);

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.reason).toMatch(/ENOENT/);
    // The reason is the error code and path, never the key.
    expect(JSON.stringify(outcome)).not.toContain(KEY_A);
  });
});

describe("getOrCreateSecret writing a generated key", () => {
  // The generated key file is the active key from its first write on. A write
  // that leaves a 0-byte file, or that replaces a key another process already
  // signed with, takes every later audit write down or signs with a key that
  // is gone. So it is written the same way as the persisted variable: temp
  // file, fsync, then a non-clobbering link.
  let dir: string;
  let keyFile: string;
  const savedDir = process.env.ENCRYPTION_KEY_DIR;
  const savedSecret = process.env.AUDIT_HMAC_SECRET;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pinchy-keygen-"));
    keyFile = join(dir, `.${NAME}`);
    process.env.ENCRYPTION_KEY_DIR = dir;
    delete process.env.AUDIT_HMAC_SECRET;
  });

  afterEach(() => {
    faults.diskFull = false;
    faults.rivalKey = null;
    rmSync(dir, { recursive: true, force: true });
    if (savedDir === undefined) delete process.env.ENCRYPTION_KEY_DIR;
    else process.env.ENCRYPTION_KEY_DIR = savedDir;
    if (savedSecret === undefined) delete process.env.AUDIT_HMAC_SECRET;
    else process.env.AUDIT_HMAC_SECRET = savedSecret;
  });

  it("leaves no key file at all when the disk is full, so the next attempt can generate one", () => {
    faults.diskFull = true;

    expect(() => getOrCreateSecret(NAME)).toThrow(/ENOSPC/);
    expect(readdirSync(dir)).toEqual([]);

    faults.diskFull = false;
    const generated = getOrCreateSecret(NAME);
    expect(readFileSync(keyFile, "utf-8")).toBe(generated.toString("hex"));
  });

  it("uses the key another process wrote first instead of replacing it", () => {
    faults.rivalKey = KEY_B;

    const key = getOrCreateSecret(NAME);

    expect(key.toString("hex")).toBe(KEY_B);
    expect(readFileSync(keyFile, "utf-8")).toBe(KEY_B);
    expect(readdirSync(dir)).toEqual([`.${NAME}`]);
  });
});
