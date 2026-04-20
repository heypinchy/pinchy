import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pollForToken } from "./poll";

describe("pollForToken", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn();
    vi.useFakeTimers();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("resolves with tokens on success and parses account info from id_token", async () => {
    const payload = { sub: "abc", email: "user@example.com", "https://openai.com/auth": { user_id: "acc-1" } };
    const idToken = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.`;

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "at_1",
          refresh_token: "rt_1",
          id_token: idToken,
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const p = pollForToken({ deviceCode: "d1", clientId: "c1", intervalSeconds: 0 });
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.access).toBe("at_1");
    expect(result.refresh).toBe("rt_1");
    expect(result.expires).toBeGreaterThan(Date.now());
    expect(result.accountId).toBe("acc-1");
    expect(result.accountEmail).toBe("user@example.com");

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit & { body: string }];
    expect(url).toBe("https://auth.openai.com/api/accounts/deviceauth/token");
    expect(init.body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
    expect(init.body).toContain("device_code=d1");
    expect(init.body).toContain("client_id=c1");
  });

  it("keeps polling while server returns authorization_pending", async () => {
    const mock = globalThis.fetch as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 })
    );
    mock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 })
    );
    const payload = { sub: "abc", email: "u@e.com", "https://openai.com/auth": { user_id: "a" } };
    const idToken = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.`;
    mock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: "at", refresh_token: "rt", id_token: idToken, expires_in: 60, token_type: "Bearer" }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const p = pollForToken({ deviceCode: "d1", clientId: "c1", intervalSeconds: 0 });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(mock).toHaveBeenCalledTimes(3);
    expect(result.access).toBe("at");
  });

  it("throws on access_denied", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "access_denied" }), { status: 400 })
    );
    const p = pollForToken({ deviceCode: "d1", clientId: "c1", intervalSeconds: 0 });
    const assertion = expect(p).rejects.toThrow(/access_denied/);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("throws on expired_token", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "expired_token" }), { status: 400 })
    );
    const p = pollForToken({ deviceCode: "d1", clientId: "c1", intervalSeconds: 0 });
    const assertion = expect(p).rejects.toThrow(/expired_token/);
    await vi.runAllTimersAsync();
    await assertion;
  });
});
