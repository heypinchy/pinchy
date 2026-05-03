import { describe, it, expect, vi, beforeEach } from "vitest";

const { existsSyncMock, readFileSyncMock, mockedGetSetting, mockedSetSetting } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  mockedGetSetting: vi.fn(),
  mockedSetSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: { ...actual, existsSync: existsSyncMock, readFileSync: readFileSyncMock },
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
  };
});

vi.mock("@/lib/settings", () => ({
  getSetting: mockedGetSetting,
  setSetting: mockedSetSetting,
}));

import { migrateGatewayTokenToDb } from "@/lib/migrate-gateway-token";

describe("migrateGatewayTokenToDb", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("copies gateway token from existing openclaw.json into settings when DB has none", async () => {
    mockedGetSetting.mockResolvedValue(null);
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ gateway: { auth: { token: "abc123-gateway-token" } } })
    );

    await migrateGatewayTokenToDb();

    expect(mockedSetSetting).toHaveBeenCalledWith("openclaw_gateway_token", "abc123-gateway-token");
  });

  it("is a no-op when openclaw_gateway_token is already in DB (DB wins)", async () => {
    mockedGetSetting.mockResolvedValue("existing-db-token");
    existsSyncMock.mockReturnValue(true);

    await migrateGatewayTokenToDb();

    expect(mockedSetSetting).not.toHaveBeenCalled();
  });

  it("is a no-op when openclaw.json does not exist on disk", async () => {
    mockedGetSetting.mockResolvedValue(null);
    existsSyncMock.mockReturnValue(false);

    await migrateGatewayTokenToDb();

    expect(mockedSetSetting).not.toHaveBeenCalled();
  });

  it("is a no-op when openclaw.json has no gateway.auth.token", async () => {
    mockedGetSetting.mockResolvedValue(null);
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify({ gateway: { mode: "local" } }));

    await migrateGatewayTokenToDb();

    expect(mockedSetSetting).not.toHaveBeenCalled();
  });
});
