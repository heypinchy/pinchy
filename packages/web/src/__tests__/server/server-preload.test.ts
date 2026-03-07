import { describe, it, expect, vi, afterEach } from "vitest";

function nextTick(): Promise<void> {
  return new Promise((resolve) => process.nextTick(resolve));
}

describe("server-preload warning filter", () => {
  const originalEmit = process.emit.bind(process);

  afterEach(() => {
    // Restore original emit to avoid leaking between tests
    process.emit = originalEmit;
  });

  it("suppresses InsecureTransportWarning", async () => {
    await import("../../../server-preload.cjs");

    const warningHandler = vi.fn();
    process.on("warning", warningHandler);

    try {
      const warning = new Error(
        "Connecting with authentication token over insecure ws:// transport."
      );
      warning.name = "InsecureTransportWarning";
      process.emitWarning(warning);

      await nextTick();

      expect(warningHandler).not.toHaveBeenCalled();
    } finally {
      process.removeListener("warning", warningHandler);
    }
  });

  it("passes through other warnings", async () => {
    await import("../../../server-preload.cjs");

    const warningHandler = vi.fn();
    process.on("warning", warningHandler);

    try {
      process.emitWarning("Some other warning", "SomeWarning");

      await nextTick();

      expect(warningHandler).toHaveBeenCalledTimes(1);
    } finally {
      process.removeListener("warning", warningHandler);
    }
  });
});
