import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateTelegramBotToken } from "@/lib/telegram";

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
