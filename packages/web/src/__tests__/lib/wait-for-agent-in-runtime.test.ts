import { describe, it, expect, vi } from "vitest";
import type { OpenClawClient } from "openclaw-node";
import { waitForAgentInRuntime } from "@/lib/wait-for-agent-in-runtime";

function mockClient(
  responses: Array<{ agents?: { list?: Array<{ id: string }> } }>
): OpenClawClient {
  let i = 0;
  return {
    config: {
      get: vi.fn(async () => ({ config: responses[Math.min(i++, responses.length - 1)] })),
    },
  } as unknown as OpenClawClient;
}

describe("waitForAgentInRuntime", () => {
  it("returns true as soon as the agent appears in agents.list", async () => {
    // OC's reload pipeline lands `agents.list` slightly after the config
    // change is detected. The helper polls config.get cheaply (no restart
    // trigger) and exits the moment the new id is visible.
    const client = mockClient([
      { agents: { list: [{ id: "other-agent" }] } },
      { agents: { list: [{ id: "other-agent" }, { id: "new-agent" }] } },
    ]);

    const found = await waitForAgentInRuntime(client, "new-agent", 1000, 10);
    expect(found).toBe(true);
  });

  it("returns false when the agent never appears within the timeout", async () => {
    const client = mockClient([{ agents: { list: [{ id: "other-agent" }] } }]);
    const found = await waitForAgentInRuntime(client, "missing", 100, 10);
    expect(found).toBe(false);
  });

  it("keeps polling through transient errors", async () => {
    // Reload windows can briefly close the WS connection; openclaw-node
    // throws on config.get during reconnect. Don't treat that as a permanent
    // miss — keep polling until the agent shows up.
    let calls = 0;
    const client = {
      config: {
        get: vi.fn(async () => {
          calls++;
          if (calls <= 2) throw new Error("WebSocket disconnected");
          return { config: { agents: { list: [{ id: "new-agent" }] } } };
        }),
      },
    } as unknown as OpenClawClient;

    const found = await waitForAgentInRuntime(client, "new-agent", 1000, 10);
    expect(found).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("returns false immediately when client is null (no OpenClaw available)", async () => {
    const found = await waitForAgentInRuntime(null, "any", 1000, 10);
    expect(found).toBe(false);
  });
});
