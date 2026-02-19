import { describe, it, expect, vi, beforeEach } from "vitest";
import { getSetting, setSetting } from "@/lib/settings";

vi.mock("@/db", () => {
  return {
    db: {
      query: {
        settings: {
          findFirst: vi.fn().mockResolvedValue(undefined),
        },
      },
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue([]),
      }),
    },
  };
});

vi.mock("@/lib/encryption", () => ({
  encrypt: vi.fn((val: string) => `encrypted:${val}`),
  decrypt: vi.fn((val: string) => val.replace("encrypted:", "")),
}));

import { db } from "@/db";
import { encrypt, decrypt } from "@/lib/encryption";

describe("settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return null for missing setting", async () => {
    const result = await getSetting("nonexistent");
    expect(result).toBeNull();
  });

  it("should encrypt value when encrypted flag is true", async () => {
    await setSetting("anthropic_api_key", "sk-ant-secret", true);

    expect(encrypt).toHaveBeenCalledWith("sk-ant-secret");
    expect(db.insert).toHaveBeenCalled();
  });

  it("should not encrypt value when encrypted flag is false", async () => {
    await setSetting("default_provider", "anthropic", false);

    expect(encrypt).not.toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalled();
  });

  it("should decrypt value when reading encrypted setting", async () => {
    vi.mocked(db.query.settings.findFirst).mockResolvedValue({
      key: "anthropic_api_key",
      value: "encrypted:sk-ant-secret",
      encrypted: true,
    });

    const result = await getSetting("anthropic_api_key");

    expect(decrypt).toHaveBeenCalledWith("encrypted:sk-ant-secret");
    expect(result).toBe("sk-ant-secret");
  });

  it("should return raw value for non-encrypted setting", async () => {
    vi.mocked(db.query.settings.findFirst).mockResolvedValue({
      key: "default_provider",
      value: "anthropic",
      encrypted: false,
    });

    const result = await getSetting("default_provider");

    expect(decrypt).not.toHaveBeenCalled();
    expect(result).toBe("anthropic");
  });
});
