// @vitest-environment node
import { mkdtemp, writeFile, readFile, symlink, truncate, mkdir, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import plugin, {
  buildPayload,
  parseDirectSessionKey,
  shouldMirror,
  surrogateId,
  postChannelMessage,
  extractMedia,
  mirrorMedia,
  MAX_MIRRORED_MEDIA_BYTES,
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

describe("shouldMirror", () => {
  // shouldMirror is the gate that keeps a media copy from ever happening for a
  // message that buildPayload would then drop — otherwise the file would land
  // in uploads/ with no corresponding capture or audit row (see the function's
  // doc comment). It MUST agree with buildPayload's own channel + direct-session
  // gates, so these cases mirror buildPayload's own "skips …" tests.
  it("returns the agentId for a captured channel + direct session", () => {
    expect(shouldMirror("telegram", SK)).toEqual({ agentId: "agent-1" });
  });

  it("returns null for a NON-captured channel even with a valid direct session (no un-audited uploads write)", () => {
    expect(shouldMirror("slack", SK)).toBeNull();
    expect(shouldMirror("discord", SK)).toBeNull();
  });

  it("returns null for a captured channel that is not a direct session", () => {
    expect(shouldMirror("telegram", "agent:agent-1:group:g")).toBeNull();
    expect(shouldMirror("telegram", "garbage")).toBeNull();
  });

  it("returns null when the channel is undefined", () => {
    expect(shouldMirror(undefined, SK)).toBeNull();
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

  it("includes media in the payload when provided", () => {
    // buildPayload only ever receives mirrored results (the handler mirrors
    // before building), so fixtures carry the per-file outcome.
    const media = [
      {
        path: "/root/.openclaw/media/inbound/x.jpg",
        mimeType: "image/jpeg",
        outcome: "success" as const,
        bytes: 1024,
      },
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
      {
        path: "/root/.openclaw/media/inbound/x.jpg",
        mimeType: "image/jpeg",
        outcome: "success" as const,
        bytes: 1024,
      },
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
    expect(buildPayload({ ...base, content: "   ", media: undefined })).toBeNull();
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
      })
    ).toEqual([{ path: "/root/.openclaw/media/inbound/x.jpg", mimeType: "image/jpeg" }]);
  });

  it("tolerates a short/missing mediaTypes array (no mimeType key for the missing entry)", () => {
    const result = extractMedia({
      metadata: {
        mediaPaths: ["/a.jpg", "/b.png"],
        mediaTypes: ["image/jpeg"],
      },
    });
    expect(result).toEqual([{ path: "/a.jpg", mimeType: "image/jpeg" }, { path: "/b.png" }]);
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
    expect(extractMedia({ metadata: { mediaPaths: ["", null] } })).toBeUndefined();
    expect(extractMedia({ metadata: undefined })).toBeUndefined();
  });

  it("caps at 20 entries, mirroring the server schema's cap", () => {
    const mediaPaths = Array.from({ length: 25 }, (_, i) => `/media-${i}.jpg`);
    const result = extractMedia({ metadata: { mediaPaths } });
    expect(result).toHaveLength(20);
    expect(result?.[19]).toEqual({ path: "/media-19.jpg" });
  });
});

// Ported 1:1 from the now-removed packages/web/src/server/channel-media.ts
// and its packages/web/src/__tests__/server/channel-media.test.ts — the copy
// logic moved into this plugin (root inside the OpenClaw container) because
// the non-root web process gets EACCES on OpenClaw's 0700 media store. Real
// tmp dirs, no fs mocking, matching the original test style.
describe("mirrorMedia", () => {
  let inboundDir: string;
  let workspaceRoot: string;
  const agentId = "agent-1";

  beforeEach(async () => {
    inboundDir = await mkdtemp(join(tmpdir(), "inbound-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
  });

  it("copies a reported file into <workspaceRoot>/<agentId>/uploads/<basename> (was: 'copies a reported file...')", async () => {
    const source = join(inboundDir, "photo.jpg");
    await writeFile(source, "binary-jpeg-content");

    const results = await mirrorMedia([{ path: source, mimeType: "image/jpeg" }], {
      agentId,
      inboundDir,
      workspaceRoot,
    });

    expect(results).toEqual([
      {
        path: source,
        mimeType: "image/jpeg",
        bytes: "binary-jpeg-content".length,
        outcome: "success",
      },
    ]);

    const target = join(workspaceRoot, agentId, "uploads", "photo.jpg");
    const copied = await readFile(target, "utf-8");
    expect(copied).toBe("binary-jpeg-content");
  });

  it("is idempotent: running twice both succeed and content is unchanged (was: 'is idempotent...')", async () => {
    const source = join(inboundDir, "note.txt");
    await writeFile(source, "hello world");

    const first = await mirrorMedia([{ path: source }], { agentId, inboundDir, workspaceRoot });
    expect(first[0].outcome).toBe("success");

    const second = await mirrorMedia([{ path: source }], { agentId, inboundDir, workspaceRoot });
    expect(second[0].outcome).toBe("success");

    const target = join(workspaceRoot, agentId, "uploads", "note.txt");
    const content = await readFile(target, "utf-8");
    expect(content).toBe("hello world");
  });

  it("uses only the basename of a hostile reported path, but preserves the original path in the result (was: 'uses only the basename...')", async () => {
    const source = join(inboundDir, "x.jpg");
    await writeFile(source, "content");

    const results = await mirrorMedia([{ path: "/etc/../whatever/x.jpg" }], {
      agentId,
      inboundDir,
      workspaceRoot,
    });

    expect(results[0].outcome).toBe("success");
    expect(results[0].path).toBe("/etc/../whatever/x.jpg");
    const target = join(workspaceRoot, agentId, "uploads", "x.jpg");
    const copied = await readFile(target, "utf-8");
    expect(copied).toBe("content");
  });

  it("rejects unsafe basenames: dotfiles and backslashes (was: 'rejects unsafe basenames...')", async () => {
    await writeFile(join(inboundDir, ".env"), "SECRET=1");

    const results = await mirrorMedia([{ path: ".env" }, { path: "a\\b" }], {
      agentId,
      inboundDir,
      workspaceRoot,
    });

    expect(results[0].outcome).toBe("failure");
    expect(results[1].outcome).toBe("failure");

    // No files created in uploads
    await expect(readdir(join(workspaceRoot, agentId, "uploads")).catch(() => [])).resolves.toEqual(
      []
    );
  });

  it("rejects a symlink source escaping the inbound dir (was: 'rejects a symlink source...')", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "outside-"));
    const outsideFile = join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "top secret");

    const symlinkPath = join(inboundDir, "evil.jpg");
    await symlink(outsideFile, symlinkPath);

    const results = await mirrorMedia([{ path: "evil.jpg" }], {
      agentId,
      inboundDir,
      workspaceRoot,
    });

    expect(results[0].outcome).toBe("failure");
    await expect(readdir(join(workspaceRoot, agentId, "uploads")).catch(() => [])).resolves.toEqual(
      []
    );
  });

  it("rejects files over 25 MB without copying (was: 'rejects files over 25 MB...')", async () => {
    const source = join(inboundDir, "huge.bin");
    await writeFile(source, "");
    await truncate(source, MAX_MIRRORED_MEDIA_BYTES + 1);

    const results = await mirrorMedia([{ path: source }], { agentId, inboundDir, workspaceRoot });

    expect(results[0].outcome).toBe("failure");
    await expect(readdir(join(workspaceRoot, agentId, "uploads")).catch(() => [])).resolves.toEqual(
      []
    );
  });

  it("processes entries per-file best-effort: missing then present (was: 'processes files per-file best-effort...')", async () => {
    const presentSource = join(inboundDir, "present.jpg");
    await writeFile(presentSource, "present-content");

    const results = await mirrorMedia(
      [{ path: join(inboundDir, "missing.jpg") }, { path: presentSource }],
      { agentId, inboundDir, workspaceRoot }
    );

    expect(results.map((r) => r.outcome)).toEqual(["failure", "success"]);

    const target = join(workspaceRoot, agentId, "uploads", "present.jpg");
    const copied = await readFile(target, "utf-8");
    expect(copied).toBe("present-content");
  });

  it("reports failure (not a throw) for every entry when agentId contains path separators, without touching the filesystem (was: 'throws for an agentId containing path separators' — behavior changed: mirrorMedia never throws, it reports per-entry outcomes like every other failure mode)", async () => {
    const source = join(inboundDir, "photo.jpg");
    await writeFile(source, "content");

    const results = await mirrorMedia([{ path: source }, { path: join(inboundDir, "other.jpg") }], {
      agentId: "../escape",
      inboundDir,
      workspaceRoot,
    });

    expect(results).toEqual([
      { path: source, outcome: "failure", error: "invalid agentId" },
      { path: join(inboundDir, "other.jpg"), outcome: "failure", error: "invalid agentId" },
    ]);
    await expect(readdir(workspaceRoot)).resolves.toEqual([]);
  });

  it("creates the uploads directory automatically when it doesn't yet exist (was: 'creates the uploads directory automatically...')", async () => {
    const source = join(inboundDir, "photo.jpg");
    await writeFile(source, "content");
    // workspaceRoot exists but agent dir/uploads doesn't
    await mkdir(join(workspaceRoot, agentId), { recursive: true }).catch(() => {});

    const results = await mirrorMedia([{ path: source }], { agentId, inboundDir, workspaceRoot });

    expect(results[0].outcome).toBe("success");
  });

  it("chowns the copied file to uid/gid 999 via the injected chownImpl (new: ownership handoff back to the web process)", async () => {
    const source = join(inboundDir, "photo.jpg");
    await writeFile(source, "content");
    const chownCalls: Array<[string, number, number]> = [];
    const chownImpl = async (path: string, uid: number, gid: number) => {
      chownCalls.push([path, uid, gid]);
    };

    const results = await mirrorMedia([{ path: source }], {
      agentId,
      inboundDir,
      workspaceRoot,
      chownImpl,
    });

    expect(results[0].outcome).toBe("success");
    const target = join(workspaceRoot, agentId, "uploads", "photo.jpg");
    expect(chownCalls).toContainEqual([target, 999, 999]);
  });

  it("also chowns the uploads directory when this call creates it (new: dir ownership so the web process keeps being able to create upload slots)", async () => {
    const source = join(inboundDir, "photo.jpg");
    await writeFile(source, "content");
    const chownCalls: string[] = [];
    const chownImpl = async (path: string) => {
      chownCalls.push(path);
    };

    await mirrorMedia([{ path: source }], { agentId, inboundDir, workspaceRoot, chownImpl });

    const uploadsDir = join(workspaceRoot, agentId, "uploads");
    expect(chownCalls).toContain(uploadsDir);
  });

  it("tolerates a chown failure: the copy still succeeds (new: 'chown-failure tolerated')", async () => {
    const source = join(inboundDir, "photo.jpg");
    await writeFile(source, "content");
    const chownImpl = async () => {
      throw new Error("EPERM: operation not permitted");
    };

    const results = await mirrorMedia([{ path: source }], {
      agentId,
      inboundDir,
      workspaceRoot,
      chownImpl,
    });

    expect(results[0].outcome).toBe("success");
    const target = join(workspaceRoot, agentId, "uploads", "photo.jpg");
    await expect(readFile(target, "utf-8")).resolves.toBe("content");
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
      {
        content: "Hi from TG",
        messageId: "m1",
        sessionKey: SK,
        timestamp: 1700000000000,
      },
      { channelId: "telegram" }
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      direction: "inbound",
      sessionKey: SK,
      content: "Hi from TG",
    });
  });

  it("runs mirrorMedia and passes its reported result through on message_received (wiring test: the real inbound dir — /root/.openclaw/media/inbound — doesn't exist on this test host, so the reported outcome is a failure; mirrorMedia's own success-path behavior has dedicated real-tmp-dir tests below)", async () => {
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
      { channelId: "telegram" }
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // The plugin reports mirrorMedia's ACTUAL result rather than the raw
    // extracted media — the original path/mimeType survive, plus an outcome.
    expect(body.media).toEqual([
      {
        path: "/root/.openclaw/media/inbound/x.jpg",
        mimeType: "image/jpeg",
        outcome: "failure",
        error: expect.any(String),
      },
    ]);
  });

  it("does NOT mirror or capture media on a non-captured channel (would otherwise be an un-audited uploads write)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const api = fakeApi();
    plugin.register(api as never);

    // Media-only message on a channel Pinchy does NOT capture, but with an
    // otherwise-valid direct session key. shouldMirror gates the copy on the
    // same condition buildPayload uses to capture, so nothing is copied and
    // nothing is POSTed — no capture, no audit, no workspace write.
    await api.handlers["message_received"](
      {
        content: "",
        sessionKey: SK,
        timestamp: 1700000000000,
        metadata: {
          mediaPaths: ["/root/.openclaw/media/inbound/x.jpg"],
          mediaTypes: ["image/jpeg"],
        },
      },
      { channelId: "slack" }
    );

    expect(fetchMock).not.toHaveBeenCalled();
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
      { channelId: "telegram" }
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
      { channelId: "telegram" }
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
