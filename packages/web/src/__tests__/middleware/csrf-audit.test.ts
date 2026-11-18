import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { logCsrfBlocked, resetCsrfBlockWindow } from "@/server/csrf-check";
import { appendAuditLog } from "@/lib/audit";

function blocked(overrides: Partial<Parameters<typeof logCsrfBlocked>[0]> = {}) {
  return logCsrfBlocked({
    reason: "origin-mismatch",
    method: "POST",
    pathname: "/api/agents",
    origin: "https://evil.example.com",
    referer: undefined,
    remoteAddress: "203.0.113.42",
    client: { address: "203.0.113.42", source: "socket" },
    ...overrides,
  });
}

describe("logCsrfBlocked", () => {
  beforeEach(() => {
    vi.mocked(appendAuditLog).mockClear();
    // Process-global window (see audit-flood-window.ts) — every test starts
    // from zero or the second one in the file silently writes nothing.
    resetCsrfBlockWindow();
  });

  it("appends an auth.csrf_blocked audit entry with the request context", async () => {
    await logCsrfBlocked({
      reason: "origin-mismatch",
      method: "POST",
      pathname: "/api/users/invite",
      origin: "https://evil.example.com",
      referer: undefined,
      remoteAddress: "203.0.113.42",
      client: { address: "203.0.113.42", source: "socket" },
    });

    expect(appendAuditLog).toHaveBeenCalledTimes(1);
    const call = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(call.eventType).toBe("auth.csrf_blocked");
    expect(call.outcome).toBe("failure");
    expect(call.actorType).toBe("system");
    expect(call.actorId).toBe("system");
    expect(call.error?.message).toMatch(/origin-mismatch/);
    expect(call.detail).toMatchObject({
      method: "POST",
      pathname: "/api/users/invite",
      origin: "https://evil.example.com",
      referer: null,
      remoteAddress: "203.0.113.42",
    });
  });

  it("uses null for missing origin/referer/remoteAddress", async () => {
    await logCsrfBlocked({
      reason: "missing-origin-and-referer",
      method: "DELETE",
      pathname: "/api/agents/abc",
      origin: undefined,
      referer: undefined,
      remoteAddress: undefined,
      client: { address: null, source: "unknown" },
    });

    const call = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(call.detail).toMatchObject({
      origin: null,
      referer: null,
      remoteAddress: null,
      clientAddress: null,
    });
  });

  // The reason #825 stayed invisible: every auth.csrf_blocked row on the
  // production instance recorded `::ffff:172.18.0.1`, the Docker bridge
  // gateway. `remoteAddress` was never wrong — it is the peer, and behind a
  // proxy the peer IS the proxy — it just answered a question nobody was
  // asking. So it keeps its meaning (older rows must not be reinterpreted)
  // and the client's own address arrives beside it.
  it("records the forwarded client address beside the proxy's own", async () => {
    await blocked({
      remoteAddress: "::ffff:172.18.0.1",
      client: { address: "203.0.113.42", source: "forwarded" },
    });

    const call = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(call.detail).toMatchObject({
      remoteAddress: "::ffff:172.18.0.1",
      clientAddress: "203.0.113.42",
      clientAddressSource: "forwarded",
    });
  });

  // Without the source marker the two identical addresses would read as "we
  // know this is the client" — the same silent constant, one field over.
  it("marks an address that is only the peer as such", async () => {
    await blocked({
      remoteAddress: "::ffff:172.18.0.1",
      client: { address: "172.18.0.1", source: "socket" },
    });

    const call = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(call.detail).toMatchObject({
      clientAddress: "172.18.0.1",
      clientAddressSource: "socket",
    });
  });

  it("does not throw when appendAuditLog rejects (best-effort logging)", async () => {
    vi.mocked(appendAuditLog).mockRejectedValueOnce(new Error("DB down"));

    await expect(blocked({ remoteAddress: "1.2.3.4" })).resolves.toBeUndefined();
  });

  // An anonymous caller can mint this row: a foreign Origin needs no
  // credential, and since #1056 it needs no state-changing method either —
  // the WebSocket upgrade is a GET and server.ts audits a rejected handshake
  // through this same function. Every row takes pg_advisory_xact_lock on one
  // constant key, so an unbounded stream serializes every genuine audit write
  // in the process behind itself.
  describe("flood window", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-04T10:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("writes one row per window no matter how many requests are blocked", async () => {
      for (let i = 0; i < 500; i++) await blocked();

      expect(appendAuditLog).toHaveBeenCalledTimes(1);
    });

    it("reports the volume it collapsed on the next window's row", async () => {
      // A bounded row that drops the scale of what it stood in for is worse
      // than no row: it reads like a single stray request.
      for (let i = 0; i < 10; i++) await blocked();

      vi.advanceTimersByTime(60_000);
      await blocked();

      expect(appendAuditLog).toHaveBeenCalledTimes(2);
      expect(vi.mocked(appendAuditLog).mock.calls[1][0].detail).toMatchObject({
        suppressedSinceLastEntry: 9,
      });
    });

    it("omits the count when nothing was suppressed", async () => {
      await blocked();

      expect(vi.mocked(appendAuditLog).mock.calls[0][0].detail).not.toHaveProperty(
        "suppressedSinceLastEntry"
      );
    });

    it("keeps the window global rather than keyed by anything the caller sends", async () => {
      // Origin, path and remote address are all attacker-supplied, so a map
      // keyed on one of them grows per request and the throttle stops
      // throttling. Varying every one of them must not buy a second row.
      await blocked({ origin: "https://a.example.com", pathname: "/api/one" });
      await blocked({
        origin: "https://b.example.com",
        pathname: "/api/two",
        remoteAddress: "198.51.100.7",
      });

      expect(appendAuditLog).toHaveBeenCalledTimes(1);
    });
  });
});
