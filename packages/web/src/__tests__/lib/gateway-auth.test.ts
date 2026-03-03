import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_CONFIG_DIR = join(tmpdir(), "pinchy-gateway-auth-test");
const TEST_CONFIG_PATH = join(TEST_CONFIG_DIR, "openclaw.json");

describe("validateGatewayToken", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.OPENCLAW_CONFIG_PATH = TEST_CONFIG_PATH;
    if (!existsSync(TEST_CONFIG_DIR)) {
      mkdirSync(TEST_CONFIG_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    delete process.env.OPENCLAW_CONFIG_PATH;
    try {
      unlinkSync(TEST_CONFIG_PATH);
    } catch {
      // ignore
    }
  });

  it("returns true when Authorization header matches gateway token", async () => {
    writeFileSync(
      TEST_CONFIG_PATH,
      JSON.stringify({ gateway: { auth: { token: "secret-token-123" } } })
    );

    const { validateGatewayToken } = await import("@/lib/gateway-auth");

    const headers = new Headers({ Authorization: "Bearer secret-token-123" });
    expect(validateGatewayToken(headers)).toBe(true);
  });

  it("returns false when token does not match", async () => {
    writeFileSync(
      TEST_CONFIG_PATH,
      JSON.stringify({ gateway: { auth: { token: "secret-token-123" } } })
    );

    const { validateGatewayToken } = await import("@/lib/gateway-auth");

    const headers = new Headers({ Authorization: "Bearer wrong-token" });
    expect(validateGatewayToken(headers)).toBe(false);
  });

  it("returns false when Authorization header is missing", async () => {
    writeFileSync(
      TEST_CONFIG_PATH,
      JSON.stringify({ gateway: { auth: { token: "secret-token-123" } } })
    );

    const { validateGatewayToken } = await import("@/lib/gateway-auth");

    const headers = new Headers();
    expect(validateGatewayToken(headers)).toBe(false);
  });

  it("returns false when config file does not exist", async () => {
    // Don't write the config file
    try {
      unlinkSync(TEST_CONFIG_PATH);
    } catch {
      // ignore
    }

    const { validateGatewayToken } = await import("@/lib/gateway-auth");

    const headers = new Headers({ Authorization: "Bearer some-token" });
    expect(validateGatewayToken(headers)).toBe(false);
  });
});
