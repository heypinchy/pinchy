import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Real filesystem, with switchable faults for the key-generation tests below:
// a disk that fills up mid-write (everywhere, or only on writes to one path),
// another process winning the race to create the key file, a filesystem
// without hard links, a key file the process may not read, a write that
// accepts only part of the bytes (or none), and a filesystem that refuses to
// fsync a directory. Off by default, so every other test sees plain fs.
const faults = vi.hoisted(() => ({
  diskFull: false,
  diskFullFor: null as string | null,
  rivalKey: null as string | null,
  linkError: null as string | null,
  readError: null as { path: string; code: string } | null,
  readdirCalls: [] as string[],
  // write() may write fewer bytes than asked (a signal, a quota, NFS).
  // The first write (to `path`, when given) writes only `bytes` bytes.
  shortWrite: null as { bytes: number; path?: string } | null,
  zeroWrite: false,
  // Which paths were fsynced, and a directory fsync the filesystem refuses.
  fsyncedPaths: [] as string[],
  dirFsyncError: null as { at: "open" | "fsync"; code: string } | null,
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const errno = (code: string, syscall: string) =>
    Object.assign(new Error(`${code}: simulated, ${syscall}`), { code });
  const enospc = () =>
    Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  // Which path each open descriptor names, so a write can fail for one path.
  const fdPaths = new Map<number, string>();
  const patched = {
    ...actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const [path, flags] = args;
      if (faults.readError && path === faults.readError.path && (flags ?? "r") === "r") {
        throw errno(faults.readError.code, "open");
      }
      if (
        faults.dirFsyncError?.at === "open" &&
        actual.existsSync(path) &&
        actual.statSync(path).isDirectory()
      ) {
        throw errno(faults.dirFsyncError.code, "open");
      }
      const fd = actual.openSync(...args);
      fdPaths.set(fd, String(path));
      return fd;
    }) as typeof actual.openSync,
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
      if (faults.diskFullFor !== null && fdPaths.get(args[0] as number) === faults.diskFullFor) {
        throw enospc();
      }
      if (faults.zeroWrite) return 0;
      const short = faults.shortWrite;
      if (short && (short.path === undefined || fdPaths.get(args[0] as number) === short.path)) {
        faults.shortWrite = null;
        const n = short.bytes;
        const [fd, data, offset, length] = args as [number, string | Buffer, number?, number?];
        const bytes =
          typeof data === "string"
            ? Buffer.from(data)
            : data.subarray(offset ?? 0, (offset ?? 0) + (length ?? data.length - (offset ?? 0)));
        return actual.writeSync(fd, bytes.subarray(0, n));
      }
      return (actual.writeSync as (...a: unknown[]) => number)(...args);
    }) as typeof actual.writeSync,
    fsyncSync: ((fd: number) => {
      faults.fsyncedPaths.push(fdPaths.get(fd) ?? "");
      if (faults.dirFsyncError?.at === "fsync" && actual.fstatSync(fd).isDirectory()) {
        throw errno(faults.dirFsyncError.code, "fsync");
      }
      return actual.fsyncSync(fd);
    }) as typeof actual.fsyncSync,
    linkSync: ((existing: string, target: string) => {
      if (faults.rivalKey !== null) actual.writeFileSync(target, faults.rivalKey, { mode: 0o600 });
      if (faults.linkError !== null) throw errno(faults.linkError, "link");
      return actual.linkSync(existing, target);
    }) as typeof actual.linkSync,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      faults.readdirCalls.push(String(args[0]));
      return actual.readdirSync(...args);
    }) as typeof actual.readdirSync,
  };
  return { ...patched, default: patched };
});

