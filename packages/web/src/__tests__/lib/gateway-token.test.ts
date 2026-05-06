import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/gateway-token-reader", () => ({
  readGatewayToken: vi.fn().mockReturnValue(""),
}));

describe("getOrCreateGatewayToken", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns an existing token from settings without generating a new one", async () => {
    const { getSetting, setSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockResolvedValue(
      "existing-token-abc123deadbeef000000000000000000000000000000000000"
    );

    const { getOrCreateGatewayToken } = await import("@/lib/gateway-token-source");
    const token = await getOrCreateGatewayToken();

    expect(token).toBe("existing-token-abc123deadbeef000000000000000000000000000000000000");
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("generates a 48-hex-char random token when none exists in settings", async () => {
    const { getSetting, setSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockResolvedValue(null);

    const { getOrCreateGatewayToken } = await import("@/lib/gateway-token-source");
    const token = await getOrCreateGatewayToken();

    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(setSetting).toHaveBeenCalledWith("openclaw_gateway_token", token);
  });

  it("persists the generated token under the openclaw_gateway_token settings key", async () => {
    const { getSetting, setSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockResolvedValue(null);

    const { getOrCreateGatewayToken } = await import("@/lib/gateway-token-source");
    const token = await getOrCreateGatewayToken();

    expect(setSetting).toHaveBeenCalledTimes(1);
    expect(setSetting).toHaveBeenCalledWith("openclaw_gateway_token", token);
  });

  it("adopts token from existing config when DB is empty (OpenClaw-generated token scenario)", async () => {
    const { getSetting, setSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockResolvedValue(null);

    const { readGatewayToken } = await import("@/lib/gateway-token-reader");
    vi.mocked(readGatewayToken).mockReturnValue("openclaw-generated-abc123def456ghi789jkl");

    const { getOrCreateGatewayToken } = await import("@/lib/gateway-token-source");
    const token = await getOrCreateGatewayToken();

    expect(token).toBe("openclaw-generated-abc123def456ghi789jkl");
    expect(setSetting).toHaveBeenCalledWith(
      "openclaw_gateway_token",
      "openclaw-generated-abc123def456ghi789jkl"
    );
  });

  it("generates a new token when both DB and config file have no token", async () => {
    const { getSetting, setSetting } = await import("@/lib/settings");
    vi.mocked(getSetting).mockResolvedValue(null);

    const { readGatewayToken } = await import("@/lib/gateway-token-reader");
    vi.mocked(readGatewayToken).mockReturnValue("");

    const { getOrCreateGatewayToken } = await import("@/lib/gateway-token-source");
    const token = await getOrCreateGatewayToken();

    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(setSetting).toHaveBeenCalledWith("openclaw_gateway_token", token);
  });
});
