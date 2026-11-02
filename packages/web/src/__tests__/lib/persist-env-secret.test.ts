import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

  it("leaves even a corrupt key file untouched", () => {
    writeFileSync(keyFile, "not a key", { mode: 0o600 });
    process.env.AUDIT_HMAC_SECRET = KEY_A;

    expect(persistEnvSecretToKeyFile(NAME)).toEqual({ status: "file-exists" });
    expect(readFileSync(keyFile, "utf-8")).toBe("not a key");
  });

  it("does nothing when the variable is unset, so the generated-file path is unchanged", () => {
    expect(persistEnvSecretToKeyFile(NAME)).toEqual({ status: "not-envvar" });
    expect(existsSync(keyFile)).toBe(false);

    // getOrCreateSecret still generates the file on first use, as before.
    const generated = getOrCreateSecret(NAME);
    expect(readFileSync(keyFile, "utf-8")).toBe(generated.toString("hex"));
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
