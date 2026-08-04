import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  apiPost,
  apiDelete,
  apiGet,
  ApiError,
  errorMessage,
  extractFieldErrors,
} from "@/lib/api-client";

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

  // Several routes answer with BOTH a headline and the actionable sentence:
  // `{ error: "Seat limit reached", message: "Your license includes 5 seats…" }`
  // (users/invite, groups/[groupId]/members, users/[userId]/groups). Reading
  // only `error` threw away the half that tells the user what to do about it.
  it("joins the server's error headline and its actionable message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 403,
          body: {
            error: "Seat limit reached",
            message: "Remove an existing user or email sales@heypinchy.com.",
          },
        })
      )
    );
    await expect(apiPost("/api/users/invite", {})).rejects.toMatchObject({
      status: 403,
      message: "Seat limit reached — Remove an existing user or email sales@heypinchy.com.",
    });
  });

  it("uses `message` alone when the body carries no `error` headline", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          mockResponse({ ok: false, status: 400, body: { message: "Mailbox is unreachable" } })
        )
    );
    await expect(apiPost("/api/x", {})).rejects.toThrow("Mailbox is unreachable");
  });

  it("does not repeat itself when `error` and `message` say the same thing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 400,
          body: { error: "Invite not found", message: "Invite not found" },
        })
      )
    );
    await expect(apiPost("/api/x", {})).rejects.toThrow(/^Invite not found$/);
  });

  // A non-string `error` must never reach `new Error(...)`, or the user is
  // shown "[object Object]".
  it("falls back rather than stringifying a non-string error field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 500,
          body: { error: { message: "nested" } },
        })
      )
    );
    await expect(apiPost("/api/x", {})).rejects.toThrow("Something went wrong. Please try again.");
  });

  it("ignores a non-string message field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 400,
          body: { error: "Validation failed", message: { nested: true } },
        })
      )
    );
    await expect(apiPost("/api/x", {})).rejects.toThrow(/^Validation failed$/);
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

  it("exposes the whole parsed error payload on ApiError.body", async () => {
    // The escape hatch for routes that answer a field beyond
    // `{ error, message, details }` — /api/setup/provider sends a `docs` link
    // with its 400, and provider-key-form reads it back off `body`.
    const payload = {
      error: "Invalid API key",
      docs: { href: "https://docs.heypinchy.com/x", label: "Read the guide" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 400, body: payload }))
    );
    try {
      await apiPost("/api/setup/provider", {});
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as ApiError).body).toEqual(payload);
    }
  });
});

/**
 * `errorMessage` is what every catch block in the app calls, so its contract is
 * worth pinning directly rather than only through the components that use it.
 *
 * The rule it encodes: show the SERVER's wording when there was one, and the
 * caller's context-specific fallback otherwise. The interesting case is the
 * third one — an ApiError whose message is api-client's own generic sentence
 * carries no server wording at all, so the fallback ("Failed to save timezone")
 * is strictly more useful than passing the generic through.
 */
describe("errorMessage", () => {
  it("prefers the server's own wording over the caller's fallback", () => {
    const e = new ApiError(404, "Invite not found");
    expect(errorMessage(e, "Failed to revoke invite. Please try again.")).toBe("Invite not found");
  });

  it("falls back when the route sent no wording at all", () => {
    // What `send()` builds for a bare 500 or a proxy's HTML error page.
    const e = new ApiError(500, "Something went wrong. Please try again.");
    expect(errorMessage(e, "Failed to save timezone")).toBe("Failed to save timezone");
  });

  it("falls back for a network failure rather than leaking its internal text", () => {
    // A fetch rejection is a TypeError whose message is "Failed to fetch" —
    // never user-facing copy. Showing it on the setup screen is the regression
    // this helper exists to prevent.
    expect(errorMessage(new TypeError("Failed to fetch"), "Setup failed")).toBe("Setup failed");
  });

  it("falls back for a non-Error value", () => {
    expect(errorMessage("boom", "Failed to create agent")).toBe("Failed to create agent");
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
