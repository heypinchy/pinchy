import { describe, it, expect, vi, afterEach } from "vitest";
import { reportUsage } from "./usage-reporter";

describe("reportUsage", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("skips the POST entirely when both token counts are zero", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    await reportUsage(
      {
        agentId: "kb-agent",
        agentName: "KB Agent",
        sessionKey: "plugin:pinchy-files",
        model: "anthropic/claude-haiku-4-5-20251001",
        inputTokens: 0,
        outputTokens: 0,
      },
      { apiBaseUrl: "http://pinchy:7777", gatewayToken: "gw-token" },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts aggregated usage to /api/internal/usage/record with gateway bearer auth", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    globalThis.fetch = fetchSpy;

    await reportUsage(
      {
        agentId: "kb-agent",
        agentName: "KB Agent",
        sessionKey: "plugin:pinchy-files",
        model: "anthropic/claude-haiku-4-5-20251001",
        inputTokens: 1234,
        outputTokens: 56,
      },
      { apiBaseUrl: "http://pinchy:7777", gatewayToken: "gw-token" },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://pinchy:7777/api/internal/usage/record");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe("Bearer gw-token");

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      agentId: "kb-agent",
      agentName: "KB Agent",
      userId: "system",
      sessionKey: "plugin:pinchy-files",
      model: "anthropic/claude-haiku-4-5-20251001",
      inputTokens: 1234,
      outputTokens: 56,
    });
  });

  it("strips a trailing slash from apiBaseUrl so the URL stays well-formed", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    globalThis.fetch = fetchSpy;

    await reportUsage(
      {
        agentId: "kb-agent",
        agentName: "KB Agent",
        sessionKey: "plugin:pinchy-files",
        model: "anthropic/claude-haiku-4-5-20251001",
        inputTokens: 1,
        outputTokens: 1,
      },
      { apiBaseUrl: "http://pinchy:7777/", gatewayToken: "gw-token" },
    );

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://pinchy:7777/api/internal/usage/record");
  });

  it("still POSTs when only output tokens are present", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    globalThis.fetch = fetchSpy;

    await reportUsage(
      {
        agentId: "kb-agent",
        agentName: "KB Agent",
        sessionKey: "plugin:pinchy-files",
        inputTokens: 0,
        outputTokens: 10,
      },
      { apiBaseUrl: "http://pinchy:7777", gatewayToken: "gw-token" },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("logs without throwing when the endpoint responds with a non-2xx status", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
    });
    globalThis.fetch = fetchSpy;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      reportUsage(
        {
          agentId: "kb-agent",
          agentName: "KB Agent",
          sessionKey: "plugin:pinchy-files",
          inputTokens: 10,
          outputTokens: 5,
        },
        { apiBaseUrl: "http://pinchy:7777", gatewayToken: "gw-token" },
      ),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("swallows fetch errors so PDF reads never fail on telemetry hiccups", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      reportUsage(
        {
          agentId: "kb-agent",
          agentName: "KB Agent",
          sessionKey: "plugin:pinchy-files",
          inputTokens: 10,
          outputTokens: 5,
        },
        { apiBaseUrl: "http://pinchy:7777", gatewayToken: "gw-token" },
      ),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
