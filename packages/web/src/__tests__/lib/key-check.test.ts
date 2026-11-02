import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { inspectSecret } from "@/lib/encryption";
import { describeKeyCheck, runKeyCheck } from "@/lib/key-check";

// Real filesystem in a temp key directory: the check exists to say what
// Pinchy's startup will find, so it has to read files the way startup does.

const K1 = "a".repeat(64);
const K2 = "b".repeat(64);
const K1_UPPER = K1.toUpperCase();

let dir: string;
const saved = {
  dir: process.env.ENCRYPTION_KEY_DIR,
  audit: process.env.AUDIT_HMAC_SECRET,
  enc: process.env.ENCRYPTION_KEY,
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pinchy-key-check-"));
  process.env.ENCRYPTION_KEY_DIR = dir;
  delete process.env.AUDIT_HMAC_SECRET;
  delete process.env.ENCRYPTION_KEY;
});

afterEach(() => {
  try {
    chmodSync(join(dir, ".audit_hmac_secret"), 0o600);
  } catch {
    // Not every test leaves an unreadable file behind.
  }
  rmSync(dir, { recursive: true, force: true });
  restore("ENCRYPTION_KEY_DIR", saved.dir);
  restore("AUDIT_HMAC_SECRET", saved.audit);
  restore("ENCRYPTION_KEY", saved.enc);
});

const auditFile = () => join(dir, ".audit_hmac_secret");
const encFile = () => join(dir, ".encryption_key");

describe("inspectSecret", () => {
  it("reports an unset variable and a missing file", () => {
    expect(inspectSecret("audit_hmac_secret")).toEqual({
      variable: { status: "unset" },
      file: { status: "missing" },
    });
  });

  it("treats an empty variable as unset, the way docker-compose.yml passes it", () => {
    process.env.AUDIT_HMAC_SECRET = "";
    expect(inspectSecret("audit_hmac_secret").variable).toEqual({ status: "unset" });
  });

  it("says the file holds the same key, whatever its case and trailing line break", () => {
    process.env.AUDIT_HMAC_SECRET = K1;
    writeFileSync(auditFile(), `${K1_UPPER}\r\n`);
    expect(inspectSecret("audit_hmac_secret")).toEqual({
      variable: { status: "valid" },
      file: { status: "same" },
    });
  });

  it("says the file holds a different key: the earlier key", () => {
    process.env.AUDIT_HMAC_SECRET = K2;
    writeFileSync(auditFile(), K1);
    expect(inspectSecret("audit_hmac_secret").file).toEqual({ status: "different" });
  });

  it("says a file of 63 hex characters is not a key", () => {
    process.env.AUDIT_HMAC_SECRET = K2;
    writeFileSync(auditFile(), K1.slice(1));
    expect(inspectSecret("audit_hmac_secret").file).toEqual({ status: "invalid" });
  });

  it("says an empty file is not a key", () => {
    writeFileSync(auditFile(), "");
    expect(inspectSecret("audit_hmac_secret").file).toEqual({ status: "invalid" });
  });

  it("says a quoted key in the file is not a key", () => {
    writeFileSync(auditFile(), `"${K1}"`);
    expect(inspectSecret("audit_hmac_secret").file).toEqual({ status: "invalid" });
  });

  it("says a directory in the file's place can't be read, with the code", () => {
    process.env.AUDIT_HMAC_SECRET = K2;
    mkdirSync(auditFile());
    expect(inspectSecret("audit_hmac_secret").file).toEqual({
      status: "unreadable",
      code: "EISDIR",
    });
  });

  it.skipIf(process.getuid?.() === 0)("says a file it may not read can't be read (EACCES)", () => {
    process.env.AUDIT_HMAC_SECRET = K2;
    writeFileSync(auditFile(), K1);
    chmodSync(auditFile(), 0o000);
    expect(inspectSecret("audit_hmac_secret").file).toEqual({
      status: "unreadable",
      code: "EACCES",
    });
  });

  it("says the file holds a key when the variable is not in effect", () => {
    writeFileSync(auditFile(), K1);
    expect(inspectSecret("audit_hmac_secret")).toEqual({
      variable: { status: "unset" },
      file: { status: "key" },
    });
  });

  it.each([
    ["a 0x prefix", `0x${K1}`, "0x-prefix"],
    ["a 0x prefix on 62 hex characters", `0x${K1.slice(2)}`, "0x-prefix"],
    ["63 characters", K1.slice(1), "length"],
    ["65 characters", `${K1}a`, "length"],
    ["quotes", `"${K1}"`, "not-hex"],
    ["a trailing carriage return", `${K1}\r`, "not-hex"],
    ["spaces only", "   ", "not-hex"],
  ])("says why a variable with %s is ignored", (_label, value, reason) => {
    process.env.AUDIT_HMAC_SECRET = value;
    writeFileSync(auditFile(), K1);
    expect(inspectSecret("audit_hmac_secret")).toEqual({
      variable: { status: "ignored", reason },
      // An ignored variable is never compared with the file: Pinchy signs with
      // the file, and there is no earlier key.
      file: { status: "key" },
    });
  });

  it("inspects the encryption key the same way", () => {
    process.env.ENCRYPTION_KEY = K1;
    writeFileSync(encFile(), K2);
    expect(inspectSecret("encryption_key")).toEqual({
      variable: { status: "valid" },
      file: { status: "different" },
    });
  });
});

