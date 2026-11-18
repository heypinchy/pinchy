/**
 * One audit row per window, with the rejections it stood in for counted on the
 * next row rather than dropped.
 *
 * Recording a block is worth doing; recording every block is bounded by
 * nothing. Both gates in `server.ts` can be driven by an *unauthenticated*
 * caller — a domain-locked instance is by definition reachable at an address
 * that isn't its domain, and neither a foreign `Host` nor a foreign `Origin`
 * needs a credential, a cookie or a session. Every row takes
 * `pg_advisory_xact_lock` on a single constant key (lib/audit.ts), so an
 * unbounded stream doesn't just grow an immutable table: it serializes every
 * genuine audit write in the process behind itself. And it buries exactly what
 * the event exists to surface — one of Pinchy's own components being turned
 * away.
 *
 * The window is global, not keyed. Every dimension available to key on — host,
 * path, origin, remote address — is supplied by the caller, so a map keyed on
 * one of them grows per request and the throttle stops throttling.
 * (`scopeDenialWindows` in lib/api-auth.ts can key by API key precisely because
 * an admin must mint one first.) The cost is real and accepted: within a
 * window, a flood can mask a different component's block. The row that does get
 * written still names its own host/origin and path, and
 * `suppressedSinceLastEntry` reports the scale.
 *
 * Per-process state; a restart just reopens the window, which costs one row.
 */
export type AuditFloodWindow = {
  /** `write: false` means this rejection was folded into the open window. */
  claim(now: number): { write: boolean; suppressed: number };
  /** Test seam — the window is process-global, so suites must start from zero. */
  reset(): void;
};

export function createAuditFloodWindow(windowMs: number): AuditFloodWindow {
  let open: { openedAt: number; suppressed: number } | null = null;

  return {
    claim(now: number) {
      if (open && now - open.openedAt < windowMs) {
        open.suppressed++;
        return { write: false, suppressed: open.suppressed };
      }
      const suppressed = open?.suppressed ?? 0;
      open = { openedAt: now, suppressed: 0 };
      return { write: true, suppressed };
    },
    reset() {
      open = null;
    },
  };
}
