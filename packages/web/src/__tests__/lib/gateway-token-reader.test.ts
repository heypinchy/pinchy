import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// readSecretsFile reads from /openclaw-secrets/secrets.json by default;
// override per-test via OPENCLAW_SECRETS_PATH so we don't touch real fs.

let tmpDir: string;
let configPath: string;
let secretsPath: string;
const origConfigPath = process.env.OPENCLAW_CONFIG_PATH;
const origSecretsPath = process.env.OPENCLAW_SECRETS_PATH;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pinchy-gtoken-"));
  configPath = join(tmpDir, "openclaw.json");
  secretsPath = join(tmpDir, "secrets.json");
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  process.env.OPENCLAW_SECRETS_PATH = secretsPath;
  vi.resetModules();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (origConfigPath !== undefined) process.env.OPENCLAW_CONFIG_PATH = origConfigPath;
  else delete process.env.OPENCLAW_CONFIG_PATH;
  if (origSecretsPath !== undefined) process.env.OPENCLAW_SECRETS_PATH = origSecretsPath;
  else delete process.env.OPENCLAW_SECRETS_PATH;
});

describe("readGatewayToken", () => {
  it("returns token from openclaw.json when set", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ gateway: { auth: { token: "abc-from-openclaw-json" } } })
    );
    const { readGatewayToken } = await import("@/lib/gateway-token-reader");
    expect(readGatewayToken()).toBe("abc-from-openclaw-json");
  });

  it("falls back to secrets.json when openclaw.json missing", async () => {
    // Cold-start-after-restart edge: openclaw.json briefly unavailable,
    // but Pinchy's last writeSecretsFile() left the token in secrets.json.
    writeFileSync(secretsPath, JSON.stringify({ gateway: { token: "abc-from-secrets-json" } }));
    const { readGatewayToken } = await import("@/lib/gateway-token-reader");
    expect(readGatewayToken()).toBe("abc-from-secrets-json");
  });

  it("falls back to secrets.json when openclaw.json has empty token", async () => {
    writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token: "" } } }));
    writeFileSync(secretsPath, JSON.stringify({ gateway: { token: "abc-fallback" } }));
    const { readGatewayToken } = await import("@/lib/gateway-token-reader");
    expect(readGatewayToken()).toBe("abc-fallback");
  });

  it("falls back to secrets.json when openclaw.json has malformed json", async () => {
    writeFileSync(configPath, "{ this is not valid json }");
    writeFileSync(secretsPath, JSON.stringify({ gateway: { token: "abc-fallback" } }));
    const { readGatewayToken } = await import("@/lib/gateway-token-reader");
    expect(readGatewayToken()).toBe("abc-fallback");
  });

  it("returns empty string when neither file has a token", async () => {
    // No config, no secrets — never throw, just return "".
    const { readGatewayToken } = await import("@/lib/gateway-token-reader");
    expect(readGatewayToken()).toBe("");
  });

  it("returns empty string when openclaw.json exists but has no gateway block", async () => {
    writeFileSync(configPath, JSON.stringify({ env: {} }));
    const { readGatewayToken } = await import("@/lib/gateway-token-reader");
    expect(readGatewayToken()).toBe("");
  });

  it("regression: even when secrets.json is unreadable (mode 0600 root-owned), token from openclaw.json wins", async () => {
    // Regression: openclaw.json token wins even when secrets.json is root-only.
    // start-openclaw.sh's chmod 0600 prevents Pinchy (uid 999) from reading
    // secrets.json. Without the openclaw.json fallback, readGatewayToken would
    // return "" and Pinchy would connect unauthenticated, then never recover.
    writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token: "the-real-token" } } }));
    // Make secrets.json effectively unreadable. We can't chmod 0600 to root in
    // tests (we're not root), so we simulate by deleting the file — same end
    // state from readSecretsFile()'s perspective: existsSync returns false →
    // returns {} → no token.
    const { readGatewayToken } = await import("@/lib/gateway-token-reader");
    expect(readGatewayToken()).toBe("the-real-token");
    void mkdirSync; // silence unused import
    void chmodSync;
  });
});