describe("describeKeyCheck for the audit key", () => {
  const check = () => describeKeyCheck("audit_hmac_secret", inspectSecret("audit_hmac_secret"));

  it("names the earlier key when the variable is valid and the file differs", () => {
    process.env.AUDIT_HMAC_SECRET = K2;
    writeFileSync(auditFile(), K1);
    const result = check();
    expect(result.needsAction).toBe(false);
    expect(result.lines).toEqual([
      "AUDIT_HMAC_SECRET: set, a valid key",
      ".audit_hmac_secret: holds a different key than AUDIT_HMAC_SECRET",
      "Pinchy signs audit entries with AUDIT_HMAC_SECRET and accepts the key in .audit_hmac_secret as the earlier key.",
    ]);
  });

  it("says there is no earlier key when both hold the same key", () => {
    process.env.AUDIT_HMAC_SECRET = K1;
    writeFileSync(auditFile(), K1);
    const result = check();
    expect(result.needsAction).toBe(false);
    expect(result.lines[1]).toBe(".audit_hmac_secret: holds the same key as AUDIT_HMAC_SECRET");
    expect(result.lines[2]).toBe(
      "Pinchy signs audit entries with AUDIT_HMAC_SECRET. There is no earlier key."
    );
  });

  it("says Pinchy writes the value to a missing file, and there is no earlier key", () => {
    process.env.AUDIT_HMAC_SECRET = K1;
    const result = check();
    expect(result.needsAction).toBe(false);
    expect(result.lines[1]).toBe(".audit_hmac_secret: no such file");
    expect(result.lines[2]).toBe(
      "Pinchy signs audit entries with AUDIT_HMAC_SECRET and writes it to .audit_hmac_secret when it starts. There is no earlier key."
    );
  });

  it("says Pinchy signs with the file when the variable is not set", () => {
    writeFileSync(auditFile(), K1);
    const result = check();
    expect(result.needsAction).toBe(false);
    expect(result.lines).toEqual([
      "AUDIT_HMAC_SECRET: not set",
      ".audit_hmac_secret: holds a key",
      "Pinchy signs audit entries with the key in .audit_hmac_secret. There is no earlier key.",
    ]);
  });

  // The round-26 finding: a 63-character value next to the earlier key K1
  // used to hash to something that "differs". Pinchy ignores it, signs with
  // K1, and has no earlier key, so this has to read as a stop, not as fine.
  it.each([
    [K1.slice(1), "is not 64 characters long"],
    [`0x${K2}`, "starts with 0x"],
    [`"${K2}"`, "contains characters other than 0-9 and a-f"],
  ])("flags an ignored variable %#, and says Pinchy signs with the file", (value, why) => {
    process.env.AUDIT_HMAC_SECRET = value;
    writeFileSync(auditFile(), K1);
    const result = check();
    expect(result.needsAction).toBe(true);
    expect(result.lines[0]).toBe(
      `AUDIT_HMAC_SECRET: set, but Pinchy ignores it: it ${why}. A valid key is 64 hex characters (0-9, a-f).`
    );
    expect(result.lines[1]).toBe(".audit_hmac_secret: holds a key");
    expect(result.lines[2]).toBe(
      "Fix this before you start Pinchy: it ignores AUDIT_HMAC_SECRET and signs audit entries with the key in .audit_hmac_secret. There is no earlier key."
    );
  });

  it("flags a key file it can't read and says not to remove it", () => {
    process.env.AUDIT_HMAC_SECRET = K2;
    mkdirSync(auditFile());
    const result = check();
    expect(result.needsAction).toBe(true);
    expect(result.lines[1]).toBe(".audit_hmac_secret: can't be read (EISDIR)");
    expect(result.lines[2]).toBe(
      "Fix this before you start Pinchy: it signs audit entries with AUDIT_HMAC_SECRET but can't read .audit_hmac_secret, so it has no earlier key. Don't remove the file, it may be the earlier key: it has to be a file, owned by Pinchy's user (uid 999)."
    );
  });

  it("flags a key file that isn't a key", () => {
    process.env.AUDIT_HMAC_SECRET = K2;
    writeFileSync(auditFile(), K1.slice(1));
    const result = check();
    expect(result.needsAction).toBe(true);
    expect(result.lines[1]).toBe(
      ".audit_hmac_secret: not a valid key (empty, or not 64 hex characters)"
    );
    expect(result.lines[2]).toBe(
      "Fix this before you start Pinchy: it signs audit entries with AUDIT_HMAC_SECRET, but .audit_hmac_secret isn't a key, so it has no earlier key."
    );
  });

  it("flags no key at all: Pinchy would generate a new one", () => {
    const result = check();
    expect(result.needsAction).toBe(true);
    expect(result.lines[2]).toBe(
      "Fix this before you start Pinchy, unless this install has never written an audit entry: there is no audit signing key, so Pinchy generates a new one, and entries signed before can't be verified with it."
    );
  });

  it("flags a key file it would sign with but can't read", () => {
    mkdirSync(auditFile());
    const result = check();
    expect(result.needsAction).toBe(true);
    expect(result.lines[2]).toBe(
      "Fix this before you start Pinchy: it would sign audit entries with .audit_hmac_secret, but can't read it."
    );
  });

  it("flags a key file it would sign with that isn't a key", () => {
    writeFileSync(auditFile(), "");
    const result = check();
    expect(result.needsAction).toBe(true);
    expect(result.lines[2]).toBe(
      "Fix this before you start Pinchy: it would sign audit entries with .audit_hmac_secret, but it isn't a key."
    );
  });
});

