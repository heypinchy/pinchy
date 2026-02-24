import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import React from "react";

// Track fetch calls manually
let fetchResponses: Array<{ status: string; since?: number }> = [];
let fetchCallCount = 0;

const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCallCount = 0;
  fetchResponses = [{ status: "ok" }];
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/health/openclaw")) {
      const response = fetchResponses[Math.min(fetchCallCount, fetchResponses.length - 1)];
      fetchCallCount++;
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("RestartProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not show overlay by default when health returns ok", async () => {
    const { RestartProvider } = await import("@/components/restart-provider");

    render(
      <RestartProvider>
        <div data-testid="child">Hello</div>
      </RestartProvider>
    );

    // Wait for mount-time health check
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(screen.getByTestId("child")).toBeInTheDocument();
    expect(screen.queryByText(/applying changes/i)).not.toBeInTheDocument();
  });

  it("shows overlay when triggerRestart is called", async () => {
    const { RestartProvider, useRestart } = await import("@/components/restart-provider");

    function Consumer() {
      const { triggerRestart } = useRestart();
      return <button onClick={triggerRestart}>trigger</button>;
    }

    render(
      <RestartProvider>
        <Consumer />
      </RestartProvider>
    );

    // Wait for initial health check
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Set up responses: restarting first, then ok
    fetchResponses = [{ status: "restarting", since: Date.now() }, { status: "ok" }];
    fetchCallCount = 0;

    await act(async () => {
      screen.getByText("trigger").click();
    });

    expect(screen.getByText(/applying changes/i)).toBeInTheDocument();
  });

  it("hides overlay when health returns ok after polling", async () => {
    const { RestartProvider, useRestart } = await import("@/components/restart-provider");

    function Consumer() {
      const { triggerRestart } = useRestart();
      return <button onClick={triggerRestart}>trigger</button>;
    }

    render(
      <RestartProvider>
        <Consumer />
      </RestartProvider>
    );

    // Wait for initial health check
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // After trigger: first poll still restarting, second poll returns ok
    fetchResponses = [{ status: "restarting", since: Date.now() }, { status: "ok" }];
    fetchCallCount = 0;

    await act(async () => {
      screen.getByText("trigger").click();
    });

    expect(screen.getByText(/applying changes/i)).toBeInTheDocument();

    // First poll at 2s — still restarting
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(screen.getByText(/applying changes/i)).toBeInTheDocument();

    // Second poll at 4s — returns ok
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    await waitFor(() => {
      expect(screen.queryByText(/applying changes/i)).not.toBeInTheDocument();
    });
  });

  it("shows overlay on mount when health reports restarting", async () => {
    fetchResponses = [{ status: "restarting", since: Date.now() }];

    const { RestartProvider } = await import("@/components/restart-provider");

    render(
      <RestartProvider>
        <div data-testid="child">Hello</div>
      </RestartProvider>
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    await waitFor(() => {
      expect(screen.getByText(/applying changes/i)).toBeInTheDocument();
    });
  });

  it("keeps polling on fetch errors", async () => {
    const { RestartProvider, useRestart } = await import("@/components/restart-provider");

    function Consumer() {
      const { triggerRestart } = useRestart();
      return <button onClick={triggerRestart}>trigger</button>;
    }

    render(
      <RestartProvider>
        <Consumer />
      </RestartProvider>
    );

    // Wait for initial health check
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Trigger restart, then simulate fetch failure, then ok
    let callIndex = 0;
    globalThis.fetch = vi.fn(async () => {
      callIndex++;
      if (callIndex === 1) throw new Error("Network error");
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await act(async () => {
      screen.getByText("trigger").click();
    });

    expect(screen.getByText(/applying changes/i)).toBeInTheDocument();

    // After network error, should keep polling
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    // After second poll succeeds, overlay should disappear
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    await waitFor(() => {
      expect(screen.queryByText(/applying changes/i)).not.toBeInTheDocument();
    });
  });
});
