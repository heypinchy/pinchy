// The push-generation counter must be shared across module instances.
//
// `pushConfigInBackground` cancels an older push by comparing its own
// generation against a counter that every push bumps. That only works if all
// pushes in the process count on the SAME counter — and they do not, unless the
// counter lives on globalThis: the custom server (`node --import tsx server.ts`)
// and Next.js's route bundles are two module registries inside one process, so
// `src/lib/openclaw-config/write.ts` is loaded twice.
//
// Measured in the dev stack rather than assumed — a module-load probe printed:
//
//   [probe] write.ts module loaded: instance=0d88ll all=["0d88ll"] pid=47
//   [probe] write.ts module loaded: instance=ng8zfo all=["0d88ll","ng8zfo"] pid=47
//
// (first line at server boot, second on the first request to an API route that
// imports the module — same pid, same globalThis, two instances).
//
// With a plain module-level counter each instance mints generations 1, 2, 3…
// independently, so a route-triggered push cannot supersede a server-triggered
// one: both reach `config.apply`, which is the restart storm the guard exists
// to stop (#193). `vi.resetModules()` reproduces exactly that shape — a second,
// independent instance of the module in one process.

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockGetClient = vi.fn();
vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => mockGetClient(),
}));

const mockWriteFileSync = vi.fn();
vi.mock("fs", () => ({
  existsSync: () => true,
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  readFileSync: () => {
    const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  },
}));

/** Let every pending microtask (the push coroutines) run to its next await. */
async function drain() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

describe("push generation across module instances", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("lets a push from one module instance supersede a push from another", async () => {
    // Two independent instances of write.ts, as the custom server and a Next
    // route bundle hold them.
    const serverInstance = await import("@/lib/openclaw-config/write");
    vi.resetModules();
    const routeInstance = await import("@/lib/openclaw-config/write");
    expect(
      routeInstance.pushConfigInBackground,
      "vi.resetModules must yield a genuinely separate module instance"
    ).not.toBe(serverInstance.pushConfigInBackground);
    // No reset of the generation here, on purpose: the counter is a monotonic
    // cancellation token and this test only cares about the ORDER of the two
    // pushes, never about their absolute numbers.

    // The server's push parks on config.get(); the route's push resolves at once.
    let resolveServerGet: ((value: { hash: string }) => void) | undefined;
    const configGet = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ hash: string }>((resolve) => {
            resolveServerGet = resolve;
          })
      )
      .mockResolvedValue({ hash: "h-route" });
    const configApply = vi.fn().mockResolvedValue(undefined);
    mockGetClient.mockReturnValue({ config: { get: configGet, apply: configApply } });

    serverInstance.pushConfigInBackground(JSON.stringify({ env: { OLD: "1" } }));
    await drain();
    expect(configGet).toHaveBeenCalledTimes(1);
    expect(resolveServerGet).toBeDefined();

    // A newer push starts from the OTHER instance and lands its payload.
    routeInstance.pushConfigInBackground(JSON.stringify({ env: { NEW: "2" } }));
    await drain();
    expect(configApply).toHaveBeenCalledTimes(1);
    expect(String(configApply.mock.calls[0][0])).toContain('"NEW"');

    // Only now does the older push's config.get() resolve. It must recognise
    // that it was superseded — by a push it can only see through a shared
    // counter — and return without applying its stale payload.
    resolveServerGet?.({ hash: "h-server" });
    await drain();

    const stalePayloadApplied = configApply.mock.calls.some((call) =>
      String(call[0]).includes('"OLD"')
    );
    expect(
      stalePayloadApplied,
      "a push from another module instance must supersede this one — otherwise both apply and OC restarts (#193)"
    ).toBe(false);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});