describe("describeKeyCheck for the encryption key", () => {
  const check = () => describeKeyCheck("encryption_key", inspectSecret("encryption_key"));

  it("says Pinchy encrypts with a valid variable and doesn't read the file", () => {
    process.env.ENCRYPTION_KEY = K1;
    writeFileSync(encFile(), "not a key");
    const result = check();
    expect(result.needsAction).toBe(false);
    expect(result.lines).toEqual([
      "ENCRYPTION_KEY: set, a valid key",
      ".encryption_key: not a valid key (empty, or not 64 hex characters)",
      "Pinchy encrypts stored credentials with ENCRYPTION_KEY and doesn't read .encryption_key.",
    ]);
  });

  it("says Pinchy encrypts with the file when the variable is not set", () => {
    writeFileSync(encFile(), K1);
    const result = check();
    expect(result.needsAction).toBe(false);
    expect(result.lines[2]).toBe(
      "Pinchy encrypts stored credentials with the key in .encryption_key."
    );
  });

  it("flags no key at all: credentials saved before would be unreadable", () => {
    const result = check();
    expect(result.needsAction).toBe(true);
    expect(result.lines[2]).toBe(
      "Fix this before you start Pinchy, unless this install has never saved a credential: there is no encryption key, so Pinchy generates a new one the first time it encrypts or decrypts something, and credentials saved with an earlier key can't be read."
    );
  });

  it("flags an ignored variable", () => {
    process.env.ENCRYPTION_KEY = `0x${K1}`;
    writeFileSync(encFile(), K2);
    const result = check();
    expect(result.needsAction).toBe(true);
    expect(result.lines[2]).toBe(
      "Fix this before you start Pinchy: it ignores ENCRYPTION_KEY and encrypts stored credentials with the key in .encryption_key."
    );
  });

  it("flags a key file it would encrypt with but can't read", () => {
    mkdirSync(encFile());
    const result = check();
    expect(result.needsAction).toBe(true);
    expect(result.lines[2]).toBe(
      "Fix this before you start Pinchy: it would encrypt stored credentials with .encryption_key, but can't read it."
    );
  });
});

describe("runKeyCheck", () => {
  it("checks both keys and needs no action when both are in place", () => {
    process.env.AUDIT_HMAC_SECRET = K2;
    writeFileSync(auditFile(), K1);
    writeFileSync(encFile(), K2);
    const report = runKeyCheck();
    expect(report.needsAction).toBe(false);
    expect(report.text).toContain("AUDIT_HMAC_SECRET: set, a valid key");
    expect(report.text).toContain("ENCRYPTION_KEY: not set");
  });

  it("needs action when either key does", () => {
    process.env.AUDIT_HMAC_SECRET = K2;
    writeFileSync(auditFile(), K1);
    const report = runKeyCheck();
    expect(report.needsAction).toBe(true);
  });

  it("never prints a key, in any case or state", () => {
    const leaks = (text: string) =>
      [K1, K2].some((k) => text.toLowerCase().includes(k.slice(0, 16)));
    for (const [audit, enc] of [
      [K2, K1_UPPER],
      [`0x${K2}`, K1.slice(1)],
      [`"${K2}"`, ""],
    ]) {
      process.env.AUDIT_HMAC_SECRET = audit;
      process.env.ENCRYPTION_KEY = enc;
      writeFileSync(auditFile(), K1);
      writeFileSync(encFile(), K2);
      expect(leaks(runKeyCheck().text)).toBe(false);
    }
  });
});
