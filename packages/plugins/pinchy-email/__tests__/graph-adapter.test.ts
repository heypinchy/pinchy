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
