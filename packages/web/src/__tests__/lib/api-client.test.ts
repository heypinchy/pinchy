import { describe, it, expect, vi, beforeEach } from "vitest";
import { apiPost, apiDelete, apiGet, ApiError, extractFieldErrors } from "@/lib/api-client";

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

  it("throws ApiError with friendly fallback message when body has no error field", async () => {
    // The fallback message is what the user actually sees in toasts. It must
    // read like a human sentence, not "Request failed: 500" (raw status).
    // The numeric status stays available on ApiError.status for logging.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 500, body: {} }))
    );
    await expect(apiPost("/api/groups", {})).rejects.toMatchObject({
      status: 500,
      message: "Something went wrong. Please try again.",
    });
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

  it("sends a JSON body with DELETE when one is provided", async () => {
    // A few DELETE routes validate a request body (e.g. the OpenAI-compatible
    // provider delete keys off `{ id }`). Verify the body is serialized and the
    // Content-Type header is set, mirroring apiPost.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse({ ok: true, status: 200, body: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await apiDelete("/api/settings/providers/openai-compatible", { id: "abc" });
    expect(res).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings/providers/openai-compatible",
      expect.objectContaining({
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "abc" }),
      })
    );
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

/**
 * The inline-vs-toast split from AGENTS.md § "Error And Notification UI" hangs
 * off this helper's null: a field the user can correct gets an inline message,
 * anything else gets a toast. It lived as an untested copy inside two settings
 * components until #1087 pulled it here, so its contract is pinned now.
 */
describe("extractFieldErrors", () => {
  it("flattens Zod's fieldErrors to the first message per field", () => {
    const err = new ApiError(400, "Validation failed", {
      fieldErrors: { name: ["Name is required", "Name is too short"], scopes: ["Pick one"] },
    });
    expect(extractFieldErrors(err)).toEqual({
      name: "Name is required",
      scopes: "Pick one",
    });
  });

  it("returns null for an error that is not an ApiError", () => {
    expect(extractFieldErrors(new Error("network down"))).toBeNull();
    expect(extractFieldErrors("nope")).toBeNull();
    expect(extractFieldErrors(undefined)).toBeNull();
  });

  it("returns null for an ApiError carrying no details", () => {
    expect(extractFieldErrors(new ApiError(500, "Server error"))).toBeNull();
  });

  it("returns null when details carry no fieldErrors", () => {
    expect(extractFieldErrors(new ApiError(400, "Bad", { formErrors: ["nope"] }))).toBeNull();
  });

  it("returns null when every field's message list is empty", () => {
    // Not `{}` — the caller branches on null to fall back to a toast, so an
    // empty map would render an inline error area with nothing in it.
    const err = new ApiError(400, "Validation failed", { fieldErrors: { name: [] } });
    expect(extractFieldErrors(err)).toBeNull();
  });

  it("skips a field whose messages are not an array but keeps the rest", () => {
    const err = new ApiError(400, "Validation failed", {
      fieldErrors: { name: "not-an-array", scopes: ["Pick one"] } as unknown as Record<
        string,
        string[]
      >,
    });
    expect(extractFieldErrors(err)).toEqual({ scopes: "Pick one" });
  });
});
