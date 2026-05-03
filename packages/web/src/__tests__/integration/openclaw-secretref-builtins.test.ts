/**
 * SecretRef spec for built-in LLM providers — Phase 1 (NO production code).
 *
 * Defines the TARGET state: after Phase 2, regenerateOpenClawConfig() writes
 * SecretRef objects for anthropic/openai/google keys, not env-templates.
 * This test is intentionally RED against the current code.
 *
 * OpenClaw 2026.4.12 SecretRef compatibility for built-in providers is
 * empirically validated via staging in Task 2.5.
 *
 * Three invariants that must hold after Phase 2:
 *   1. openclaw.json#/models/providers/<name>.apiKey → SecretRef object
 *   2. openclaw.json#/env has no provider API key template (ANTHROPIC_API_KEY, etc.)
 *   3. secrets.json#/providers/<name>.apiKey → plaintext key
 *   4. openclaw.json#/models/providers/<name>.models → non-empty array
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SecretRef } from "@/lib/openclaw-secrets";

// ---------------------------------------------------------------------------
// Tmpdir setup — resolved before vi.mock factory runs
// ---------------------------------------------------------------------------
let tmpConfigDir: string;
let tmpSecretsDir: string;

vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve([]), {
          innerJoin: vi.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), {
              where: vi.fn().mockResolvedValue([]),
            })
          ),
          where: vi.fn().mockResolvedValue([]),
        })
      ),
    })),
  },
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/encryption", () => ({
  decrypt: (val: string) => val,
  encrypt: (val: string) => val,
  getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32)),
}));

vi.mock("@/server/restart-state", () => ({
  restartState: { notifyRestart: vi.fn() },
}));

vi.mock("@/lib/provider-models", () => ({
  getDefaultModel: vi.fn().mockResolvedValue("anthropic/claude-haiku-4-5-20251001"),
}));

function isSecretRef(value: unknown): value is SecretRef {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as SecretRef).source === "file" &&
    (value as SecretRef).provider === "pinchy" &&
    typeof (value as SecretRef).id === "string"
  );
}

describe("SecretRef for built-in providers — Phase 1 spec", () => {
  beforeEach(() => {
    tmpConfigDir = mkdtempSync(join(tmpdir(), "pinchy-config-"));
    tmpSecretsDir = mkdtempSync(join(tmpdir(), "pinchy-secrets-"));

    process.env.OPENCLAW_CONFIG_PATH = join(tmpConfigDir, "openclaw.json");
    process.env.OPENCLAW_SECRETS_PATH = join(tmpSecretsDir, "secrets.json");
    process.env.OPENCLAW_SECRETS_PATH_IN_OPENCLAW = join(tmpSecretsDir, "secrets.json");

    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OPENCLAW_SECRETS_PATH;
    delete process.env.OPENCLAW_SECRETS_PATH_IN_OPENCLAW;
    rmSync(tmpConfigDir, { recursive: true, force: true });
    rmSync(tmpSecretsDir, { recursive: true, force: true });
  });

  it("emits models.providers.anthropic.apiKey as SecretRef (not env-template)", async () => {
    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-api03-TESTKEY1234567890abcdef";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    const { regenerateOpenClawConfig } = await import("@/lib/openclaw-config");
    await regenerateOpenClawConfig();

    const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf-8"));

    const apiKey = config?.models?.providers?.anthropic?.apiKey;
    expect(isSecretRef(apiKey)).toBe(true);
    expect((apiKey as SecretRef).id).toBe("/providers/anthropic/apiKey");
  });

  it("does NOT emit ANTHROPIC_API_KEY env-template when anthropic key is set", async () => {
    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-api03-TESTKEY1234567890abcdef";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    const { regenerateOpenClawConfig } = await import("@/lib/openclaw-config");
    await regenerateOpenClawConfig();

    const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf-8"));

    // The env block must not contain any provider API key template
    expect(config?.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("writes plaintext anthropic key to secrets.json#/providers/anthropic/apiKey", async () => {
    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-api03-TESTKEY1234567890abcdef";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    const { regenerateOpenClawConfig } = await import("@/lib/openclaw-config");
    await regenerateOpenClawConfig();

    const secretsPath = process.env.OPENCLAW_SECRETS_PATH!;
    expect(existsSync(secretsPath)).toBe(true);

    const secrets = JSON.parse(readFileSync(secretsPath, "utf-8"));
    expect(secrets?.providers?.anthropic?.apiKey).toBe("sk-ant-api03-TESTKEY1234567890abcdef");
  });

  it("emits a non-empty models array for anthropic", async () => {
    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-api03-TESTKEY1234567890abcdef";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    const { regenerateOpenClawConfig } = await import("@/lib/openclaw-config");
    await regenerateOpenClawConfig();

    const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf-8"));
    const models = config?.models?.providers?.anthropic?.models;

    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
  });

  it("emits models.providers.openai.apiKey as SecretRef", async () => {
    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "openai_api_key") return "sk-test-OPENAI1234567890abcdef";
      if (key === "default_provider") return "openai";
      return null;
    });

    const { regenerateOpenClawConfig } = await import("@/lib/openclaw-config");
    await regenerateOpenClawConfig();

    const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf-8"));

    const apiKey = config?.models?.providers?.openai?.apiKey;
    expect(isSecretRef(apiKey)).toBe(true);
    expect((apiKey as SecretRef).id).toBe("/providers/openai/apiKey");
    expect(config?.env?.OPENAI_API_KEY).toBeUndefined();
  });

  it("emits models.providers.google.apiKey as SecretRef", async () => {
    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "google_api_key") return "AIzaTESTKEY1234567890abcdef";
      if (key === "default_provider") return "google";
      return null;
    });

    const { regenerateOpenClawConfig } = await import("@/lib/openclaw-config");
    await regenerateOpenClawConfig();

    const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf-8"));

    const apiKey = config?.models?.providers?.google?.apiKey;
    expect(isSecretRef(apiKey)).toBe(true);
    expect((apiKey as SecretRef).id).toBe("/providers/google/apiKey");
    expect(config?.env?.GEMINI_API_KEY).toBeUndefined();
  });
});
