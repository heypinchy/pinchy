import { describe, it, expect, vi, beforeEach } from "vitest";

const apiGet = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPost: vi.fn(),
}));

import { fetchPendingApprovals } from "./client";
import { MAX_KNOWN_APPROVALS } from "@/lib/schemas/approvals";

const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

describe("fetchPendingApprovals", () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiGet.mockResolvedValue({ approvals: [] });
  });

  it("asks without `known` when it holds nothing", async () => {
    await fetchPendingApprovals();
    expect(apiGet).toHaveBeenCalledWith("/api/approvals");
  });

  it("names the cards it holds", async () => {
    await fetchPendingApprovals([id(1), id(2)]);
    expect(apiGet).toHaveBeenCalledWith(`/api/approvals?known=${id(1)},${id(2)}`);
  });

  // The ids ride in the query string. Unbounded, a person with hundreds of
  // pending cards would build a request line past what a proxy or Node's
  // header limit accepts, and the poll — the only way a card reaches the
  // screen — would fail outright. Past the bound the route ignores ids anyway.
  it("sends no more ids than the route reads", async () => {
    const held = Array.from({ length: MAX_KNOWN_APPROVALS + 50 }, (_, i) => id(i));
    await fetchPendingApprovals(held);
    const url = apiGet.mock.calls[0][0] as string;
    const sent = url.slice("/api/approvals?known=".length).split(",");
    expect(sent).toEqual(held.slice(0, MAX_KNOWN_APPROVALS));
    // ~37 characters an id: the request line stays well inside 8 KB.
    expect(url.length).toBeLessThan(8 * 1024);
  });
});
