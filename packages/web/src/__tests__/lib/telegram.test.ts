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

import {
  validateTelegramBotToken,
  hasMainTelegramBot,
  probeTelegramPollingConflict,
} from "@/lib/telegram";

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
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123:abc/getMe",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
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
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottoken123:xyz/getMe",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
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
    expect(fetchMock).toHaveBeenCalledWith(
      "http://mock-telegram:9001/bottest-token:abc/getMe",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(result).toEqual({ valid: true, botId: 42, botUsername: "test_bot" });

    delete process.env.TELEGRAM_API_URL;
  });
});

describe("probeTelegramPollingConflict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns conflict: true on a 409 getUpdates response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        ok: false,
        error_code: 409,
        description:
          "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
      }),
    });

    const result = await probeTelegramPollingConflict("123456:ABC-token");
    expect(result).toEqual({ conflict: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123456:ABC-token/getUpdates",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ timeout: 1 }),
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("returns conflict: true when error_code is 409 even if the HTTP status is 200", async () => {
    // Some Telegram-compatible endpoints (and our E2E mock) return the error
    // envelope with a 200 HTTP status. The body's error_code is authoritative,
    // so the probe must still detect the conflict — regression guard for the
    // #476/#477 E2E where the mock answers getUpdates with HTTP 200 + body 409.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: false,
        error_code: 409,
        description:
          "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
      }),
    });

    const result = await probeTelegramPollingConflict("123456:ABC-token");
    expect(result).toEqual({ conflict: true });
  });

  it("returns conflict: false on a 200 getUpdates response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: [] }),
    });

    const result = await probeTelegramPollingConflict("123456:ABC-token");
    expect(result).toEqual({ conflict: false });
  });

  it("returns conflict: false on a non-409 error status", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, error_code: 401, description: "Unauthorized" }),
    });

    const result = await probeTelegramPollingConflict("123456:ABC-token");
    expect(result).toEqual({ conflict: false });
  });

  it("returns conflict: false on a network error / timeout", async () => {
    fetchMock.mockRejectedValue(new Error("Network error"));

    const result = await probeTelegramPollingConflict("123456:ABC-token");
    expect(result).toEqual({ conflict: false });
  });

  it("uses TELEGRAM_API_URL env var when set", async () => {
    process.env.TELEGRAM_API_URL = "http://mock-telegram:9001";
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: [] }),
    });

    await probeTelegramPollingConflict("test-token:abc");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://mock-telegram:9001/bottest-token:abc/getUpdates",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ timeout: 1 }),
        signal: expect.any(AbortSignal),
      })
    );

    delete process.env.TELEGRAM_API_URL;
  });

  it("applies a short internal timeout so a hanging getUpdates can't stall the caller", async () => {
    fetchMock.mockImplementation((_url: string, opts: { signal?: AbortSignal }) => {
      expect(opts.signal).toBeInstanceOf(AbortSignal);
      return new Promise(() => {
        // never resolves — the AbortSignal is what must save us
      });
    });

    // Not awaiting the hang itself; just assert the call was made with a signal.
    void probeTelegramPollingConflict("123456:ABC-token");
    expect(fetchMock).toHaveBeenCalled();
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
