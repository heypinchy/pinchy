import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetSetting = vi.fn();
vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
}));

const mockFindMany = vi.fn();
vi.mock("@/db", () => ({
  db: {
    query: {
      agents: {
        findMany: (...args: unknown[]) => mockFindMany(...args),
      },
    },
  },
}));

import { validateTelegramBotToken, hasMainTelegramBot } from "@/lib/telegram";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

describe("validateTelegramBotToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return bot info for a valid token", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          id: 123456789,
          is_bot: true,
          first_name: "SmithersBot",
          username: "SmithersBot",
        },
      }),
    });

    const result = await validateTelegramBotToken("123:abc");
    expect(result).toEqual({
      valid: true,
      botId: 123456789,
      botUsername: "SmithersBot",
    });
    expect(fetchMock).toHaveBeenCalledWith("https://api.telegram.org/bot123:abc/getMe");
  });

  it("should return invalid for a bad token", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: false,
        description: "Unauthorized",
      }),
    });

    const result = await validateTelegramBotToken("bad-token");
    expect(result).toEqual({ valid: false, error: "Unauthorized" });
  });

  it("should return invalid on network error", async () => {
    fetchMock.mockRejectedValue(new Error("Network error"));

    const result = await validateTelegramBotToken("123:abc");
    expect(result).toEqual({ valid: false, error: "Network error" });
  });

  it("should call the correct Telegram API URL", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: { id: 1, is_bot: true, first_name: "Bot", username: "bot" },
      }),
    });

    await validateTelegramBotToken("token123:xyz");
    expect(fetchMock).toHaveBeenCalledWith("https://api.telegram.org/bottoken123:xyz/getMe");
  });

  it("should use TELEGRAM_API_URL env var when set", async () => {
    process.env.TELEGRAM_API_URL = "http://mock-telegram:9001";
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: { id: 42, is_bot: true, first_name: "TestBot", username: "test_bot" },
      }),
    });

    const result = await validateTelegramBotToken("test-token:abc");
    expect(fetchMock).toHaveBeenCalledWith("http://mock-telegram:9001/bottest-token:abc/getMe");
    expect(result).toEqual({ valid: true, botId: 42, botUsername: "test_bot" });

    delete process.env.TELEGRAM_API_URL;
  });
});

describe("hasMainTelegramBot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false when there are no personal agents", async () => {
    mockFindMany.mockResolvedValueOnce([]);
    await expect(hasMainTelegramBot()).resolves.toBe(false);
    expect(mockGetSetting).not.toHaveBeenCalled();
  });

  it("returns false when no personal agent has a telegram bot token", async () => {
    mockFindMany.mockResolvedValueOnce([{ id: "smithers-1" }, { id: "smithers-2" }]);
    mockGetSetting.mockResolvedValue(null);
    await expect(hasMainTelegramBot()).resolves.toBe(false);
    expect(mockGetSetting).toHaveBeenCalledWith("telegram_bot_token:smithers-1");
    expect(mockGetSetting).toHaveBeenCalledWith("telegram_bot_token:smithers-2");
  });

  it("returns true when a personal agent has a telegram bot token", async () => {
    mockFindMany.mockResolvedValueOnce([{ id: "smithers-1" }, { id: "smithers-2" }]);
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:smithers-2") return "123456:ABC-token";
      return null;
    });
    await expect(hasMainTelegramBot()).resolves.toBe(true);
  });

  it("short-circuits as soon as it finds a token", async () => {
    mockFindMany.mockResolvedValueOnce([
      { id: "smithers-1" },
      { id: "smithers-2" },
      { id: "smithers-3" },
    ]);
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:smithers-1") return "123456:ABC-token";
      return null;
    });
    await expect(hasMainTelegramBot()).resolves.toBe(true);
    // Should not query the 2nd and 3rd agents once it found the first one
    expect(mockGetSetting).toHaveBeenCalledTimes(1);
  });

  it("treats an empty-string token as not configured", async () => {
    mockFindMany.mockResolvedValueOnce([{ id: "smithers-1" }]);
    mockGetSetting.mockResolvedValueOnce("");
    await expect(hasMainTelegramBot()).resolves.toBe(false);
  });
});
