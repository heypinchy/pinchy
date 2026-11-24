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

import { withPinnedOdoo } from "@/lib/integrations/odoo-pin";

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

describe("withPinnedOdoo", () => {
  it("sends a request to the checked origin to the checked address", async () => {
    await withPinnedOdoo("https://odoo.example.com", A, (pinned) =>
      pinned("https://odoo.example.com/jsonrpc", { method: "POST", body: '{"a":1}' })
    );

    expect(plainFetch).not.toHaveBeenCalled();
    expect(pinnedRequests).toHaveLength(1);
    expect(pinnedRequests[0].url).toBe("https://odoo.example.com/jsonrpc");
    expect(pinnedRequests[0].init).toMatchObject({ method: "POST", body: '{"a":1}' });
    expect(pinnedRequests[0].agent.target).toEqual(A);
  });

  it("takes the URL as a URL object too", async () => {
    await withPinnedOdoo("https://odoo.example.com", A, (pinned) =>
      pinned(new URL("https://odoo.example.com/jsonrpc"))
    );

    expect(pinnedRequests[0].url).toBe("https://odoo.example.com/jsonrpc");
  });

  it("uses one connector for every request in the scope and closes it when the scope ends", async () => {
    await withPinnedOdoo("https://odoo.example.com", A, async (pinned) => {
      await pinned("https://odoo.example.com/jsonrpc");
      await pinned("https://odoo.example.com/jsonrpc");
      await pinned("https://odoo.example.com/jsonrpc");
      expect(agents[0].close).not.toHaveBeenCalled();
    });

    expect(agents).toHaveLength(1);
    expect(pinnedRequests).toHaveLength(3);
    expect(agents[0].close).toHaveBeenCalledTimes(1);
  });

  it("closes the connector when the callback throws", async () => {
    await expect(
      withPinnedOdoo("https://odoo.example.com", A, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(agents[0].close).toHaveBeenCalledTimes(1);
  });

  it("refuses a request to another origin instead of sending it unpinned", async () => {
    await expect(
      withPinnedOdoo("https://odoo.example.com", A, (pinned) =>
        pinned("https://other.example.com/jsonrpc")
      )
    ).rejects.toThrow(
      "Refused a request to https://other.example.com inside a scope pinned to " +
        "https://odoo.example.com: it would be sent by host name, unchecked."
    );

    expect(plainFetch).not.toHaveBeenCalled();
    expect(pinnedRequests).toHaveLength(0);
  });

  it("refuses a Request rather than dropping what it carries", async () => {
    // odoo-node calls its fetch with a URL string. A Request's method, headers
    // and body would have to be copied over one by one; anything missed would
    // go out wrong, so a Request does not go out at all.
    await expect(
      withPinnedOdoo("https://odoo.example.com", A, (pinned) =>
        pinned(new Request("https://odoo.example.com/jsonrpc", { method: "POST" }))
      )
    ).rejects.toThrow(/URL, not a Request/);

    expect(pinnedRequests).toHaveLength(0);
  });

  it("keeps concurrent scopes apart", async () => {
    await Promise.all([
      withPinnedOdoo("https://one.example.com", A, async (pinned) => {
        await pinned("https://one.example.com/x");
        await pinned("https://one.example.com/y");
      }),
      withPinnedOdoo("https://two.example.com", B, async (pinned) => {
        await pinned("https://two.example.com/x");
        await pinned("https://two.example.com/y");
      }),
    ]);

    for (const request of pinnedRequests) {
      const expected = request.url.startsWith("https://one.") ? A : B;
      expect(request.agent.target).toEqual(expected);
    }
    expect(pinnedRequests).toHaveLength(4);
    expect(plainFetch).not.toHaveBeenCalled();
  });

  it("leaves the process-wide fetch alone, inside the scope and after it", async () => {
    // The pin travels with the fetch handed to the callback. Nothing global is
    // replaced, so no other request in the process passes through it.
    const before = globalThis.fetch;
    await withPinnedOdoo("https://odoo.example.com", A, async (pinned) => {
      expect(globalThis.fetch).toBe(before);
      await fetch("https://odoo.example.com/jsonrpc");
      await pinned("https://odoo.example.com/jsonrpc");
    });

    expect(globalThis.fetch).toBe(before);
    expect(plainFetch).toHaveBeenCalledTimes(1);
    expect(pinnedRequests).toHaveLength(1);
  });

  it("refuses a request once the scope has ended", async () => {
    // A fetch that escaped its scope would run on a closed connector.
    let escaped: typeof fetch | undefined;
    await withPinnedOdoo("https://odoo.example.com", A, async (pinned) => {
      escaped = pinned;
    });

    await expect(escaped!("https://odoo.example.com/jsonrpc")).rejects.toThrow(/scope.*ended/);
    expect(pinnedRequests).toHaveLength(0);
  });
});
