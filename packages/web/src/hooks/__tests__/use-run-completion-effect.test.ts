import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRunCompletionEffect } from "@/hooks/use-run-completion-effect";

// Fires `onComplete` each time a chat run finishes (isRunning true -> false).
// The ChatSwitcher uses it to refetch the conversation list so the server-
// derived title appears immediately after the first message, instead of only
// when the dropdown is reopened or the agent is switched.

describe("useRunCompletionEffect", () => {
  it("does not fire on mount when idle", () => {
    const onComplete = vi.fn();
    renderHook(({ running }) => useRunCompletionEffect(running, onComplete), {
      initialProps: { running: false },
    });
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("does not fire on mount when it starts mid-run", () => {
    const onComplete = vi.fn();
    renderHook(({ running }) => useRunCompletionEffect(running, onComplete), {
      initialProps: { running: true },
    });
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("does not fire when a run starts (false -> true)", () => {
    const onComplete = vi.fn();
    const { rerender } = renderHook(({ running }) => useRunCompletionEffect(running, onComplete), {
      initialProps: { running: false },
    });
    rerender({ running: true });
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("fires once when a run completes (true -> false)", () => {
    const onComplete = vi.fn();
    const { rerender } = renderHook(({ running }) => useRunCompletionEffect(running, onComplete), {
      initialProps: { running: false },
    });
    rerender({ running: true });
    rerender({ running: false });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("fires again on a subsequent run completion", () => {
    const onComplete = vi.fn();
    const { rerender } = renderHook(({ running }) => useRunCompletionEffect(running, onComplete), {
      initialProps: { running: false },
    });
    rerender({ running: true });
    rerender({ running: false });
    rerender({ running: true });
    rerender({ running: false });
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it("calls the latest callback and does not fire on callback identity change alone", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ running, cb }) => useRunCompletionEffect(running, cb), {
      initialProps: { running: true, cb: first },
    });
    // Callback swapped while still running -> no fire.
    rerender({ running: true, cb: second });
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    // Completion fires only the latest callback.
    rerender({ running: false, cb: second });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
