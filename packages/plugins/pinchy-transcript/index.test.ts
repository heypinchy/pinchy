// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import plugin, {
  buildPayload,
  parseDirectSessionKey,
  surrogateId,
  postChannelMessage,
  extractMedia,
} from "./index";

const SK = "agent:agent-1:direct:tg-peer-111";

describe("parseDirectSessionKey", () => {
  it("parses a direct session key into agentId + peer", () => {
    expect(parseDirectSessionKey(SK)).toEqual({
      agentId: "agent-1",
      peer: "tg-peer-111",
    });
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
    expect(p?.externalId).toBe(
      surrogateId("inbound", "Hello over Telegram", 1700000000000),
    );
    // Stable across calls so retries dedup.
    expect(buildPayload({ ...base, messageId: undefined })?.externalId).toBe(
      p?.externalId,
    );
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

  it("includes media in the payload when provided", () => {
    const media = [
      { path: "/root/.openclaw/media/inbound/x.jpg", mimeType: "image/jpeg" },
    ];
    expect(buildPayload({ ...base, media })).toEqual({
      channel: "telegram",
      sessionKey: SK,
      direction: "inbound",
      externalId: "msg-42",
      content: "Hello over Telegram",
      sentAt: 1700000000000,
      media,
    });
  });

  it("does not include a media key when none is provided", () => {
    const payload = buildPayload(base);
    expect(payload).not.toHaveProperty("media");
  });

  it("photo-only message: empty/whitespace content WITH media uses the <media> placeholder instead of being dropped", () => {
    const media = [
      { path: "/root/.openclaw/media/inbound/x.jpg", mimeType: "image/jpeg" },
    ];
    const p1 = buildPayload({ ...base, content: "", media });
    expect(p1).not.toBeNull();
    expect(p1?.content).toBe("<media>");
    expect(p1?.media).toEqual(media);

    const p2 = buildPayload({ ...base, content: "   ", media });
    expect(p2?.content).toBe("<media>");
  });

  it("empty content AND no media still returns null (unchanged)", () => {
    expect(buildPayload({ ...base, content: "" })).toBeNull();
    expect(
      buildPayload({ ...base, content: "   ", media: undefined }),
    ).toBeNull();
  });
});

describe("extractMedia", () => {
  it("maps mediaPaths + mediaTypes by index into {path, mimeType}", () => {
    expect(
      extractMedia({
        metadata: {
          mediaPaths: ["/root/.openclaw/media/inbound/x.jpg"],
          mediaTypes: ["image/jpeg"],
        },
      }),
    ).toEqual([
      { path: "/root/.openclaw/media/inbound/x.jpg", mimeType: "image/jpeg" },
    ]);
  });

  it("tolerates a short/missing mediaTypes array (no mimeType key for the missing entry)", () => {
    const result = extractMedia({
      metadata: {
        mediaPaths: ["/a.jpg", "/b.png"],
        mediaTypes: ["image/jpeg"],
      },
    });
    expect(result).toEqual([
      { path: "/a.jpg", mimeType: "image/jpeg" },
      { path: "/b.png" },
    ]);
    expect(result?.[1]).not.toHaveProperty("mimeType");
  });

  it("filters out non-string/empty paths", () => {
    const result = extractMedia({
      metadata: { mediaPaths: ["/a.jpg", "", null, 42, "/b.jpg"] },
    });
    expect(result).toEqual([{ path: "/a.jpg" }, { path: "/b.jpg" }]);
  });

  it("returns undefined when there is no usable media", () => {
    expect(extractMedia({})).toBeUndefined();
    expect(extractMedia({ metadata: {} })).toBeUndefined();
    expect(extractMedia({ metadata: { mediaPaths: [] } })).toBeUndefined();
    expect(
      extractMedia({ metadata: { mediaPaths: ["", null] } }),
    ).toBeUndefined();
    expect(extractMedia({ metadata: undefined })).toBeUndefined();
  });

  it("caps at 20 entries, mirroring the server schema's cap", () => {
    const mediaPaths = Array.from({ length: 25 }, (_, i) => `/media-${i}.jpg`);
    const result = extractMedia({ metadata: { mediaPaths } });
    expect(result).toHaveLength(20);
    expect(result?.[19]).toEqual({ path: "/media-19.jpg" });
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
    expect(
      (init as { headers: Record<string, string> }).headers.Authorization,
    ).toBe("Bearer tok");
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
    const handlers: Record<
      string,
      (e: unknown, c: unknown) => Promise<void> | void
    > = {};
    return {
      pluginConfig: cfg,
      logger: { warn: vi.fn() },
      on: (
        name: string,
        h: (e: unknown, c: unknown) => Promise<void> | void,
      ) => {
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
      {
        content: "Hi from TG",
        messageId: "m1",
        sessionKey: SK,
        timestamp: 1700000000000,
      },
      { channelId: "telegram" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      direction: "inbound",
      sessionKey: SK,
      content: "Hi from TG",
    });
  });

  it("passes extracted media through on message_received", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const api = fakeApi();
    plugin.register(api as never);

    await api.handlers["message_received"](
      {
        content: "Hi from TG",
        messageId: "m1",
        sessionKey: SK,
        timestamp: 1700000000000,
        metadata: {
          mediaPaths: ["/root/.openclaw/media/inbound/x.jpg"],
          mediaTypes: ["image/jpeg"],
        },
      },
      { channelId: "telegram" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.media).toEqual([
      { path: "/root/.openclaw/media/inbound/x.jpg", mimeType: "image/jpeg" },
    ]);
  });

  it("does NOT attach media handling to message_sent (outbound media reporting is out of scope)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const api = fakeApi();
    plugin.register(api as never);

    await api.handlers["message_sent"](
      {
        content: "reply",
        messageId: "m2",
        sessionKey: SK,
        success: true,
        metadata: { mediaPaths: ["/should-be-ignored.jpg"] },
      },
      { channelId: "telegram" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("media");
  });

  it("captures a delivered outbound reply but SKIPS a failed delivery", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const api = fakeApi();
    plugin.register(api as never);

    await api.handlers["message_sent"](
      { content: "reply", messageId: "m2", sessionKey: SK, success: true },
      { channelId: "telegram" },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      direction: "outbound",
    });

    fetchMock.mockClear();
    await api.handlers["message_sent"](
      {
        content: "undelivered",
        messageId: "m3",
        sessionKey: SK,
        success: false,
      },
      { channelId: "telegram" },
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
