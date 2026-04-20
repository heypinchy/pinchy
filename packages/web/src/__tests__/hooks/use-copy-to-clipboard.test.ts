import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

const writeText = vi.fn();

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    writable: true,
    configurable: true,
  });
  writeText.mockResolvedValue(undefined);
  vi.useFakeTimers();
});

afterEach(() => {
  writeText.mockReset();
  vi.useRealTimers();
});

describe("useCopyToClipboard", () => {
  it("starts with isCopied false", () => {
    const { result } = renderHook(() => useCopyToClipboard());

    expect(result.current.isCopied).toBe(false);
  });

  it("sets isCopied to true after copying", async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy("hello");
    });

    expect(result.current.isCopied).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("reverts isCopied to false after the default duration", async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy("hello");
    });

    expect(result.current.isCopied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.isCopied).toBe(false);
  });

  it("accepts a custom copiedDuration", async () => {
    const { result } = renderHook(() => useCopyToClipboard({ copiedDuration: 5000 }));

    await act(async () => {
      await result.current.copy("hello");
    });

    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(result.current.isCopied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.isCopied).toBe(false);
  });
});
