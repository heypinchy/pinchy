import { describe, it, expect, vi } from "vitest";
import { buildShutdownSteps, type ShutdownDeps } from "@/server/shutdown-steps";

// ws readyState constants (avoid importing the real "ws" package for a pure
// unit test): CONNECTING=0, OPEN=1, CLOSING=2, CLOSED=3.
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSED = 3;

function makeFakeClient(readyState: number) {
  return { readyState, close: vi.fn() };
}

function makeDeps(overrides: Partial<ShutdownDeps> = {}, calls: string[] = []): ShutdownDeps {
  const wssClose = vi.fn((cb: () => void) => cb());
  return {
    stopUploadGc: vi.fn(async () => {
      calls.push("stopUploadGc");
    }),
    stopChatErrorGc: vi.fn(async () => {
      calls.push("stopChatErrorGc");
    }),
    stopAuditVerifyJob: vi.fn(async () => {
      calls.push("stopAuditVerifyJob");
    }),
    stopUsagePoller: vi.fn(async () => {
      calls.push("stopUsagePoller");
    }),
    stopMemoryAuditWatcher: vi.fn(async () => {
      calls.push("stopMemoryAuditWatcher");
    }),
    getOpenclawClient: vi.fn(() => null),
    wss: {
      clients: new Set(),
      close: wssClose,
    },
    closeHttpServer: vi.fn(async () => {
      calls.push("closeHttpServer");
    }),
    closeDb: vi.fn(async () => {
      calls.push("closeDb");
    }),
    ...overrides,
  };
}

describe("buildShutdownSteps (#263)", () => {
  it("returns exactly 9 steps in the documented order", async () => {
    const calls: string[] = [];
    const deps = makeDeps({}, calls);
    const steps = buildShutdownSteps(deps);

    expect(steps).toHaveLength(9);

    for (const step of steps) {
      await step();
    }

    expect(calls).toEqual([
      "stopUploadGc",
      "stopChatErrorGc",
      "stopAuditVerifyJob",
      "stopUsagePoller",
      "stopMemoryAuditWatcher",
      // disconnect + WS drain + closeHttpServer produce no `calls` entry by
      // default (getOpenclawClient -> null, no fake ws clients), so the next
      // recorded entries are:
      "closeHttpServer",
      "closeDb",
    ]);
  });

  it("invokes each step's own dependency call in array order", async () => {
    const client = { disconnect: vi.fn(async () => {}) };
    const calls: string[] = [];
    const deps = makeDeps(
      {
        getOpenclawClient: vi.fn(() => client),
      },
      calls
    );
    const steps = buildShutdownSteps(deps);

    for (const step of steps) {
      await step();
    }

    expect(deps.stopUploadGc).toHaveBeenCalledTimes(1);
    expect(deps.stopChatErrorGc).toHaveBeenCalledTimes(1);
    expect(deps.stopAuditVerifyJob).toHaveBeenCalledTimes(1);
    expect(deps.stopUsagePoller).toHaveBeenCalledTimes(1);
    expect(deps.stopMemoryAuditWatcher).toHaveBeenCalledTimes(1);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect(deps.wss.close).toHaveBeenCalledTimes(1);
    expect(deps.closeHttpServer).toHaveBeenCalledTimes(1);
    expect(deps.closeDb).toHaveBeenCalledTimes(1);

    // closeDb must be the very last step, and stopUploadGc the very first.
    expect(steps[0]).toBeTypeOf("function");
    expect(calls[0]).toBe("stopUploadGc");
    expect(calls[calls.length - 1]).toBe("closeDb");
  });

  describe("OpenClaw disconnect step", () => {
    it("calls disconnect on the client returned by getOpenclawClient", async () => {
      const client = { disconnect: vi.fn(async () => {}) };
      const deps = makeDeps({ getOpenclawClient: vi.fn(() => client) });
      const steps = buildShutdownSteps(deps);

      // Step index 5 (0-based) is the OpenClaw disconnect step.
      await steps[5]();

      expect(client.disconnect).toHaveBeenCalledTimes(1);
    });

    it("is a no-op that still resolves when getOpenclawClient returns null", async () => {
      const deps = makeDeps({ getOpenclawClient: vi.fn(() => null) });
      const steps = buildShutdownSteps(deps);

      await expect(steps[5]()).resolves.toBeUndefined();
    });
  });

  describe("WS drain step", () => {
    it("closes only OPEN clients with code 1001, leaves others untouched, then closes wss", async () => {
      const openClient = makeFakeClient(WS_OPEN);
      const closedClient = makeFakeClient(WS_CLOSED);
      const connectingClient = makeFakeClient(WS_CONNECTING);

      const wssClose = vi.fn((cb: () => void) => cb());
      const deps = makeDeps({
        wss: {
          clients: new Set([openClient, closedClient, connectingClient]) as never,
          close: wssClose,
        },
      });
      const steps = buildShutdownSteps(deps);

      // Step index 6 (0-based) is the WS-drain step.
      await steps[6]();

      expect(openClient.close).toHaveBeenCalledWith(1001, "server shutting down");
      expect(closedClient.close).not.toHaveBeenCalled();
      expect(connectingClient.close).not.toHaveBeenCalled();
      expect(wssClose).toHaveBeenCalledTimes(1);
    });

    it("resolves once wss.close's callback fires (does not hang)", async () => {
      const deps = makeDeps();
      const steps = buildShutdownSteps(deps);

      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("WS drain step hung")), 500)
      );

      await expect(Promise.race([steps[6](), timeout])).resolves.toBeUndefined();
    });
  });

  describe("closeHttpServer and closeDb steps", () => {
    it("calls the injected closeHttpServer", async () => {
      const deps = makeDeps();
      const steps = buildShutdownSteps(deps);

      // Step index 7 (0-based) closes the HTTP server.
      await steps[7]();

      expect(deps.closeHttpServer).toHaveBeenCalledTimes(1);
    });

    it("calls closeDb last", async () => {
      const deps = makeDeps();
      const steps = buildShutdownSteps(deps);

      // Step index 8 (0-based) closes the DB pool.
      await steps[8]();

      expect(deps.closeDb).toHaveBeenCalledTimes(1);
    });
  });
});
