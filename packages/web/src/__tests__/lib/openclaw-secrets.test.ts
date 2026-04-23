import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  secretRef,
  writeSecretsFile,
  readSecretsFile,
  updateSecretsFile,
} from "@/lib/openclaw-secrets";
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

  it("creates the file with mode 0600", () => {
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

describe("updateSecretsFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pinchy-secrets-"));
    process.env.OPENCLAW_SECRETS_PATH = join(dir, "secrets.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENCLAW_SECRETS_PATH;
  });

  it("merges update with existing secrets", () => {
    writeSecretsFile({ providers: { anthropic: { apiKey: "sk-ant" } } });
    updateSecretsFile((s) => ({
      ...s,
      telegram: { "agent-1": { botToken: "bot-token-123" } },
    }));
    const result = readSecretsFile();
    expect(result.providers?.anthropic?.apiKey).toBe("sk-ant");
    expect(result.telegram?.["agent-1"]?.botToken).toBe("bot-token-123");
  });

  it("creates file when it does not exist", () => {
    updateSecretsFile((s) => ({
      ...s,
      telegram: { "agent-2": { botToken: "new-token" } },
    }));
    const result = readSecretsFile();
    expect(result.telegram?.["agent-2"]?.botToken).toBe("new-token");
  });
});
