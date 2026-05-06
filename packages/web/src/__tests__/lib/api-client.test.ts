import { describe, it, expect, vi, beforeEach } from "vitest";
import { apiPost, apiDelete, apiGet, ApiError } from "@/lib/api-client";

/**
 * Helper to build a Response-shaped mock that matches what `send()` reads.
 * The implementation reads `res.text()` once, then JSON-parses if non-empty.
 */
function mockResponse(opts: { ok: boolean; status: number; body?: unknown | "" }): Response {
  const text = opts.body === undefined ? "" : opts.body === "" ? "" : JSON.stringify(opts.body);
  return {
    ok: opts.ok,
    status: opts.status,
    text: async () => text,
  } as unknown as Response;
}

describe("apiPost", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed body on 2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          mockResponse({ ok: true, status: 201, body: { id: "g1", name: "Test" } })
        )
    );
    const res = await apiPost("/api/groups", { name: "Test" });
    expect(res).toEqual({ id: "g1", name: "Test" });
  });

  it("throws ApiError with server message on 4xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          mockResponse({ ok: false, status: 400, body: { error: "Validation failed" } })
        )
    );
    await expect(apiPost("/api/groups", { name: "" })).rejects.toThrow("Validation failed");
  });

  it("throws ApiError with status fallback when body has no error field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 500, body: {} }))
    );
    await expect(apiPost("/api/groups", {})).rejects.toMatchObject({ status: 500 });
  });

  it("returns undefined for 204 No Content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse({ ok: true, status: 204, body: "" }))
    );
    const res = await apiDelete("/api/groups/g1");
    expect(res).toBeUndefined();
  });

  it("returns undefined when 2xx response has empty body", async () => {
    // Some routes return 200 OK with no body. The previous implementation always
    // called res.json(), which throws SyntaxError on an empty buffer. Verify the
    // helper degrades gracefully.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse({ ok: true, status: 200, body: "" }))
    );
    const res = await apiDelete("/api/groups/g1");
    expect(res).toBeUndefined();
  });

  it("throws an ApiError instance on non-2xx (instanceof check)", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(mockResponse({ ok: false, status: 403, body: { error: "Forbidden" } }))
    );
    try {
      await apiGet("/api/groups");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(403);
      expect((e as ApiError).message).toBe("Forbidden");
    }
  });
});
