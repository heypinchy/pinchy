/**
 * SecretRef roundtrip integration test.
 *
 * Verifies that regenerateOpenClawConfig() writes a openclaw.json that:
 *   1. Contains NO plaintext secrets (Anthropic keys, tokens, etc.)
 *   2. Has correct SecretRef shapes for every credential field
 *   3. Has the secrets.providers.pinchy block pointing at the secrets file
 *
 * And that secrets.json:
 *   4. Contains the actual plaintext API key
 *
 * Uses real file I/O on a tmpdir (not mocked fs) so we exercise the full
 * write path including writeConfigAtomic + assertNoPlaintextSecrets guard.
 *
 * Does NOT require a running OpenClaw process or PostgreSQL.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Tmpdir setup — resolved before vi.mock factory runs
// ---------------------------------------------------------------------------
let tmpConfigDir: string;
let tmpSecretsDir: string;

// We need env vars set before the module under test resolves CONFIG_PATH.
// vi.stubEnv / process.env must be set before regenerateOpenClawConfig is
// imported. We use beforeEach + vi.resetModules() + dynamic import to ensure
// the module sees the updated env vars on each test run.

// ---------------------------------------------------------------------------
// Mock external dependencies that require a real DB / runtime
// ---------------------------------------------------------------------------
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

vi.mock("@/lib/migrate-onboarding", () => ({
  migrateExistingSmithers: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/provider-models", () => ({
  getDefaultModel: vi.fn().mockResolvedValue("anthropic/claude-haiku-4-5-20251001"),
}));

describe("SecretRef roundtrip — regenerateOpenClawConfig()", () => {
  beforeEach(() => {
    // Create fresh tmp dirs for each test
    tmpConfigDir = mkdtempSync(join(tmpdir(), "pinchy-config-"));
    tmpSecretsDir = mkdtempSync(join(tmpdir(), "pinchy-secrets-"));

    // Set env vars before the module re-imports
    process.env.OPENCLAW_CONFIG_PATH = join(tmpConfigDir, "openclaw.json");
    process.env.OPENCLAW_SECRETS_PATH = join(tmpSecretsDir, "secrets.json");
    process.env.OPENCLAW_SECRETS_PATH_IN_OPENCLAW = join(tmpSecretsDir, "secrets.json");

    // Reset module registry so openclaw-config.ts re-reads CONFIG_PATH
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OPENCLAW_SECRETS_PATH;
    delete process.env.OPENCLAW_SECRETS_PATH_IN_OPENCLAW;
    rmSync(tmpConfigDir, { recursive: true, force: true });
    rmSync(tmpSecretsDir, { recursive: true, force: true });
  });

  it("writes openclaw.json without any plaintext API key", async () => {
    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-api03-TESTKEY1234567890abcdef";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    const { regenerateOpenClawConfig } = await import("@/lib/openclaw-config");
    await regenerateOpenClawConfig();

    const configPath = process.env.OPENCLAW_CONFIG_PATH!;
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    // The plaintext key must NOT appear anywhere in openclaw.json
    const raw = JSON.stringify(config);
    expect(raw).not.toContain("sk-ant-api03-TESTKEY1234567890abcdef");
  });

  it("writes anthropic apiKey as SecretRef in models.providers.anthropic (not env-template)", async () => {
    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-api03-TESTKEY1234567890abcdef";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    const { regenerateOpenClawConfig } = await import("@/lib/openclaw-config");
    await regenerateOpenClawConfig();

    const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf-8"));

    // Provider API keys now use SecretRef in models.providers.* — not env-templates.
    // OpenClaw resolves the SecretRef live from secrets.json without a process restart.
    expect(config?.models?.providers?.anthropic?.apiKey).toMatchObject({
      source: "file",
      provider: "pinchy",
      id: "/providers/anthropic/apiKey",
    });
    // No env-template for the key
    expect(config?.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("writes the secrets.providers.pinchy block into openclaw.json", async () => {
    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockResolvedValue(null);

    const { regenerateOpenClawConfig } = await import("@/lib/openclaw-config");
    await regenerateOpenClawConfig();

    const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf-8"));

    expect(config.secrets.providers.pinchy).toEqual({
      source: "file",
      path: process.env.OPENCLAW_SECRETS_PATH_IN_OPENCLAW,
      mode: "json",
    });
  });

  it("stores the plaintext API key in secrets.json", async () => {
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
    expect(secrets.providers?.anthropic?.apiKey).toBe("sk-ant-api03-TESTKEY1234567890abcdef");
  });

  it("gateway.auth.token is preserved as plain string in openclaw.json and mirrored to secrets.json", async () => {
    const { getSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockResolvedValue(null);

    // Simulate an existing config with a plaintext token (e.g. from a previous regenerateOpenClawConfig)
    const existingConfig = {
      gateway: {
        mode: "local",
        bind: "lan",
        auth: { token: "my-super-secret-gateway-token" },
      },
    };
    const configPath = process.env.OPENCLAW_CONFIG_PATH!;
    const secretsPath = process.env.OPENCLAW_SECRETS_PATH!;
    const { writeFileSync, mkdirSync, existsSync: fsExistsSync } = await import("fs");
    const { dirname } = await import("path");
    const dir = dirname(configPath);
    if (!fsExistsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(existingConfig), "utf-8");

    const { regenerateOpenClawConfig } = await import("@/lib/openclaw-config");
    await regenerateOpenClawConfig();

    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    // OpenClaw requires a plain string for gateway.auth.token — must be preserved as-is
    expect(config.gateway.auth.token).toBe("my-super-secret-gateway-token");

    // The same token must also be written to secrets.json for Pinchy to read at startup
    const secrets = JSON.parse(readFileSync(secretsPath, "utf-8"));
    expect(secrets.gateway?.token).toBe("my-super-secret-gateway-token");
  });

  it("assertNoPlaintextSecrets guard prevents writing a plaintext secret to disk", async () => {
    const { assertNoPlaintextSecrets } = await import("@/lib/openclaw-plaintext-scanner");

    // Craft a config object that contains a plaintext Anthropic key
    const badConfig = {
      env: {
        ANTHROPIC_API_KEY: "sk-ant-api03-TESTKEY1234567890abcdef",
      },
    };

    expect(() => assertNoPlaintextSecrets(badConfig)).toThrow(/plaintext secret detected/);
  });
});
