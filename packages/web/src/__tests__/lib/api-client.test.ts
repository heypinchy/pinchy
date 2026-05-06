import { describe, it, expect, vi, beforeEach } from "vitest";
import { apiPost, apiDelete, apiGet, ApiError } from "@/lib/api-client";

describe("apiPost", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed body on 2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ id: "g1", name: "Test" }),
      })
    );
    const res = await apiPost("/api/groups", { name: "Test" });
    expect(res).toEqual({ id: "g1", name: "Test" });
  });

  it("throws ApiError with server message on 4xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "Validation failed" }),
      })
    );
    await expect(apiPost("/api/groups", { name: "" })).rejects.toThrow("Validation failed");
  });

  it("throws ApiError with status fallback when body has no error field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      })
    );
    await expect(apiPost("/api/groups", {})).rejects.toMatchObject({ status: 500 });
  });

  it("returns undefined for 204 No Content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        json: async () => {
          throw new Error("no body");
        },
      })
    );
    const res = await apiDelete("/api/groups/g1");
    expect(res).toBeUndefined();
  });

  it("throws an ApiError instance on non-2xx (instanceof check)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: "Forbidden" }),
      })
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
