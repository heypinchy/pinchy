import { describe, it, expect, vi } from "vitest";
import { bootstrapMemoryAuditWatcher } from "@/lib/memory-audit-watcher/bootstrap";

vi.mock("chokidar", () => ({
  default: {
    watch: () => {
      const handlers: Record<string, (path: string) => void> = {};
      return {
        on(event: string, cb: (path: string) => void) {
          handlers[event] = cb;
          if (event === "ready") queueMicrotask(() => cb(""));
          return this;
        },
        close: async () => {},
      };
    },
  },
}));

describe("bootstrapMemoryAuditWatcher", () => {
  it("returns a stop function", async () => {
    const stop = await bootstrapMemoryAuditWatcher({ root: "/tmp/test-root-not-used" });
    expect(typeof stop).toBe("function");
    await stop();
  });
});