import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  chmodSync,
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
    faults.diskFullFor = null;
    faults.rivalKey = null;
    faults.linkError = null;
    faults.readError = null;
    faults.readdirCalls.length = 0;
    faults.shortWrite = null;
    faults.zeroWrite = false;
    faults.fsyncedPaths.length = 0;
    faults.dirFsyncError = null;
    rmSync(dir, { recursive: true, force: true });
    if (savedDir === undefined) delete process.env.ENCRYPTION_KEY_DIR;
    else process.env.ENCRYPTION_KEY_DIR = savedDir;
    if (savedSecret === undefined) delete process.env.AUDIT_HMAC_SECRET;
    else process.env.AUDIT_HMAC_SECRET = savedSecret;
  });

  it("writes the variable's value to the key file when no file exists", () => {
    process.env.AUDIT_HMAC_SECRET = KEY_A;

    expect(persistEnvSecretToKeyFile(NAME)).toEqual({ status: "written", dir });

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

  it("reports a key file it may not read as unreadable, not as invalid, and leaves it in place", () => {
    // A restored key file owned by root reads as EACCES. It may well be the
    // earlier key, the only one that verifies what it signed. "Not a valid
    // key" tells the operator to move it aside; this one needs its owner fixed.
    writeFileSync(keyFile, KEY_A, { mode: 0o600 });
    faults.readError = { path: keyFile, code: "EACCES" };
    process.env.AUDIT_HMAC_SECRET = KEY_B;

    expect(persistEnvSecretToKeyFile(NAME)).toEqual({ status: "file-unreadable", code: "EACCES" });

    faults.readError = null;
    expect(readFileSync(keyFile, "utf-8")).toBe(KEY_A);
  });

  it("reports a directory where the key file should be as unreadable, and leaves it in place", () => {
    mkdirSync(keyFile);
    process.env.AUDIT_HMAC_SECRET = KEY_A;

    expect(persistEnvSecretToKeyFile(NAME)).toEqual({ status: "file-unreadable", code: "EISDIR" });
    expect(statSync(keyFile).isDirectory()).toBe(true);
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

    expect(persistEnvSecretToKeyFile(NAME)).toEqual({ status: "written", dir });

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
  // exFAT and vfat have no hard links (link fails with ENOTSUP on macOS, EPERM
  // on Linux), and neither do some FUSE and SMB mounts. A plain write used to
  // work there, so the exclusive write must not be what stops it.
  it.each(["ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS", "EXDEV"])(
    "still writes the key file when the volume has no hard links (link fails with %s)",
    (code) => {
      faults.linkError = code;
      process.env.AUDIT_HMAC_SECRET = KEY_A;

      expect(persistEnvSecretToKeyFile(NAME)).toEqual({ status: "written", dir });

      expect(readFileSync(keyFile, "utf-8")).toBe(KEY_A);
      expect(statSync(keyFile).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir)).toEqual([`.${NAME}`]);
    }
  );

  it("writes the whole key when the filesystem accepts it in pieces", () => {
    faults.shortWrite = { bytes: 10 };
    process.env.AUDIT_HMAC_SECRET = KEY_A;

    expect(persistEnvSecretToKeyFile(NAME)).toEqual({ status: "written", dir });

    expect(readFileSync(keyFile, "utf-8")).toBe(KEY_A);
  });

  // The directory fsync runs after the key file already has its name. A
  // directory it cannot open or fsync (a writable-but-unreadable one, mode
  // 0300, says EACCES) leaves the key exactly where it should be, so the write
  // landed and must be reported as written, not as failed.
  it.each(
    (["open", "fsync"] as const).flatMap((at) =>
      ["EACCES", "ENOTSUP", "ENOSYS"].map((code) => [at, code] as const)
    )
  )("reports the key as written when the directory %s fails with %s", (at, code) => {
    faults.dirFsyncError = { at, code };
    process.env.AUDIT_HMAC_SECRET = KEY_A;

    expect(persistEnvSecretToKeyFile(NAME)).toEqual({ status: "written", dir });

    faults.dirFsyncError = null;
    expect(readFileSync(keyFile, "utf-8")).toBe(KEY_A);
    process.env.AUDIT_HMAC_SECRET = KEY_B;
    expect(getPreviousSecret(NAME)?.toString("hex")).toBe(KEY_A);
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
    faults.diskFullFor = null;
    faults.rivalKey = null;
    faults.linkError = null;
    faults.readError = null;
    faults.readdirCalls.length = 0;
    faults.shortWrite = null;
    faults.zeroWrite = false;
    faults.fsyncedPaths.length = 0;
    faults.dirFsyncError = null;
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

  it.each(["ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS", "EXDEV"])(
    "generates the key on a volume without hard links (link fails with %s)",
    (code) => {
      // Reproduced on exFAT: first boot threw ENOTSUP where it used to start.
      faults.linkError = code;

      const generated = getOrCreateSecret(NAME);

      expect(readFileSync(keyFile, "utf-8")).toBe(generated.toString("hex"));
      expect(statSync(keyFile).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir)).toEqual([`.${NAME}`]);
    }
  );

  it("still never replaces a key another process wrote first on a volume without hard links", () => {
    faults.linkError = "ENOTSUP";
    faults.rivalKey = KEY_B;

    const key = getOrCreateSecret(NAME);

    expect(key.toString("hex")).toBe(KEY_B);
    expect(readFileSync(keyFile, "utf-8")).toBe(KEY_B);
    expect(readdirSync(dir)).toEqual([`.${NAME}`]);
  });

  it("leaves no partial key file when the disk fills up during the direct write", () => {
    // Without a link, the key file is created and then written. A write that
    // fails there must not leave an empty key file behind.
    faults.linkError = "ENOTSUP";
    faults.diskFullFor = keyFile;

    expect(() => getOrCreateSecret(NAME)).toThrow(/ENOSPC/);
    expect(readdirSync(dir)).toEqual([]);
  });

  // write() may return having written only part of the buffer. Ignoring the
  // count would link a key file holding the first few characters of the key
  // while this process signs with all 64: every later read rejects the file,
  // and everything signed so far is under a key nothing can load again.
  it.each([
    ["with hard links", null],
    ["without hard links", "ENOTSUP"],
  ])("writes the whole key when the filesystem accepts it in pieces (%s)", (_, linkError) => {
    faults.linkError = linkError;
    // Without hard links the key file itself is written; short-change that write.
    faults.shortWrite = linkError ? { bytes: 10, path: keyFile } : { bytes: 10 };

    const generated = getOrCreateSecret(NAME);

    expect(readFileSync(keyFile, "utf-8")).toBe(generated.toString("hex"));
    expect(readdirSync(dir)).toEqual([`.${NAME}`]);
  });

  it.each([
    ["with hard links", null],
    ["without hard links", "ENOTSUP"],
  ])("leaves no key file when a write makes no progress (%s)", (_, linkError) => {
    faults.linkError = linkError;
    faults.zeroWrite = true;

    expect(() => getOrCreateSecret(NAME)).toThrow(/EIO/);
    expect(readdirSync(dir)).toEqual([]);
  });

  // The file's own fsync makes its bytes durable, not its name: until the
  // directory is fsynced, a power cut can lose the link while the process has
  // already signed with the key it named.
  it.each([
    ["with hard links", null],
    ["without hard links", "ENOTSUP"],
  ])("fsyncs the key directory once the key file has its name (%s)", (_, linkError) => {
    faults.linkError = linkError;

    getOrCreateSecret(NAME);

    expect(faults.fsyncedPaths).toContain(dir);
  });

  // Some filesystems (and Windows) refuse to open or fsync a directory. The
  // key file is in place either way; that refusal must not fail the write.
  it.each([
    ["open", "EISDIR"],
    ["fsync", "EISDIR"],
    ["fsync", "EINVAL"],
    ["fsync", "EPERM"],
    ["fsync", "EBADF"],
  ] as const)("still generates the key when the directory %s fails with %s", (at, code) => {
    faults.dirFsyncError = { at, code };

    const generated = getOrCreateSecret(NAME);

    expect(readFileSync(keyFile, "utf-8")).toBe(generated.toString("hex"));
  });

  // Any other refusal too: once the key file has its name, the directory
  // fsync only adds power-cut durability, and failing there would throw away a
  // key that is already on disk. EACCES is a directory the process may write
  // but not read (mode 0300); ENOTSUP and ENOSYS are filesystems without a
  // directory fsync.
  it.each(
    (["open", "fsync"] as const).flatMap((at) =>
      ["EACCES", "ENOTSUP", "ENOSYS"].flatMap((code) =>
        [null, "ENOTSUP"].map((linkError) => [at, code, linkError] as const)
      )
    )
  )(
    "still generates and uses the key when the directory %s fails with %s (link error: %s)",
    (at, code, linkError) => {
      faults.dirFsyncError = { at, code };
      faults.linkError = linkError;

      const generated = getOrCreateSecret(NAME);

      faults.dirFsyncError = null;
      faults.linkError = null;
      expect(readFileSync(keyFile, "utf-8")).toBe(generated.toString("hex"));
      expect(readdirSync(dir)).toEqual([`.${NAME}`]);
      expect(getOrCreateSecret(NAME).toString("hex")).toBe(generated.toString("hex"));
    }
  );

  // The same, without simulated faults: a real directory the process may write
  // and enter but not list. root ignores the mode bits, so there is nothing to
  // observe when the suite runs as root.
  it.skipIf(process.getuid?.() === 0)(
    "generates and uses the key in a directory it may write but not read (mode 0300)",
    () => {
      chmodSync(dir, 0o300);
      try {
        const generated = getOrCreateSecret(NAME);

        expect(readFileSync(keyFile, "utf-8")).toBe(generated.toString("hex"));
        expect(getOrCreateSecret(NAME).toString("hex")).toBe(generated.toString("hex"));
      } finally {
        chmodSync(dir, 0o700);
      }
    }
  );

  it("does not fall back on a link error that is not about missing hard links", () => {
    faults.linkError = "EIO";

    expect(() => getOrCreateSecret(NAME)).toThrow(/EIO/);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("getOrCreateSecret cleaning up after a crash", () => {
  // A crash between writing the temp file and removing it leaves a copy of the
  // key next to the key file. Every key getOrCreateSecret generates goes
  // through that temp file, the encryption key included, so every one of them
  // gets cleaned up, not only the audit key that startup persists.
  let dir: string;
  const savedDir = process.env.ENCRYPTION_KEY_DIR;
  const savedKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pinchy-keyclean-"));
    process.env.ENCRYPTION_KEY_DIR = dir;
    delete process.env.ENCRYPTION_KEY;
  });

  afterEach(() => {
    faults.readdirCalls.length = 0;
    faults.shortWrite = null;
    faults.zeroWrite = false;
    faults.fsyncedPaths.length = 0;
    faults.dirFsyncError = null;
    rmSync(dir, { recursive: true, force: true });
    if (savedDir === undefined) delete process.env.ENCRYPTION_KEY_DIR;
    else process.env.ENCRYPTION_KEY_DIR = savedDir;
    if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = savedKey;
  });

  it("removes stale temp files of the encryption key before generating it", () => {
    writeFileSync(join(dir, ".encryption_key.4242.deadbeef.tmp"), KEY_B, { mode: 0o600 });

    const generated = getOrCreateSecret("encryption_key");

    expect(readdirSync(dir)).toEqual([".encryption_key"]);
    expect(readFileSync(join(dir, ".encryption_key"), "utf-8")).toBe(generated.toString("hex"));
  });

  it("removes a stale temp file of the encryption key also when the key file is in place", () => {
    // The crash can land between link and unlink.
    writeFileSync(join(dir, ".encryption_key"), KEY_A, { mode: 0o600 });
    writeFileSync(join(dir, ".encryption_key.77.cafef00d.tmp"), KEY_A, { mode: 0o600 });

    expect(getOrCreateSecret("encryption_key").toString("hex")).toBe(KEY_A);
    expect(readdirSync(dir)).toEqual([".encryption_key"]);
  });

  it("looks for them once per key file, not on every call", () => {
    // getOrCreateSecret sits on the hot path of every encrypt, decrypt and
    // audit append; a directory listing on each of them would be a cost
    // without a benefit, since only a crash leaves these files.
    writeFileSync(join(dir, ".encryption_key"), KEY_A, { mode: 0o600 });

    for (let i = 0; i < 3; i++) getOrCreateSecret("encryption_key");

    expect(faults.readdirCalls.filter((d) => d === dir)).toHaveLength(1);
  });
});
