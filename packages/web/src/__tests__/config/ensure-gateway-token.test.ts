import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

const SCRIPT_PATH = join(__dirname, "../../../../../config/ensure-gateway-token.js");

function runScript(configPath: string, secretsPath: string) {
  execSync(`node ${SCRIPT_PATH}`, {
    encoding: "utf-8",
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_SECRETS_PATH: secretsPath,
    },
  });
}

function readJSON(filePath: string) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

describe("ensure-gateway-token", () => {
  let tmpDir: string;
  let configPath: string;
  let secretsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    configPath = join(tmpDir, "openclaw.json");
    secretsPath = join(tmpDir, "secrets.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates a gateway token in secrets.json when absent", () => {
    runScript(configPath, secretsPath);

    const secrets = readJSON(secretsPath);
    expect(secrets.gateway.token).toBeDefined();
    expect(secrets.gateway.token).toHaveLength(48); // 24 bytes hex
  });

  it("preserves an existing gateway token in secrets.json", () => {
    writeFileSync(secretsPath, JSON.stringify({ gateway: { token: "existing" } }));

    runScript(configPath, secretsPath);

    const secrets = readJSON(secretsPath);
    expect(secrets.gateway.token).toBe("existing");
  });

  it("writes a minimal openclaw.json with gateway auth when openclaw.json absent", () => {
    runScript(configPath, secretsPath);

    const config = readJSON(configPath);
    const secrets = readJSON(secretsPath);
    // gateway.auth.token must be the same plain string as secrets.gateway.token
    expect(config.gateway.auth.mode).toBe("token");
    expect(typeof config.gateway.auth.token).toBe("string");
    expect(config.gateway.auth.token).toBe(secrets.gateway.token);
    expect(config.secrets.providers.pinchy).toEqual({
      source: "file",
      path: secretsPath,
      mode: "json",
    });
  });

  it("does not overwrite existing secrets provider block", () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan" },
      secrets: {
        providers: {
          pinchy: { source: "file", path: "/custom/path/secrets.json", mode: "json" },
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(existingConfig));

    runScript(configPath, secretsPath);

    const config = readJSON(configPath);
    // secrets block already existed, should not be overwritten
    expect(config.secrets.providers.pinchy.path).toBe("/custom/path/secrets.json");
  });

  it("preserves other fields in the config", () => {
    const existing = {
      gateway: { mode: "local", bind: "lan" },
      env: { ANTHROPIC_API_KEY: "sk-ant-key" },
      agents: { defaults: { model: { primary: "anthropic/claude-haiku-4-5-20251001" } } },
    };
    writeFileSync(configPath, JSON.stringify(existing));

    runScript(configPath, secretsPath);

    const config = readJSON(configPath);
    const secrets = readJSON(secretsPath);
    expect(config.env.ANTHROPIC_API_KEY).toBe("sk-ant-key");
    expect(config.agents.defaults.model.primary).toBe("anthropic/claude-haiku-4-5-20251001");
    expect(config.gateway.auth.token).toBe(secrets.gateway.token);
  });

  it("creates parent directories if they do not exist", () => {
    const nestedConfigPath = join(tmpDir, "nested", "dir", "openclaw.json");
    const nestedSecretsPath = join(tmpDir, "nested", "secrets", "secrets.json");

    runScript(nestedConfigPath, nestedSecretsPath);

    expect(readJSON(nestedConfigPath).gateway.auth).toBeDefined();
    expect(readJSON(nestedSecretsPath).gateway.token).toBeDefined();
  });

  it("sets restrictive permissions on openclaw.json (644)", () => {
    runScript(configPath, secretsPath);

    const stats = statSync(configPath);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe("644");
  });

  it("sets world-readable permissions on secrets.json (644)", () => {
    runScript(configPath, secretsPath);

    const stats = statSync(secretsPath);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe("644");
  });
});
