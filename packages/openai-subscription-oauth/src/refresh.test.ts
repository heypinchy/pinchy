import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { refreshAccessToken } from "./refresh";

describe("refreshAccessToken", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("exchanges refresh_token for a new access/refresh pair", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "at_new", refresh_token: "rt_new", expires_in: 3600, token_type: "Bearer" }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const result = await refreshAccessToken({ refresh: "rt_old", clientId: "c1" });
    expect(result.access).toBe("at_new");
    expect(result.refresh).toBe("rt_new");
    expect(result.expires).toBeGreaterThan(Date.now());
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit & { body: string }];
    expect(url).toBe("https://auth.openai.com/oauth/token");
    expect(init.body).toContain("grant_type=refresh_token");
    expect(init.body).toContain("refresh_token=rt_old");
    expect(init.body).toContain("client_id=c1");
  });

  it("keeps old refresh when server omits a new one (OpenAI sometimes does this)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ access_token: "at_new", expires_in: 60 }), { status: 200 })
    );
    const result = await refreshAccessToken({ refresh: "rt_old", clientId: "c1" });
    expect(result.refresh).toBe("rt_old");
  });

  it("throws on non-2xx", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    );
    await expect(refreshAccessToken({ refresh: "rt_bad", clientId: "c1" })).rejects.toThrow(/invalid_grant/);
  });
});
