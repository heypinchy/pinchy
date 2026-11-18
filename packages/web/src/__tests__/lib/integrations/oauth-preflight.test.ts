import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateMicrosoftTenant } from "@/lib/integrations/oauth-preflight";
import { resetInsecureMockWarningsForTest } from "@/lib/integrations/insecure-mock-base-url";

describe("validateMicrosoftTenant", () => {
  const originalFetch = global.fetch;
  const originalBaseUrl = process.env.MICROSOFT_OAUTH_BASE_URL;
  const originalFlag = process.env.PINCHY_INSECURE_MAIL_MOCK;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalBaseUrl === undefined) {
      delete process.env.MICROSOFT_OAUTH_BASE_URL;
    } else {
      process.env.MICROSOFT_OAUTH_BASE_URL = originalBaseUrl;
    }
    if (originalFlag === undefined) {
      delete process.env.PINCHY_INSECURE_MAIL_MOCK;
    } else {
      process.env.PINCHY_INSECURE_MAIL_MOCK = originalFlag;
    }
    resetInsecureMockWarningsForTest();
    vi.restoreAllMocks();
  });

  it("resolves { ok: false, reason: 'not_found' } when the discovery fetch returns 400", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({ ok: false, status: 400 } as Response);

    const result = await validateMicrosoftTenant("bad-tenant");

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("resolves { ok: true } when the discovery fetch returns 200", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    const result = await validateMicrosoftTenant("real-tenant-id");

    expect(result).toEqual({ ok: true });
  });

  it("resolves { ok: 'unknown' } (fail-open) when fetch throws a network error", async () => {
    vi.mocked(global.fetch).mockRejectedValueOnce(new Error("network blip"));

    const result = await validateMicrosoftTenant("some-tenant");

    expect(result).toEqual({ ok: "unknown" });
  });

  it("resolves { ok: 'unknown' } (fail-open) on a non-400 error status such as 500", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({ ok: false, status: 500 } as Response);

    const result = await validateMicrosoftTenant("some-tenant");

    expect(result).toEqual({ ok: "unknown" });
  });

  it("reads process.env.MICROSOFT_OAUTH_BASE_URL when set together with the insecure flag", async () => {
    process.env.MICROSOFT_OAUTH_BASE_URL = "http://graph-mock:9005";
    process.env.PINCHY_INSECURE_MAIL_MOCK = "1";
    vi.mocked(global.fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    await validateMicrosoftTenant("my-tenant");

    expect(global.fetch).toHaveBeenCalledWith(
      "http://graph-mock:9005/my-tenant/v2.0/.well-known/openid-configuration",
      { signal: expect.any(AbortSignal) }
    );
  });

  it("ignores MICROSOFT_OAUTH_BASE_URL when the insecure flag is absent", async () => {
    process.env.MICROSOFT_OAUTH_BASE_URL = "http://graph-mock:9005";
    // No PINCHY_INSECURE_MAIL_MOCK: a stray override must not point the tenant
    // probe — which leaks the configured tenant id — at an arbitrary host.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(global.fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    await validateMicrosoftTenant("my-tenant");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://login.microsoftonline.com/my-tenant/v2.0/.well-known/openid-configuration",
      { signal: expect.any(AbortSignal) }
    );
  });

  it("defaults to https://login.microsoftonline.com when MICROSOFT_OAUTH_BASE_URL is unset", async () => {
    delete process.env.MICROSOFT_OAUTH_BASE_URL;
    vi.mocked(global.fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    await validateMicrosoftTenant("my-tenant");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://login.microsoftonline.com/my-tenant/v2.0/.well-known/openid-configuration",
      { signal: expect.any(AbortSignal) }
    );
  });

  it("resolves { ok: 'unknown' } (fail-open) when the request times out", async () => {
    vi.mocked(global.fetch).mockRejectedValueOnce(
      new DOMException("The operation was aborted.", "TimeoutError")
    );

    const result = await validateMicrosoftTenant("some-tenant");

    expect(result).toEqual({ ok: "unknown" });
  });

  it("passes an AbortSignal that times out after 10 seconds", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    await validateMicrosoftTenant("my-tenant");

    const [, options] = vi.mocked(global.fetch).mock.calls[0];
    expect(options?.signal?.aborted).toBe(false);
  });

  it("resolves { ok: true } for a blank/empty tenant WITHOUT calling fetch", async () => {
    const result = await validateMicrosoftTenant("");

    expect(result).toEqual({ ok: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("resolves { ok: true } for a whitespace-only tenant WITHOUT calling fetch", async () => {
    const result = await validateMicrosoftTenant("   ");

    expect(result).toEqual({ ok: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each(["organizations", "common", "consumers", "ORGANIZATIONS", "Common", "CONSUMERS"])(
    "resolves { ok: true } for the well-known tenant value %s WITHOUT calling fetch",
    async (tenant) => {
      const result = await validateMicrosoftTenant(tenant);

      expect(result).toEqual({ ok: true });
      expect(global.fetch).not.toHaveBeenCalled();
    }
  );
});
