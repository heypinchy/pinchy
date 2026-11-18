import { describe, it, expect, vi, afterEach } from "vitest";
import { googleTokenEndpoint, refreshAccessToken } from "@/lib/integrations/google-oauth";
import { resetInsecureMockWarningsForTest } from "@/lib/integrations/insecure-mock-base-url";

/**
 * GMAIL_OAUTH_BASE_URL used to be read once at module load into a
 * `const TOKEN_ENDPOINT`, with no paired opt-in flag. That request POSTs the
 * OAuth client secret AND the refresh token, so a stray override left over in
 * production would have handed Pinchy's longest-lived Google credentials to
 * whatever host it named — and a module-level const also made the seam
 * untestable without a module reset.
 */
describe("googleTokenEndpoint", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetInsecureMockWarningsForTest();
    vi.restoreAllMocks();
  });

  it("uses the real Google token endpoint when no override is set", () => {
    expect(googleTokenEndpoint()).toBe("https://oauth2.googleapis.com/token");
  });

  it("ignores GMAIL_OAUTH_BASE_URL when the insecure flag is absent", () => {
    vi.stubEnv("GMAIL_OAUTH_BASE_URL", "http://gmail-mock:9004");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(googleTokenEndpoint()).toBe("https://oauth2.googleapis.com/token");
  });

  it("uses GMAIL_OAUTH_BASE_URL when the insecure flag is also set", () => {
    vi.stubEnv("GMAIL_OAUTH_BASE_URL", "http://gmail-mock:9004");
    vi.stubEnv("PINCHY_INSECURE_MAIL_MOCK", "1");
    expect(googleTokenEndpoint()).toBe("http://gmail-mock:9004/token");
  });

  it("is read per call, not frozen at module load", () => {
    expect(googleTokenEndpoint()).toBe("https://oauth2.googleapis.com/token");
    vi.stubEnv("GMAIL_OAUTH_BASE_URL", "http://gmail-mock:9004");
    vi.stubEnv("PINCHY_INSECURE_MAIL_MOCK", "1");
    expect(googleTokenEndpoint()).toBe("http://gmail-mock:9004/token");
  });
});

describe("refreshAccessToken", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetInsecureMockWarningsForTest();
    vi.restoreAllMocks();
  });

  it("POSTs to the real Google host even when GMAIL_OAUTH_BASE_URL is set without the flag", async () => {
    vi.stubEnv("GMAIL_OAUTH_BASE_URL", "http://gmail-mock:9004");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "a", expires_in: 3600 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await refreshAccessToken({ refreshToken: "r", clientId: "c", clientSecret: "s" });

    expect(fetchMock.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/token");
  });

  it("POSTs to the override when the flag is set", async () => {
    vi.stubEnv("GMAIL_OAUTH_BASE_URL", "http://gmail-mock:9004");
    vi.stubEnv("PINCHY_INSECURE_MAIL_MOCK", "1");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "a", expires_in: 3600 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await refreshAccessToken({ refreshToken: "r", clientId: "c", clientSecret: "s" });

    expect(fetchMock.mock.calls[0][0]).toBe("http://gmail-mock:9004/token");
  });
});
