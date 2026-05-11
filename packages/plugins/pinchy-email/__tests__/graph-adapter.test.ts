import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { GraphAdapter } from "../graph-adapter.js";

describe("GraphAdapter.list", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GRAPH_API_BASE_URL;
  });

  it("list({folder:'INBOX'}) hits /v1.0/me/mailFolders/inbox/messages", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ value: [] }),
    });
    await adapter.list({ folder: "INBOX", limit: 5 });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1.0/me/mailFolders/inbox/messages"),
      expect.any(Object),
    );
  });

  it("list({}) hits /v1.0/me/messages with no folder filter", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ value: [] }) });
    await adapter.list({});
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1.0/me/messages"),
      expect.any(Object),
    );
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("mailFolders"),
      expect.any(Object),
    );
  });

  it("list({unreadOnly:true}) appends $filter=isRead eq false", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ value: [] }) });
    await adapter.list({ unreadOnly: true });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("$filter=isRead%20eq%20false"),
      expect.any(Object),
    );
  });

  it("unknown folder throws", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    await expect(adapter.list({ folder: "CUSTOM" as never })).rejects.toThrow(/unknown folder/i);
  });

  it("uses GRAPH_API_BASE_URL when set", async () => {
    process.env.GRAPH_API_BASE_URL = "http://graph-mock:9005";
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ value: [] }) });
    await adapter.list({});
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("http://graph-mock:9005/v1.0/me/messages"),
      expect.any(Object),
    );
    delete process.env.GRAPH_API_BASE_URL;
  });
});

describe("GraphAdapter.read", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("read(id) hits /v1.0/me/messages/<id>", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "msg1",
        subject: "Hello",
        bodyPreview: "Hi there",
        receivedDateTime: "2024-01-01T10:00:00Z",
        from: { emailAddress: { address: "alice@example.com" } },
        toRecipients: [{ emailAddress: { address: "bob@example.com" } }],
        ccRecipients: [{ emailAddress: { address: "charlie@example.com" } }],
        isRead: false,
        body: { contentType: "text", content: "Hi there, full body" },
      }),
    });
    const result = await adapter.read("msg1");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1.0/me/messages/msg1"),
      expect.any(Object),
    );
    expect(result.body).toBe("Hi there, full body");
    expect(result.cc).toBe("charlie@example.com");
    expect(result.unread).toBe(true);
  });

  it("non-ok response throws a descriptive error", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "Message not found",
    });
    await expect(adapter.read("msg1")).rejects.toThrow(/Graph 404/);
  });

  it("URL-encodes the message ID in the path", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "msg/special+id",
        subject: "S",
        bodyPreview: "",
        receivedDateTime: "2024-01-01T10:00:00Z",
        from: { emailAddress: { address: "a@b.com" } },
        toRecipients: [],
        isRead: true,
        body: { contentType: "text", content: "" },
      }),
    });
    await adapter.read("msg/special+id");
    const url = (fetch as Mock).mock.calls[0][0] as string;
    expect(url).toContain(encodeURIComponent("msg/special+id"));
    expect(url).not.toContain("/msg/special+id");
  });
});

describe("GraphAdapter.search", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('search({from,subject}) issues $search with from: and subject:', async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ value: [] }) });
    await adapter.search({ from: "alice@example.com", subject: "invoice" });
    const url = (fetch as Mock).mock.calls[0][0] as string;
    expect(url).toContain("%24search=");
    expect(decodeURIComponent(url)).toContain("from:alice@example.com");
    expect(decodeURIComponent(url)).toContain("subject:invoice");
  });

  it("search({unread:true,sinceDays:7}) uses $filter for date and isRead", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ value: [] }) });
    await adapter.search({ unread: true, sinceDays: 7 });
    const url = (fetch as Mock).mock.calls[0][0] as string;
    expect(decodeURIComponent(url)).toContain("isRead eq false");
    expect(decodeURIComponent(url)).toContain("receivedDateTime ge");
  });

  it("search({}) throws 'at least one filter'", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    await expect(adapter.search({})).rejects.toThrow(/at least one/i);
  });

  it("folder scopes via mailFolders path", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ value: [] }) });
    await adapter.search({ from: "alice@example.com", folder: "SENT" });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/me/mailFolders/sentitems/messages"),
      expect.any(Object),
    );
  });
});

describe("GraphAdapter.draft", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("draft({to,subject,body}) POSTs to /me/messages and returns draftId", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ id: "draft1" }) });
    const result = await adapter.draft({ to: "bob@example.com", subject: "Test", body: "Hello" });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/me/messages"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.draftId).toBe("draft1");
  });

  it("draft({...,replyTo}) uses createReply endpoint", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "reply1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const result = await adapter.draft({ to: "bob@example.com", subject: "Re: Test", body: "Thanks", replyTo: "original-msg-id" });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/me/messages/original-msg-id/createReply"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.draftId).toBe("reply1");
  });

  it("new draft body contains subject, body.contentType, body.content, and toRecipients", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ id: "draft1" }) });
    await adapter.draft({ to: "bob@example.com", subject: "Test Subject", body: "Hello body" });
    const call = (fetch as Mock).mock.calls[0];
    const sentBody = JSON.parse((call[1] as RequestInit).body as string);
    expect(sentBody.subject).toBe("Test Subject");
    expect(sentBody.body.contentType).toBe("text");
    expect(sentBody.body.content).toBe("Hello body");
    expect(sentBody.toRecipients).toEqual([{ emailAddress: { address: "bob@example.com" } }]);
  });
});

describe("GraphAdapter.send", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("send({to,subject,body}) POSTs to /me/sendMail", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({ ok: true, headers: { get: () => null }, json: async () => ({}) });
    await adapter.send({ to: "bob@example.com", subject: "Test", body: "Hello" });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/me/sendMail"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("send({...,replyTo}) creates draft + sends it", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "reply1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, headers: { get: () => null }, json: async () => ({}) });
    await adapter.send({ to: "bob@example.com", subject: "Re: Test", body: "Thanks", replyTo: "original-id" });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/me/messages/reply1/send"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("send({...,replyTo}) returns draftId as messageId", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "reply42" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, headers: { get: () => null }, json: async () => ({}) });
    const result = await adapter.send({ to: "bob@example.com", subject: "Re: Test", body: "Thanks", replyTo: "original-id" });
    expect(result.messageId).toBe("reply42");
  });
});
