import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { secretRef, writeSecretsFile, readSecretsFile } from "@/lib/openclaw-secrets";
import { readFileSync, existsSync, statSync } from "fs";
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
