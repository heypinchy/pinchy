// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import plugin, {
  buildPayload,
  parseDirectSessionKey,
  surrogateId,
  postChannelMessage,
} from "./index";

const SK = "agent:agent-1:direct:tg-peer-111";

describe("parseDirectSessionKey", () => {
  it("parses a direct session key into agentId + peer", () => {
    expect(parseDirectSessionKey(SK)).toEqual({ agentId: "agent-1", peer: "tg-peer-111" });
  });
  it("rejects non-direct scopes and garbage", () => {
    expect(parseDirectSessionKey("agent:a:group:g")).toBeNull();
    expect(parseDirectSessionKey("nope")).toBeNull();
    expect(parseDirectSessionKey(undefined)).toBeNull();
  });
});

describe("buildPayload", () => {
  const base = {
    channel: "telegram",
    sessionKey: SK,
    direction: "inbound" as const,
    content: "  Hello over Telegram  ",
    messageId: "msg-42",
    sentAt: 1700000000000,
  };

  it("builds an inbound telegram payload: trimmed content, messageId as externalId (peer derived server-side)", () => {
    expect(buildPayload(base)).toEqual({
      channel: "telegram",
      sessionKey: SK,
      direction: "inbound",
      externalId: "msg-42",
      content: "Hello over Telegram",
      sentAt: 1700000000000,
    });
  });

  it("falls back to a deterministic surrogate externalId when messageId is absent", () => {
    const p = buildPayload({ ...base, messageId: undefined });
    expect(p?.externalId).toBe(surrogateId("inbound", "Hello over Telegram", 1700000000000));
    // Stable across calls so retries dedup.
    expect(buildPayload({ ...base, messageId: undefined })?.externalId).toBe(p?.externalId);
  });

  it("skips non-mirrored channels", () => {
    expect(buildPayload({ ...base, channel: "discord" })).toBeNull();
    expect(buildPayload({ ...base, channel: undefined })).toBeNull();
  });

  it("skips non-direct sessions (group/other scopes are not mirrored)", () => {
    expect(buildPayload({ ...base, sessionKey: "agent:a:group:g" })).toBeNull();
  });

  it("skips empty / whitespace-only content", () => {
    expect(buildPayload({ ...base, content: "   " })).toBeNull();
    expect(buildPayload({ ...base, content: undefined })).toBeNull();
  });
});

describe("postChannelMessage", () => {
  const cfg = { apiBaseUrl: "http://pinchy:7777/", gatewayToken: "tok" };
  const payload = {
    channel: "telegram",
    sessionKey: SK,
    direction: "inbound" as const,
    externalId: "msg-42",
    content: "hi",
    sentAt: 1,
  };

  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("POSTs to the capture endpoint with bearer auth and the payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await postChannelMessage(cfg, undefined, payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // Trailing slash on apiBaseUrl is normalized away.
    expect(url).toBe("http://pinchy:7777/api/internal/channel-messages");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse((init as { body: string }).body)).toEqual(payload);
  });

  it("does NOT retry a 4xx (our bug — server keeps rejecting)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    vi.stubGlobal("fetch", fetchMock);
    await postChannelMessage(cfg, undefined, payload); // returns, no throw
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx and throws after exhausting retries", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchMock);
    await expect(postChannelMessage(cfg, undefined, payload)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + MAX_RETRIES(2)
  });
});

describe("plugin.register", () => {
  const cfg = { apiBaseUrl: "http://pinchy:7777", gatewayToken: "tok" };

  function fakeApi() {
    const handlers: Record<string, (e: unknown, c: unknown) => Promise<void> | void> = {};
    return {
      pluginConfig: cfg,
      logger: { warn: vi.fn() },
      on: (name: string, h: (e: unknown, c: unknown) => Promise<void> | void) => {
        handlers[name] = h;
      },
      handlers,
    };
  }

  beforeEach(() => vi.restoreAllMocks());

  it("captures an inbound telegram message via message_received", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const api = fakeApi();
    plugin.register(api as never);

    await api.handlers["message_received"](
      { content: "Hi from TG", messageId: "m1", sessionKey: SK, timestamp: 1700000000000 },
      { channelId: "telegram" }
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ direction: "inbound", sessionKey: SK, content: "Hi from TG" });
  });

  it("captures a delivered outbound reply but SKIPS a failed delivery", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const api = fakeApi();
    plugin.register(api as never);

    await api.handlers["message_sent"](
      { content: "reply", messageId: "m2", sessionKey: SK, success: true },
      { channelId: "telegram" }
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ direction: "outbound" });

    fetchMock.mockClear();
    await api.handlers["message_sent"](
      { content: "undelivered", messageId: "m3", sessionKey: SK, success: false },
      { channelId: "telegram" }
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not register hooks when config is missing", () => {
    const api = fakeApi();
    api.pluginConfig = undefined as never;
    plugin.register(api as never);
    expect(Object.keys(api.handlers)).toHaveLength(0);
    expect(api.logger.warn).toHaveBeenCalled();
  });
});
