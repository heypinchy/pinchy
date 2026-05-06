import { describe, it, expect, vi, afterEach } from "vitest";
import { registerShutdownHandlers } from "@/lib/shutdown";

describe("registerShutdownHandlers", () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    while (disposers.length) {
      const dispose = disposers.pop();
      try {
        dispose?.();
      } catch {
        // best-effort
      }
    }
  });

  it("calls every registered stopFn when a shutdown signal fires", async () => {
    const stopA = vi.fn();
    const stopB = vi.fn();
    const exit = vi.fn();

    const dispose = registerShutdownHandlers([stopA, stopB], { exit });
    disposers.push(dispose);

    process.emit("SIGTERM", "SIGTERM");
    // Handlers are async — let the microtask queue drain
    await new Promise((resolve) => setImmediate(resolve));

    expect(stopA).toHaveBeenCalledTimes(1);
    expect(stopB).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("runs every stopFn even if an earlier one throws (keeps shutdown best-effort)", async () => {
    // Rationale: if stopUsagePoller throws, we still want to close the HTTP
    // server and release DB handles. One broken shutdown step must not
    // orphan the rest.
    const stopA = vi.fn().mockImplementation(() => {
      throw new Error("poller stop blew up");
    });
    const stopB = vi.fn();
    const exit = vi.fn();

    const dispose = registerShutdownHandlers([stopA, stopB], { exit });
    disposers.push(dispose);

    process.emit("SIGINT", "SIGINT");
    await new Promise((resolve) => setImmediate(resolve));

    expect(stopA).toHaveBeenCalled();
    expect(stopB).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("awaits async stopFns before exiting", async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const stopA = vi.fn().mockImplementation(async () => {
        // Async work scheduled on the timer queue — handler must await it
        // before moving on to stopB and exit.
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("A");
      });
      const stopB = vi.fn().mockImplementation(() => {
        order.push("B");
      });
      const exit = vi.fn().mockImplementation(() => {
        order.push("exit");
      });

      const dispose = registerShutdownHandlers([stopA, stopB], { exit });
      disposers.push(dispose);

      process.emit("SIGTERM", "SIGTERM");
      // Drive stopA's setTimeout via the fake clock; the handler chain then
      // runs stopB and exit synchronously after stopA resolves.
      await vi.advanceTimersByTimeAsync(10);

      // Exit must come strictly after both stop fns finished
      expect(order).toEqual(["A", "B", "exit"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a disposer that removes the signal handlers", async () => {
    const stopA = vi.fn();
    const exit = vi.fn();

    const dispose = registerShutdownHandlers([stopA], { exit });
    dispose();

    process.emit("SIGTERM", "SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));

    expect(stopA).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
