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
const origE2eGatewayToken = process.env.PINCHY_E2E_GATEWAY_TOKEN;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pinchy-gtoken-"));
  configPath = join(tmpDir, "openclaw.json");
  secretsPath = join(tmpDir, "secrets.json");
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  process.env.OPENCLAW_SECRETS_PATH = secretsPath;
  delete process.env.PINCHY_E2E_GATEWAY_TOKEN;
  vi.resetModules();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (origConfigPath !== undefined) process.env.OPENCLAW_CONFIG_PATH = origConfigPath;
  else delete process.env.OPENCLAW_CONFIG_PATH;
  if (origSecretsPath !== undefined) process.env.OPENCLAW_SECRETS_PATH = origSecretsPath;
  else delete process.env.OPENCLAW_SECRETS_PATH;
  if (origE2eGatewayToken !== undefined) process.env.PINCHY_E2E_GATEWAY_TOKEN = origE2eGatewayToken;
  else delete process.env.PINCHY_E2E_GATEWAY_TOKEN;
});

describe("readGatewayToken", () => {
  it("uses the E2E gateway token when set", async () => {
    process.env.PINCHY_E2E_GATEWAY_TOKEN = "e2e-gateway-token";
    writeFileSync(
      configPath,
      JSON.stringify({ gateway: { auth: { token: "abc-from-openclaw-json" } } })
    );
    const { readGatewayToken } = await import("@/lib/gateway-token-reader");
    expect(readGatewayToken()).toBe("e2e-gateway-token");
  });

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

  // OpenClaw rewrites openclaw.json root-only on every config apply until
  // start-openclaw.sh chmods it back, and secrets.json is root-owned. In that
  // window both reads fail, and validateGatewayToken() used to compare every
  // plugin's Bearer token against "" — a 401 on every internal route.
  describe("last good token", () => {
    it("keeps serving the last token while both files are unreadable", async () => {
      writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token: "good-token" } } }));
      const { readGatewayToken } = await import("@/lib/gateway-token-reader");
      expect(readGatewayToken()).toBe("good-token");

      rmSync(configPath);
      expect(readGatewayToken()).toBe("good-token");
    });

    it("keeps serving the last token while openclaw.json is half-written", async () => {
      writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token: "good-token" } } }));
      const { readGatewayToken } = await import("@/lib/gateway-token-reader");
      expect(readGatewayToken()).toBe("good-token");

      writeFileSync(configPath, "{ half-written");
      expect(readGatewayToken()).toBe("good-token");
    });

    it("picks up a rotated token on the next successful read, and falls back to that one", async () => {
      writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token: "old-token" } } }));
      const { readGatewayToken } = await import("@/lib/gateway-token-reader");
      expect(readGatewayToken()).toBe("old-token");

      writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token: "new-token" } } }));
      expect(readGatewayToken()).toBe("new-token");

      rmSync(configPath);
      expect(readGatewayToken()).toBe("new-token");
    });

    it("still returns empty when no token was ever readable", async () => {
      const { readGatewayToken } = await import("@/lib/gateway-token-reader");
      expect(readGatewayToken()).toBe("");
    });

    it("fails closed when openclaw.json reads cleanly but carries no token", async () => {
      // A config that parses and has no token is an answer, not a read
      // failure: serving the old token here would keep it valid for the
      // process lifetime.
      writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token: "good-token" } } }));
      const { readGatewayToken } = await import("@/lib/gateway-token-reader");
      expect(readGatewayToken()).toBe("good-token");

      writeFileSync(configPath, JSON.stringify({ env: {} }));
      expect(readGatewayToken()).toBe("");
    });

    it("stops serving the last token once the files stay unreadable past the cap", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-11-04T10:00:00Z"));
        writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token: "good-token" } } }));
        const { readGatewayToken, LAST_GOOD_TOKEN_MAX_AGE_MS } =
          await import("@/lib/gateway-token-reader");
        expect(readGatewayToken()).toBe("good-token");

        rmSync(configPath);
        vi.setSystemTime(Date.now() + LAST_GOOD_TOKEN_MAX_AGE_MS - 1);
        expect(readGatewayToken()).toBe("good-token");

        vi.setSystemTime(Date.now() + 2);
        expect(readGatewayToken()).toBe("");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("readGatewayTokenUncached", () => {
    it("never answers with a remembered token", async () => {
      writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token: "good-token" } } }));
      const { readGatewayToken, readGatewayTokenUncached } =
        await import("@/lib/gateway-token-reader");
      expect(readGatewayToken()).toBe("good-token");
      expect(readGatewayTokenUncached()).toBe("good-token");

      rmSync(configPath);
      expect(readGatewayToken()).toBe("good-token");
      expect(readGatewayTokenUncached()).toBe("");
    });
  });
});

describe("getOrCreateGatewayToken", () => {
  it("never persists a remembered token while the config files are unreadable", async () => {
    // Clearing the DB setting is how an operator forces a fresh token. If the
    // files are mid-rewrite at that moment, adopting the in-memory fallback
    // would write the very token they meant to replace back into the DB.
    vi.doMock("@/lib/settings", () => ({
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    }));
    try {
      writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token: "old-token" } } }));
      const { readGatewayToken } = await import("@/lib/gateway-token-reader");
      expect(readGatewayToken()).toBe("old-token");
      rmSync(configPath);

      const { getOrCreateGatewayToken } = await import("@/lib/gateway-token-source");
      const token = await getOrCreateGatewayToken();
      expect(token).not.toBe("old-token");
      expect(token).toMatch(/^[0-9a-f]{48}$/);
    } finally {
      vi.doUnmock("@/lib/settings");
    }
  });
});

describe("validateGatewayToken", () => {
  it("keeps accepting the plugins' token while the config files are unreadable", async () => {
    writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token: "good-token" } } }));
    const { validateGatewayToken } = await import("@/lib/gateway-auth");
    const headers = new Headers({ Authorization: "Bearer good-token" });
    expect(validateGatewayToken(headers)).toBe(true);

    rmSync(configPath);
    expect(validateGatewayToken(headers)).toBe(true);
    expect(validateGatewayToken(new Headers({ Authorization: "Bearer wrong" }))).toBe(false);
  });
});
