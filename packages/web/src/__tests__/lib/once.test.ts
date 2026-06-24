import { describe, it, expect, vi } from "vitest";
import { once } from "@/lib/once";

describe("once", () => {
  it("runs the wrapped function exactly once across multiple calls", () => {
    const fn = vi.fn();
    const wrapped = once(fn);

    wrapped();
    wrapped();
    wrapped();

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("isolates separate wrappers", () => {
    const fn = vi.fn();
    const a = once(fn);
    const b = once(fn);

    a();
    a();
    b();

    // a fired once, b fired once → two total invocations.
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
