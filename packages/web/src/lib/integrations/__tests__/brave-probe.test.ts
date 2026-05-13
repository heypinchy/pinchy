import { describe, it, expect, vi, beforeEach } from "vitest";
import { probeBraveApiKey } from "../brave-probe";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("probeBraveApiKey", () => {
  it("returns success when Brave responds 2xx", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    const res = await probeBraveApiKey("valid-key");
    expect(res).toEqual({ success: true });
  });

  it("returns a user-friendly 'key rejected' reason for HTTP 401", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 });
    const res = await probeBraveApiKey("bad-key");
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.reason).toMatch(/api key.*rejected|reject.*api key|invalid.*api key/i);
    expect(res.reason).not.toMatch(/HTTP 401/);
  });

  it("returns a user-friendly 'key rejected' reason for HTTP 403", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 });
    const res = await probeBraveApiKey("bad-key");
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.reason).toMatch(/api key.*rejected|reject.*api key|invalid.*api key/i);
  });

  it("returns a user-friendly 'key rejected' reason for HTTP 422 (Brave's typical bad-key code)", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 422 });
    const res = await probeBraveApiKey("bad-key");
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.reason).toMatch(/api key.*rejected|reject.*api key|invalid.*api key/i);
    // Crucially: must NOT just say "HTTP 422" — that's what the user complained about.
    expect(res.reason).not.toMatch(/HTTP 422/i);
  });

  it("returns a 'rate limited' message for HTTP 429", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429 });
    const res = await probeBraveApiKey("ok-key");
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.reason).toMatch(/rate limit/i);
  });

  it("returns an 'unreachable' message for 5xx (transient outage)", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    const res = await probeBraveApiKey("ok-key");
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.reason).toMatch(/unreachable|temporarily|try again/i);
  });

  it("returns a 'network error' message when fetch rejects", async () => {
    mockFetch.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    const res = await probeBraveApiKey("ok-key");
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.reason).toMatch(/could not reach|network/i);
  });
});
