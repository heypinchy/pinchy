import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveInsecureMockBaseUrl,
  resetInsecureMockWarningsForTest,
} from "@/lib/integrations/insecure-mock-base-url";

describe("resolveInsecureMockBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetInsecureMockWarningsForTest();
    vi.restoreAllMocks();
  });

  it("returns undefined when the override var is not set", () => {
    expect(resolveInsecureMockBaseUrl("GRAPH_API_BASE_URL")).toBe(undefined);
  });

  it("ignores the override and returns undefined when the insecure flag is absent", () => {
    vi.stubEnv("GRAPH_API_BASE_URL", "http://graph-mock:9005");
    // No PINCHY_INSECURE_MAIL_MOCK: a stray override left over in production
    // must not silently redirect the OAuth client secret, refresh token or
    // access token this host would receive.
    expect(resolveInsecureMockBaseUrl("GRAPH_API_BASE_URL")).toBe(undefined);
  });

  it("returns the override when the insecure flag is also set", () => {
    vi.stubEnv("GRAPH_API_BASE_URL", "http://graph-mock:9005");
    vi.stubEnv("PINCHY_INSECURE_MAIL_MOCK", "1");
    expect(resolveInsecureMockBaseUrl("GRAPH_API_BASE_URL")).toBe("http://graph-mock:9005");
  });

  it('ignores the override when the flag is set to something other than exactly "1"', () => {
    vi.stubEnv("GRAPH_API_BASE_URL", "http://graph-mock:9005");
    vi.stubEnv("PINCHY_INSECURE_MAIL_MOCK", "true");
    expect(resolveInsecureMockBaseUrl("GRAPH_API_BASE_URL")).toBe(undefined);
  });

  it("treats an empty override as unset, and does not warn about it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("GRAPH_API_BASE_URL", "");
    expect(resolveInsecureMockBaseUrl("GRAPH_API_BASE_URL")).toBe(undefined);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns only once for a repeated read of the same override var", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("GRAPH_API_BASE_URL", "http://graph-mock:9005");

    resolveInsecureMockBaseUrl("GRAPH_API_BASE_URL");
    resolveInsecureMockBaseUrl("GRAPH_API_BASE_URL");
    resolveInsecureMockBaseUrl("GRAPH_API_BASE_URL");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("GRAPH_API_BASE_URL");
    expect(warn.mock.calls[0][0]).toContain("PINCHY_INSECURE_MAIL_MOCK");
  });

  it("warns separately for each distinct override var", () => {
    // The dedupe is keyed by override var, not global: two leftover overrides
    // must both be reported, or the second one is invisible.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("GRAPH_API_BASE_URL", "http://graph-mock:9005");
    vi.stubEnv("GMAIL_API_BASE_URL", "http://gmail-mock:9004");

    resolveInsecureMockBaseUrl("GRAPH_API_BASE_URL");
    resolveInsecureMockBaseUrl("GMAIL_API_BASE_URL");
    resolveInsecureMockBaseUrl("GRAPH_API_BASE_URL");
    resolveInsecureMockBaseUrl("GMAIL_API_BASE_URL");

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map((c) => c[0]).join("\n")).toContain("GRAPH_API_BASE_URL");
    expect(warn.mock.calls.map((c) => c[0]).join("\n")).toContain("GMAIL_API_BASE_URL");
  });

  it("does not warn when the override is not set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveInsecureMockBaseUrl("GRAPH_API_BASE_URL");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn when the override is set together with the flag", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("GRAPH_API_BASE_URL", "http://graph-mock:9005");
    vi.stubEnv("PINCHY_INSECURE_MAIL_MOCK", "1");
    resolveInsecureMockBaseUrl("GRAPH_API_BASE_URL");
    expect(warn).not.toHaveBeenCalled();
  });
});
