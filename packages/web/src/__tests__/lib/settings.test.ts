import { describe, it, expect, vi, beforeEach } from "vitest";

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
      from: vi.fn().mockResolvedValue([]),
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
  beforeEach(() => vi.clearAllMocks());

  it("stores plain value when encrypted=false", async () => {
    await setSetting("default_provider", "openai", false);
    expect(encrypt).not.toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalled();
  });

  it("encrypts value when encrypted=true", async () => {
    await setSetting("anthropic_api_key", "sk-ant-secret", true);
    expect(encrypt).toHaveBeenCalledWith("sk-ant-secret");
    expect(db.insert).toHaveBeenCalled();
  });

  it("defaults to unencrypted when encrypted param omitted", async () => {
    await setSetting("some_key", "some_value");
    expect(encrypt).not.toHaveBeenCalled();
  });
});

describe("deleteSetting", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls db.delete with the correct key", async () => {
    await deleteSetting("anthropic_api_key");
    expect(db.delete).toHaveBeenCalled();
  });
});

describe("getAllSettings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns all settings rows", async () => {
    const rows = [
      { key: "default_provider", value: "anthropic", encrypted: false },
      { key: "anthropic_api_key", value: "encrypted:...", encrypted: true },
    ];
    vi.mocked(db.select().from).mockResolvedValueOnce(rows);
    const result = await getAllSettings();
    expect(result).toEqual(rows);
  });
});
