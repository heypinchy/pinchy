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

  it("returns true when the clipboard write succeeds", async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current.copy("hello");
    });

    expect(returned).toBe(true);
  });

  it("falls back to execCommand when navigator.clipboard is unavailable", async () => {
    // Plain-HTTP self-hosted deployments (internal IP, no secure context) have
    // navigator.clipboard === undefined. The hook must not throw there.
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    const originalExec = document.execCommand;
    const execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand;

    try {
      const { result } = renderHook(() => useCopyToClipboard());

      let returned: boolean | undefined;
      await act(async () => {
        returned = await result.current.copy("fallback text");
      });

      expect(returned).toBe(true);
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(result.current.isCopied).toBe(true);
    } finally {
      document.execCommand = originalExec;
    }
  });

  it("falls back to execCommand when navigator.clipboard.writeText rejects", async () => {
    writeText.mockRejectedValueOnce(new Error("NotAllowedError"));
    const originalExec = document.execCommand;
    const execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand;

    try {
      const { result } = renderHook(() => useCopyToClipboard());

      let returned: boolean | undefined;
      await act(async () => {
        returned = await result.current.copy("retry text");
      });

      expect(returned).toBe(true);
      expect(execCommand).toHaveBeenCalledWith("copy");
    } finally {
      document.execCommand = originalExec;
    }
  });

  it("returns false and stays not-copied when clipboard and execCommand both fail", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    const originalExec = document.execCommand;
    const execCommand = vi.fn().mockReturnValue(false);
    document.execCommand = execCommand;

    try {
      const { result } = renderHook(() => useCopyToClipboard());

      let returned: boolean | undefined;
      await act(async () => {
        returned = await result.current.copy("nope");
      });

      expect(returned).toBe(false);
      expect(result.current.isCopied).toBe(false);
    } finally {
      document.execCommand = originalExec;
    }
  });
});
