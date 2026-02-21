import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

const SCRIPT_PATH = join(__dirname, "../../../../../config/ensure-gateway-token.js");

function runScript(configPath: string) {
  execSync(`node ${SCRIPT_PATH} ${configPath}`, { encoding: "utf-8" });
}

function readConfig(configPath: string) {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

describe("ensure-gateway-token", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    configPath = join(tmpDir, "openclaw.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates a gateway auth token when config has none", () => {
    writeFileSync(configPath, JSON.stringify({ gateway: { mode: "local", bind: "lan" } }));

    runScript(configPath);

    const config = readConfig(configPath);
    expect(config.gateway.auth.token).toBeDefined();
    expect(config.gateway.auth.token).toHaveLength(48); // 24 bytes hex
    expect(config.gateway.auth.mode).toBe("token");
  });

  it("preserves existing token", () => {
    const existing = {
      gateway: {
        mode: "local",
        bind: "lan",
        auth: { mode: "token", token: "my-existing-token-abc123" },
      },
    };
    writeFileSync(configPath, JSON.stringify(existing));

    runScript(configPath);

    const config = readConfig(configPath);
    expect(config.gateway.auth.token).toBe("my-existing-token-abc123");
  });

  it("creates config file when it does not exist", () => {
    runScript(configPath);

    const config = readConfig(configPath);
    expect(config.gateway.auth.token).toBeDefined();
    expect(config.gateway.auth.token).toHaveLength(48);
    expect(config.gateway.mode).toBe("local");
    expect(config.gateway.bind).toBe("lan");
  });

  it("preserves other fields in the config", () => {
    const existing = {
      gateway: { mode: "local", bind: "lan" },
      env: { ANTHROPIC_API_KEY: "sk-ant-key" },
      agents: { defaults: { model: { primary: "anthropic/claude-haiku-4-5-20251001" } } },
    };
    writeFileSync(configPath, JSON.stringify(existing));

    runScript(configPath);

    const config = readConfig(configPath);
    expect(config.env.ANTHROPIC_API_KEY).toBe("sk-ant-key");
    expect(config.agents.defaults.model.primary).toBe("anthropic/claude-haiku-4-5-20251001");
    expect(config.gateway.auth.token).toBeDefined();
  });

  it("creates parent directory if it does not exist", () => {
    const nestedPath = join(tmpDir, "nested", "dir", "openclaw.json");

    runScript(nestedPath);

    const config = readConfig(nestedPath);
    expect(config.gateway.auth.token).toBeDefined();
  });

  it("sets restrictive file permissions", () => {
    runScript(configPath);

    const stats = statSync(configPath);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe("600");
  });
});
