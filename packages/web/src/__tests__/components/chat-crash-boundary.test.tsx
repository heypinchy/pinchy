/**
 * Regression guard for the recurring `tapClientLookup: Index N out of bounds`
 * full-page crash. Root cause: assistant-ui's index-keyed message list throws
 * when the message array shrinks while `<ThreadPrimitive.Messages>` is mounted
 * (a trailing-index child re-renders with a now-stale index one commit before
 * React unmounts it). Four prior fixes (v0.5.7 anchor, #470 own-placeholder,
 * #199 disconnect-defer, #510 reconcile-shrink-guard in use-ws-runtime.ts) each
 * closed ONE shrink path reactively — #510's own comment says the crash
 * "survived" the earlier two. `ChatCrashBoundary` is the path-agnostic fix: it
 * catches this error CLASS regardless of which shrink path caused it, recovers
 * by remounting just the thread, and — critically — rethrows anything else so
 * unrelated bugs still surface via the normal app/error.tsx path instead of
 * being silently swallowed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Component, useEffect, useState, type ReactNode } from "react";
import { ChatCrashBoundary, isTapClientLookupCrash } from "@/components/chat-crash-boundary";

// Mirrors app/error.tsx's role in production: the ancestor boundary a
// genuinely-unrelated error must still reach. Flips to "outer-crashed" on ANY
// throw — this is deliberately dumb/catch-all, standing in for the route-level
// boundary that already exists in the app and is out of scope for this test.
class OuterCrashBoundary extends Component<{ children: ReactNode }, { errored: boolean }> {
  state = { errored: false };
  static getDerivedStateFromError() {
    return { errored: true };
  }
  componentDidCatch() {}
  render() {
    if (this.state.errored) return <div data-testid="outer-crashed">Something went wrong</div>;
    return this.props.children;
  }
}

/**
 * A pure function of its `shouldStop` prop: throws `error` while false, renders
 * normally once true. No wall-clock reads in its own render body — reading
 * `Date.now()` directly here would be an impure render (React's own purity
 * lint correctly flags this), and worse, a component that ALWAYS throws can
 * never successfully commit, so it can never run its OWN effect to flip a
 * timer — React never commits (and therefore never runs effects for) a
 * throwing render. The timing lives in `DelayedStopGate` instead, a sibling
 * component ABOVE `ChatCrashBoundary` that survives the boundary's internal
 * catch/remount cycle and feeds `shouldStop` down as a plain prop.
 */
function Bomb({ error, shouldStop }: { error: Error; shouldStop: boolean }) {
  if (!shouldStop) throw error;
  return <div data-testid="recovered-content">recovered</div>;
}

/**
 * Flips `shouldStop` to true `afterMs` after mount, via a real effect (not a
 * render-time side effect). Must be mounted OUTSIDE `ChatCrashBoundary` — when
 * `Bomb` throws, React unmounts the ENTIRE subtree up to the nearest boundary,
 * so anything living INSIDE the boundary alongside `Bomb` would be torn down
 * too and never get a chance to run its timer.
 */
function DelayedStopGate({
  afterMs,
  children,
}: {
  afterMs?: number;
  children: (shouldStop: boolean) => ReactNode;
}) {
  const [shouldStop, setShouldStop] = useState(false);
  useEffect(() => {
    if (afterMs === undefined) return;
    const timer = setTimeout(() => setShouldStop(true), afterMs);
    return () => clearTimeout(timer);
  }, [afterMs]);
  return <>{children(shouldStop)}</>;
}

function AlwaysGood() {
  return <div data-testid="good-content">good</div>;
}

const TAP_CLIENT_LOOKUP_ERROR = new Error("tapClientLookup: Index 18 out of bounds (length: 18)");
const GENERIC_OUT_OF_BOUNDS_ERROR = new Error("Index 3 out of bounds (length: 3)");
const UNRELATED_ERROR = new Error("totally unrelated boom");

describe("isTapClientLookupCrash", () => {
  it("matches the named tapClientLookup error", () => {
    expect(isTapClientLookupCrash(TAP_CLIENT_LOOKUP_ERROR)).toBe(true);
  });

  it("matches the generic 'Index N out of bounds' wording without the function name", () => {
    expect(isTapClientLookupCrash(GENERIC_OUT_OF_BOUNDS_ERROR)).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isTapClientLookupCrash(new Error("TAPCLIENTLOOKUP: INDEX 1 OUT OF BOUNDS"))).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isTapClientLookupCrash(UNRELATED_ERROR)).toBe(false);
    expect(isTapClientLookupCrash(new Error("Network request failed"))).toBe(false);
  });

  it("does not match a non-Error thrown value", () => {
    expect(isTapClientLookupCrash("just a string")).toBe(false);
    expect(isTapClientLookupCrash(undefined)).toBe(false);
  });
});

describe("ChatCrashBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders children normally when nothing throws", () => {
    render(
      <ChatCrashBoundary>
        <AlwaysGood />
      </ChatCrashBoundary>
    );
    expect(screen.getByTestId("good-content")).toBeInTheDocument();
  });

  it("catches a tapClientLookup crash, shows a transient recovery state, then recovers to working content", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <DelayedStopGate afterMs={20}>
        {(shouldStop) => (
          <ChatCrashBoundary>
            <Bomb error={TAP_CLIENT_LOOKUP_ERROR} shouldStop={shouldStop} />
          </ChatCrashBoundary>
        )}
      </DelayedStopGate>
    );

    // Transient recovery state first — never the generic full-page crash text.
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
    expect(screen.getByText(/reconnecting your conversation/i)).toBeInTheDocument();

    // Recovers on its own (remounts the child) without any user action.
    await waitFor(() => expect(screen.getByTestId("recovered-content")).toBeInTheDocument());
    expect(screen.queryByText(/reconnecting your conversation/i)).not.toBeInTheDocument();

    // No silent failure — the incident is logged.
    expect(errorSpy).toHaveBeenCalled();
  });

  it("does NOT swallow an unrelated error — it propagates to the outer boundary", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <OuterCrashBoundary>
        <ChatCrashBoundary>
          <Bomb error={UNRELATED_ERROR} shouldStop={false} />
        </ChatCrashBoundary>
      </OuterCrashBoundary>
    );

    // The INNER boundary must not show its own recovery fallback for this class
    // of error — it re-threw, so the OUTER boundary caught it instead.
    expect(screen.queryByText(/reconnecting your conversation/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("outer-crashed")).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("stops auto-recovering and escalates after repeated crashes (loop protection)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <OuterCrashBoundary>
        <ChatCrashBoundary>
          {/* Never stops throwing — simulates a pathological, unrecoverable loop. */}
          <Bomb error={TAP_CLIENT_LOOKUP_ERROR} shouldStop={false} />
        </ChatCrashBoundary>
      </OuterCrashBoundary>
    );

    // Eventually gives up recovering internally and escalates to the outer
    // boundary rather than spinning on "Reconnecting..." forever.
    await waitFor(() => expect(screen.getByTestId("outer-crashed")).toBeInTheDocument(), {
      timeout: 3000,
    });
  });
});
