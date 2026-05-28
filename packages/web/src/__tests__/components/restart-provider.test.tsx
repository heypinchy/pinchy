import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import React from "react";

// Track fetch calls manually
let fetchResponses: Array<{ status: string; since?: number }> = [];
let fetchCallCount = 0;
let diagnosticsResponse: Record<string, unknown> | null = null;

const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCallCount = 0;
  fetchResponses = [{ status: "ok" }];
  diagnosticsResponse = null;
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
    if (url.includes("/api/diagnostics")) {
      if (!diagnosticsResponse) {
        return new Response("", { status: 500 });
      }
      return new Response(JSON.stringify(diagnosticsResponse), {
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

  it("shows error state with report link after timeout", async () => {
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

    // Server keeps reporting "restarting" indefinitely
    fetchResponses = [{ status: "restarting", since: Date.now() }];
    fetchCallCount = 0;

    await act(async () => {
      screen.getByText("trigger").click();
    });

    expect(screen.getByText(/applying changes/i)).toBeInTheDocument();

    // Advance past the 30s timeout
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    // Should show secondary tier instead of spinner — copy is the honest
    // "OC is finishing up active conversations" message rather than the
    // generic "this took longer than expected" that we used to ship.
    await waitFor(() => {
      expect(screen.queryByText(/hang tight/i)).not.toBeInTheDocument();
      expect(screen.getByText(/still working on it/i)).toBeInTheDocument();
      expect(
        screen.getByText(/finishing up active conversations before applying changes/i)
      ).toBeInTheDocument();
      expect(screen.getByText(/report this issue/i)).toBeInTheDocument();
    });
  });

  it("shows diagnostics details on timeout when available", async () => {
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

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    fetchResponses = [{ status: "restarting", since: Date.now() }];
    fetchCallCount = 0;
    diagnosticsResponse = {
      database: "connected",
      openclaw: "unreachable",
      version: "0.1.0",
      nodeEnv: "production",
    };

    await act(async () => {
      screen.getByText("trigger").click();
    });

    // Advance past the 30s timeout
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    // Should fetch diagnostics and display status
    await waitFor(() => {
      expect(screen.getByText("OpenClaw")).toBeInTheDocument();
      expect(screen.getByText("unreachable")).toBeInTheDocument();
      expect(screen.getByText("Database")).toBeInTheDocument();
      expect(screen.getByText("connected")).toBeInTheDocument();
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

  it("recovers from timed-out state when a later poll returns ok", async () => {
    // Production incident 2026-05-28: OC's restart was deferred ~3.5 min because
    // active background tasks blocked the gateway restart. The overlay flipped
    // into the "timed out" tier after 30 s, polling stopped, and the user was
    // stranded even though OC came back fine. Polling must keep running (at a
    // slower cadence) so the recovered server state un-sticks the overlay.
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

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // First 16 polls report "restarting" (covers ~30 s at 2 s + a couple slow
    // polls after the 30 s timeout flips to SLOW_POLL_INTERVAL_MS=5 s),
    // then poll 17+ reports "ok" (OC reconnected).
    fetchResponses = [
      ...Array.from({ length: 16 }, () => ({ status: "restarting" as const, since: Date.now() })),
      { status: "ok" as const },
    ];
    fetchCallCount = 0;

    await act(async () => {
      screen.getByText("trigger").click();
    });

    // Cross the 30 s timeout — overlay flips to the secondary tier.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(screen.getByText(/still working on it/i)).toBeInTheDocument();

    // After timed-out polling cadence (5 s in the new impl), the next ok response
    // must un-stick the overlay without a browser reload.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    await waitFor(() => {
      expect(screen.queryByText(/still working on it/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/hang tight/i)).not.toBeInTheDocument();
    });
  });
});
