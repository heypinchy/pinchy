import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  secretRef,
  writeSecretsFile,
  readSecretsFile,
  checkSecretsVolumeWritable,
} from "@/lib/openclaw-secrets";
import { readFileSync, existsSync, statSync, writeFileSync } from "fs";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("secretRef", () => {
  it("builds a SecretRef pointing at the pinchy file provider", () => {
    expect(secretRef("/providers/anthropic/apiKey")).toEqual({
      source: "file",
      provider: "pinchy",
      id: "/providers/anthropic/apiKey",
    });
  });
});

describe("writeSecretsFile", () => {
  let dir: string;
  const bundle = { providers: { anthropic: { apiKey: "sk-ant-test" } } };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pinchy-secrets-"));
    process.env.OPENCLAW_SECRETS_PATH = join(dir, "secrets.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENCLAW_SECRETS_PATH;
  });

  it("writes JSON to OPENCLAW_SECRETS_PATH", () => {
    writeSecretsFile(bundle);
    const content = readFileSync(process.env.OPENCLAW_SECRETS_PATH!, "utf-8");
    expect(JSON.parse(content)).toEqual(bundle);
  });

  it("creates the file with mode 0600 (owner read/write only)", () => {
    writeSecretsFile(bundle);
    const mode = statSync(process.env.OPENCLAW_SECRETS_PATH!).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("overwrites an existing file completely", () => {
    writeSecretsFile(bundle);
    // Overwrite — there must never be a window where the file is empty/truncated.
    writeSecretsFile({ providers: { openai: { apiKey: "sk-new" } } });
    expect(existsSync(process.env.OPENCLAW_SECRETS_PATH!)).toBe(true);
    const content = JSON.parse(readFileSync(process.env.OPENCLAW_SECRETS_PATH!, "utf-8"));
    expect(content.providers.openai.apiKey).toBe("sk-new");
  });

  it("uses atomic rename pattern (no .tmp file left behind)", () => {
    writeSecretsFile(bundle);
    expect(existsSync(`${process.env.OPENCLAW_SECRETS_PATH!}.tmp`)).toBe(false);
  });

  it("does not rewrite the file when content is unchanged (inode preserved)", () => {
    // Without this, every regenerateOpenClawConfig() bumps secrets.json's
    // mtime, and the inotify watcher in start-openclaw.sh would uselessly
    // restart the OpenClaw gateway on every Pinchy startup. We check the
    // inode rather than mtime so we don't depend on filesystem mtime
    // granularity (or wall-clock waits) to detect a rewrite — the atomic
    // rename pattern always allocates a new inode when it does write.
    writeSecretsFile(bundle);
    const path = process.env.OPENCLAW_SECRETS_PATH!;
    const inoBefore = statSync(path).ino;
    writeSecretsFile(bundle);
    const inoAfter = statSync(path).ino;
    expect(inoAfter).toBe(inoBefore);
  });

  it("does rewrite the file when content changes", () => {
    writeSecretsFile(bundle);
    writeSecretsFile({ providers: { openai: { apiKey: "sk-different" } } });
    const content = JSON.parse(readFileSync(process.env.OPENCLAW_SECRETS_PATH!, "utf-8"));
    expect(content.providers.openai.apiKey).toBe("sk-different");
  });

  it("throws an actionable error when the secrets directory cannot be created (missing volume mount)", () => {
    // Reproduce the #878 failure shape: the `openclaw-secrets` volume is not
    // mounted, so the directory Pinchy expects to write into cannot be created.
    // We simulate an un-creatable directory by pointing the path *under a
    // regular file* — mkdir of a directory whose parent component is a file
    // fails the same way an EACCES at the container root does. The bare fs
    // error (EACCES/ENOTDIR) must be replaced by a message that tells the
    // operator their docker-compose.yml is missing the volume.
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "x");
    process.env.OPENCLAW_SECRETS_PATH = join(blocker, "secrets.json");

    expect(() => writeSecretsFile(bundle)).toThrow(/docker-compose\.yml/);
    expect(() => writeSecretsFile(bundle)).toThrow(/openclaw-secrets/);
  });
});

describe("checkSecretsVolumeWritable", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pinchy-secrets-"));
    process.env.OPENCLAW_SECRETS_PATH = join(dir, "secrets.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENCLAW_SECRETS_PATH;
  });

  it("returns ok when the secrets directory is writable", () => {
    expect(checkSecretsVolumeWritable()).toEqual({ ok: true });
  });

  it("returns not-ok with an actionable message when the directory cannot be created", () => {
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "x");
    process.env.OPENCLAW_SECRETS_PATH = join(blocker, "secrets.json");

    const result = checkSecretsVolumeWritable();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not-ok");
    expect(result.message).toMatch(/docker-compose\.yml/);
    expect(result.message).toMatch(/openclaw-secrets/);
  });
});

describe("readSecretsFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pinchy-secrets-"));
    process.env.OPENCLAW_SECRETS_PATH = join(dir, "secrets.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENCLAW_SECRETS_PATH;
  });

  it("returns empty object when file does not exist", () => {
    const result = readSecretsFile();
    expect(result).toEqual({});
  });

  it("returns parsed JSON when file exists", () => {
    const bundle = { providers: { anthropic: { apiKey: "sk-ant-test" } } };
    writeSecretsFile(bundle);
    const result = readSecretsFile();
    expect(result).toEqual(bundle);
  });
});
