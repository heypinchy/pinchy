"use client";

import { Component, Fragment, useEffect, type ErrorInfo, type ReactNode } from "react";

/**
 * Defense-in-depth against the recurring `tapClientLookup: Index N out of
 * bounds (length: N)` full-page crash.
 *
 * Root cause (assistant-ui): `<ThreadPrimitive.Messages>` renders one child per
 * message-array index; each child independently reads its own store slice by
 * index. When the array shrinks while mounted, a trailing-index child re-renders
 * with a now-stale index one commit before React unmounts it, and throws.
 *
 * Pinchy has closed four distinct shrink paths reactively (v0.5.7 in-flight
 * anchor, #470 own-placeholder, #199 disconnect-defer, #510 reconcile-shrink-
 * guard in use-ws-runtime.ts) — #510's own comment notes the crash "survived"
 * the first two. Each fix closes ONE path; the library defect remains reachable
 * via any future path. This boundary is the path-agnostic answer: it recovers
 * from this error CLASS regardless of which shrink caused it, by remounting
 * just the message thread (not the whole page/route) — while rethrowing any
 * OTHER error so unrelated bugs still surface normally via app/error.tsx
 * instead of being silently swallowed.
 */
export function isTapClientLookupCrash(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message) return false;
  return /tapClientLookup|index\s+\d+\s+out of bounds/i.test(message);
}

// After this many recovery attempts without the crash going away, stop
// swallowing and let it escalate to the nearest ancestor boundary instead of
// spinning on the transient recovery state forever (a persistent crash must
// still surface — "no silent failures").
const MAX_RECOVERY_ATTEMPTS = 3;

// Give the corrupted commit a tick to fully unwind before remounting the
// thread — an immediate synchronous remount into the same still-shrinking
// state could re-crash right away.
const RECOVERY_DELAY_MS = 50;

interface ChatCrashBoundaryState {
  caught: unknown;
  recoveryNonce: number;
  recoveryAttempts: number;
}

export class ChatCrashBoundary extends Component<{ children: ReactNode }, ChatCrashBoundaryState> {
  state: ChatCrashBoundaryState = { caught: null, recoveryNonce: 0, recoveryAttempts: 0 };

  static getDerivedStateFromError(error: unknown): Partial<ChatCrashBoundaryState> {
    return { caught: error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // Only log here for the class we actually recover from. A non-matching
    // error is rethrown in render() and propagates to the ancestor boundary,
    // which reports it through its own path — logging it here too would be a
    // confusing double-report of the same incident.
    if (isTapClientLookupCrash(error)) {
      console.error(
        "[ChatCrashBoundary] recovered from an assistant-ui message-list crash:",
        error,
        info.componentStack
      );
    }
  }

  private recover = () => {
    this.setState((s) => ({
      caught: null,
      recoveryNonce: s.recoveryNonce + 1,
      recoveryAttempts: s.recoveryAttempts + 1,
    }));
  };

  render() {
    const { caught, recoveryNonce, recoveryAttempts } = this.state;
    if (caught) {
      // React error boundaries can't catch an error thrown from their OWN
      // render — a boundary only catches errors from its descendants. So
      // throwing here for a non-matching error (or once we've given up after
      // MAX_RECOVERY_ATTEMPTS) correctly propagates to the nearest ANCESTOR
      // boundary instead of looping back into this one.
      if (!isTapClientLookupCrash(caught) || recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
        throw caught;
      }
      return <ChatRecoveryFallback onRecovered={this.recover} />;
    }
    // Keyed so a bumped nonce forces a full remount of the subtree, discarding
    // whatever corrupted assistant-ui store slice caused the crash. The message
    // data itself lives in use-ws-runtime's React state above this boundary and
    // survives the remount — the recovered thread re-syncs from it.
    return <Fragment key={recoveryNonce}>{this.props.children}</Fragment>;
  }
}

function ChatRecoveryFallback({ onRecovered }: { onRecovered: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onRecovered, RECOVERY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [onRecovered]);

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3">
      <div
        data-testid="loading-spinner"
        className="size-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground"
      />
      <p className="text-sm font-medium text-muted-foreground">Reconnecting your conversation…</p>
    </div>
  );
}
