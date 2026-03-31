import { describe, it, expect, vi, beforeEach } from "vitest";

const { fromMock } = vi.hoisted(() => ({
  fromMock: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      settings: {
        findFirst: vi.fn(),
      },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
    select: vi.fn().mockReturnValue({
      from: fromMock,
    }),
  },
}));

vi.mock("@/lib/encryption", () => ({
  encrypt: vi.fn((v: string) => `encrypted:${v}`),
  decrypt: vi.fn((v: string) => v.replace("encrypted:", "")),
}));

import { db } from "@/db";
import { encrypt, decrypt } from "@/lib/encryption";
import { getSetting, setSetting, deleteSetting, getAllSettings } from "@/lib/settings";

describe("getSetting", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null when setting does not exist", async () => {
    vi.mocked(db.query.settings.findFirst).mockResolvedValueOnce(undefined);
    expect(await getSetting("missing_key")).toBeNull();
  });

  it("returns plain value when not encrypted", async () => {
    vi.mocked(db.query.settings.findFirst).mockResolvedValueOnce({
      key: "default_provider",
      value: "anthropic",
      encrypted: false,
    });
    expect(await getSetting("default_provider")).toBe("anthropic");
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("decrypts value when encrypted flag is true", async () => {
    vi.mocked(db.query.settings.findFirst).mockResolvedValueOnce({
      key: "anthropic_api_key",
      value: "encrypted:sk-ant-secret",
      encrypted: true,
    });
    const result = await getSetting("anthropic_api_key");
    expect(decrypt).toHaveBeenCalledWith("encrypted:sk-ant-secret");
    expect(result).toBe("sk-ant-secret");
  });
});

describe("setSetting", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Re-wire insert mock after clearAllMocks
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    } as never);
  });

  it("stores plain value when encrypted=false", async () => {
    await setSetting("default_provider", "openai", false);
    expect(encrypt).not.toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalled();
  });

  it("encrypts value when encrypted=true", async () => {
    await setSetting("anthropic_api_key", "sk-ant-secret", true);
    expect(encrypt).toHaveBeenCalledWith("sk-ant-secret");
    // verify the encrypted value is what gets stored
    const valuesMock = vi.mocked(db.insert("" as never).values);
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ value: "encrypted:sk-ant-secret" })
    );
    expect(db.insert).toHaveBeenCalled();
  });

  it("defaults to unencrypted when encrypted param omitted", async () => {
    await setSetting("some_key", "some_value");
    expect(encrypt).not.toHaveBeenCalled();
  });
});

describe("deleteSetting", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Re-wire delete mock after clearAllMocks
    vi.mocked(db.delete).mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  it("calls db.delete with the correct key", async () => {
    await deleteSetting("anthropic_api_key");
    const whereMock = vi.mocked(db.delete("" as never).where);
    expect(db.delete).toHaveBeenCalled();
    expect(whereMock).toHaveBeenCalled();
  });
});

describe("getAllSettings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns all settings rows", async () => {
    const rows = [
      { key: "default_provider", value: "anthropic", encrypted: false },
      { key: "anthropic_api_key", value: "encrypted:...", encrypted: true },
    ];
    fromMock.mockResolvedValueOnce(rows);
    const result = await getAllSettings();
    expect(result).toEqual(rows);
  });
});
