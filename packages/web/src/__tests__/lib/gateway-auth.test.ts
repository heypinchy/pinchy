import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_SECRETS_DIR = join(tmpdir(), "pinchy-gateway-auth-test");
const TEST_SECRETS_PATH = join(TEST_SECRETS_DIR, "secrets.json");
const TEST_CONFIG_PATH = join(TEST_SECRETS_DIR, "openclaw.json");
const origConfigPath = process.env.OPENCLAW_CONFIG_PATH;

describe("validateGatewayToken", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.OPENCLAW_SECRETS_PATH = TEST_SECRETS_PATH;
    process.env.OPENCLAW_CONFIG_PATH = TEST_CONFIG_PATH;
    if (!existsSync(TEST_SECRETS_DIR)) {
      mkdirSync(TEST_SECRETS_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    delete process.env.OPENCLAW_SECRETS_PATH;
    if (origConfigPath !== undefined) process.env.OPENCLAW_CONFIG_PATH = origConfigPath;
    else delete process.env.OPENCLAW_CONFIG_PATH;
    try {
      rmSync(TEST_SECRETS_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("returns true when Authorization header matches gateway token", async () => {
    writeFileSync(TEST_SECRETS_PATH, JSON.stringify({ gateway: { token: "secret-token-123" } }));

    const { validateGatewayToken } = await import("@/lib/gateway-auth");

    const headers = new Headers({ Authorization: "Bearer secret-token-123" });
    expect(validateGatewayToken(headers)).toBe(true);
  });

  it("returns false when token does not match", async () => {
    writeFileSync(TEST_SECRETS_PATH, JSON.stringify({ gateway: { token: "secret-token-123" } }));

    const { validateGatewayToken } = await import("@/lib/gateway-auth");

    const headers = new Headers({ Authorization: "Bearer wrong-token" });
    expect(validateGatewayToken(headers)).toBe(false);
  });

  it("returns false when Authorization header is missing", async () => {
    writeFileSync(TEST_SECRETS_PATH, JSON.stringify({ gateway: { token: "secret-token-123" } }));

    const { validateGatewayToken } = await import("@/lib/gateway-auth");

    const headers = new Headers();
    expect(validateGatewayToken(headers)).toBe(false);
  });

  it("uses constant-time comparison to prevent timing attacks", async () => {
    const { constantTimeEqual } = await import("@/lib/gateway-auth");

    // timingSafeEqual requires equal-length buffers — our wrapper must handle
    // different lengths safely by returning false (not throwing)
    expect(constantTimeEqual("short", "much-longer-token")).toBe(false);
    expect(constantTimeEqual("much-longer-token", "short")).toBe(false);
    expect(constantTimeEqual("", "non-empty")).toBe(false);
    expect(constantTimeEqual("non-empty", "")).toBe(false);

    // Same-length matching and non-matching
    expect(constantTimeEqual("secret-123", "secret-123")).toBe(true);
    expect(constantTimeEqual("secret-123", "secret-456")).toBe(false);
  });

  it("returns false when secrets file does not exist", async () => {
    // Don't write the secrets file
    try {
      unlinkSync(TEST_SECRETS_PATH);
    } catch {
      // ignore
    }

    const { validateGatewayToken } = await import("@/lib/gateway-auth");

    const headers = new Headers({ Authorization: "Bearer some-token" });
    expect(validateGatewayToken(headers)).toBe(false);
  });

  it("regression: validates against openclaw.json when secrets.json is unreadable (root-owned 0600)", async () => {
    // Reproduces the v0.5.0 staging cold-start bug: start-openclaw.sh chmods
    // secrets.json to root:root 0600 to satisfy OpenClaw's strict secrets-mode
    // check. Pinchy (uid 999) can't read it. Without this fallback, every
    // pinchy-audit before_tool_call hook returns 401 and Smithers can't use
    // any tool — including pinchy-docs, so it can't read the docs.
    //
    // Both files normally carry the same token (regenerateOpenClawConfig writes
    // both). Validation must succeed if EITHER source has a matching token.
    writeFileSync(
      TEST_CONFIG_PATH,
      JSON.stringify({ gateway: { auth: { token: "the-real-token" } } })
    );
    // No secrets.json — simulates the file being unreadable.

    const { validateGatewayToken } = await import("@/lib/gateway-auth");

    const headers = new Headers({ Authorization: "Bearer the-real-token" });
    expect(validateGatewayToken(headers)).toBe(true);
  });
});
