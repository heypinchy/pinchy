import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PinnedTarget } from "@/lib/pinned-connection";

// The pin is what stands between "the guard checked address A" and "odoo-node
// connected to whatever the name resolves to now". These tests drive it with a
// stand-in for the pinned connector and assert where each request goes.

type FakeAgent = { target: PinnedTarget; close: ReturnType<typeof vi.fn> };
const agents: FakeAgent[] = [];
const pinnedRequests: Array<{ url: string; init: RequestInit; agent: FakeAgent }> = [];

vi.mock("@/lib/pinned-connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pinned-connection")>();
  return {
    ...actual,
    createPinnedAgent: (target: PinnedTarget) => {
      const agent: FakeAgent = { target, close: vi.fn().mockResolvedValue(undefined) };
      agents.push(agent);
      return agent;
    },
    fetchWithPinnedAgent: async (url: string, init: RequestInit, agent: FakeAgent) => {
      pinnedRequests.push({ url, init, agent });
      // Yield so concurrent scopes genuinely interleave.
      await new Promise((resolve) => setTimeout(resolve, 1));
      return new Response("ok");
    },
  };
});

import { isPinnedTo, withPinnedOdooFetch } from "@/lib/integrations/odoo-pin";

const A: PinnedTarget = [{ address: "93.184.216.34", family: 4 }];
const B: PinnedTarget = [{ address: "93.184.216.35", family: 4 }];

const plainFetch = vi.fn();

beforeEach(() => {
  agents.length = 0;
  pinnedRequests.length = 0;
  plainFetch.mockReset();
  plainFetch.mockResolvedValue(new Response("plain"));
  vi.stubGlobal("fetch", plainFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("withPinnedOdooFetch", () => {
  it("sends a request to the checked origin to the checked address", async () => {
    await withPinnedOdooFetch("https://odoo.example.com", A, () =>
      fetch("https://odoo.example.com/jsonrpc", { method: "POST" })
    );

    expect(plainFetch).not.toHaveBeenCalled();
    expect(pinnedRequests).toHaveLength(1);
    expect(pinnedRequests[0].agent.target).toEqual(A);
  });

  it("uses one connector for every request in the scope and closes it when the scope ends", async () => {
    await withPinnedOdooFetch("https://odoo.example.com", A, async () => {
      await fetch("https://odoo.example.com/jsonrpc");
      await fetch("https://odoo.example.com/jsonrpc");
      await fetch("https://odoo.example.com/jsonrpc");
      expect(agents[0].close).not.toHaveBeenCalled();
    });

    expect(agents).toHaveLength(1);
    expect(pinnedRequests).toHaveLength(3);
    expect(agents[0].close).toHaveBeenCalledTimes(1);
  });

  it("closes the connector when the callback throws", async () => {
    await expect(
      withPinnedOdooFetch("https://odoo.example.com", A, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(agents[0].close).toHaveBeenCalledTimes(1);
  });

  it("refuses a request to another origin instead of sending it unpinned", async () => {
    await expect(
      withPinnedOdooFetch("https://odoo.example.com", A, () =>
        fetch("https://other.example.com/jsonrpc")
      )
    ).rejects.toThrow(/other\.example\.com/);

    expect(plainFetch).not.toHaveBeenCalled();
    expect(pinnedRequests).toHaveLength(0);
  });

  it("reads the URL and the method off a Request", async () => {
    await withPinnedOdooFetch("https://odoo.example.com", A, () =>
      fetch(new Request("https://odoo.example.com/jsonrpc", { method: "POST", body: '{"a":1}' }))
    );

    expect(pinnedRequests[0].url).toBe("https://odoo.example.com/jsonrpc");
    expect(pinnedRequests[0].init.method).toBe("POST");
    expect(Buffer.from(pinnedRequests[0].init.body as ArrayBuffer).toString()).toBe('{"a":1}');
  });

  it("keeps concurrent scopes apart", async () => {
    await Promise.all([
      withPinnedOdooFetch("https://one.example.com", A, async () => {
        await fetch("https://one.example.com/x");
        await fetch("https://one.example.com/y");
      }),
      withPinnedOdooFetch("https://two.example.com", B, async () => {
        await fetch("https://two.example.com/x");
        await fetch("https://two.example.com/y");
      }),
    ]);

    for (const request of pinnedRequests) {
      const expected = request.url.startsWith("https://one.") ? A : B;
      expect(request.agent.target).toEqual(expected);
    }
    expect(pinnedRequests).toHaveLength(4);
    expect(plainFetch).not.toHaveBeenCalled();
  });

  it("leaves nothing behind once the scope has ended", async () => {
    await withPinnedOdooFetch("https://odoo.example.com", A, () =>
      fetch("https://odoo.example.com/jsonrpc")
    );

    await fetch("https://odoo.example.com/jsonrpc");

    expect(plainFetch).toHaveBeenCalledTimes(1);
    expect(pinnedRequests).toHaveLength(1);
  });

  it("wraps the global fetch once, however many scopes run", async () => {
    await withPinnedOdooFetch("https://odoo.example.com", A, async () => undefined);
    const wrapper = globalThis.fetch;
    await withPinnedOdooFetch("https://odoo.example.com", A, async () => undefined);
    await withPinnedOdooFetch("https://odoo.example.com", B, async () => undefined);

    expect(globalThis.fetch).toBe(wrapper);

    // One layer: a request outside any scope reaches the underlying fetch once.
    await fetch("https://elsewhere.example.com");
    expect(plainFetch).toHaveBeenCalledTimes(1);
  });

  it("wraps a replaced global fetch again", async () => {
    await withPinnedOdooFetch("https://odoo.example.com", A, async () => undefined);
    const replacement = vi.fn().mockResolvedValue(new Response("replacement"));
    vi.stubGlobal("fetch", replacement);

    await withPinnedOdooFetch("https://odoo.example.com", A, () =>
      fetch("https://odoo.example.com/jsonrpc")
    );
    await fetch("https://elsewhere.example.com");

    expect(pinnedRequests).toHaveLength(1);
    expect(replacement).toHaveBeenCalledTimes(1);
  });
});

describe("isPinnedTo", () => {
  it("is true only inside a scope for that origin", async () => {
    expect(isPinnedTo("https://odoo.example.com")).toBe(false);
    await withPinnedOdooFetch("https://odoo.example.com", A, async () => {
      expect(isPinnedTo("https://odoo.example.com")).toBe(true);
      expect(isPinnedTo("https://other.example.com")).toBe(false);
    });
    expect(isPinnedTo("https://odoo.example.com")).toBe(false);
  });
});
