import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Partial mock: only the write is stubbed. `safeAuditPath` stays real, so the
// capping assertion below tests the actual truncation rather than a stub.
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { logHostBlocked, shouldAuditHostBlock, resetHostBlockWindow } from "@/server/host-check";
import { appendAuditLog } from "@/lib/audit";

describe("shouldAuditHostBlock", () => {
  it("audits blocked API requests", () => {
    // The signal that was missing for eleven weeks (#599): a plugin's capture
    // POST was rejected by the domain lock, and the only trace was a warn line
    // inside the OpenClaw container that nobody reads.
    expect(shouldAuditHostBlock("/api/internal/channel-messages")).toBe(true);
    expect(shouldAuditHostBlock("/api/settings/domain")).toBe(true);
  });

  it("stays quiet for page requests", () => {
    // A locked instance answers every scanner that finds its raw IP. Those hit
    // pages, not the API, and the rejection page is its own signal — auditing
    // them would bury the row that matters under crawler noise.
    expect(shouldAuditHostBlock("/")).toBe(false);
    expect(shouldAuditHostBlock("/dashboard")).toBe(false);
    expect(shouldAuditHostBlock("/wp-admin/setup-config.php")).toBe(false);
    expect(shouldAuditHostBlock(null)).toBe(false);
  });
});

describe("logHostBlocked", () => {
  beforeEach(() => {
    vi.mocked(appendAuditLog).mockClear();
    resetHostBlockWindow();
  });

  it("appends an auth.host_blocked audit entry with the request context", async () => {
    await logHostBlocked({
      method: "POST",
      pathname: "/api/internal/channel-messages",
      host: "pinchy:7777",
      lockedDomain: "pinchy.example.com",
      remoteAddress: "172.18.0.4",
    });

    expect(appendAuditLog).toHaveBeenCalledTimes(1);
    const call = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(call.eventType).toBe("auth.host_blocked");
    expect(call.outcome).toBe("failure");
    expect(call.actorType).toBe("system");
    expect(call.actorId).toBe("system");
    expect(call.error?.message).toMatch(/pinchy:7777/);
    expect(call.detail).toMatchObject({
      method: "POST",
      pathname: "/api/internal/channel-messages",
      host: "pinchy:7777",
      lockedDomain: "pinchy.example.com",
      remoteAddress: "172.18.0.4",
    });
  });

  it("uses null for a missing host and remote address", async () => {
    await logHostBlocked({
      method: "GET",
      pathname: "/api/audit",
      host: undefined,
      lockedDomain: "pinchy.example.com",
      remoteAddress: undefined,
    });

    const call = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(call.detail).toMatchObject({ host: null, remoteAddress: null });
  });

  it("caps the caller-controlled path and host", async () => {
    // Both are sized by whoever sent the request. Left uncapped they push the
    // detail past MAX_DETAIL_BYTES, and truncateDetail then replaces the whole
    // object with a summary blob — losing the very fields that make the row
    // worth having.
    await logHostBlocked({
      method: "POST",
      pathname: "/api/" + "a".repeat(5000),
      host: "b".repeat(5000),
      lockedDomain: "pinchy.example.com",
      remoteAddress: "203.0.113.42",
    });

    const detail = vi.mocked(appendAuditLog).mock.calls[0][0].detail as Record<string, string>;
    expect(detail.pathname.length).toBeLessThanOrEqual(256);
    expect(detail.host.length).toBeLessThanOrEqual(256);
  });

  it("does not throw when appendAuditLog rejects (best-effort logging)", async () => {
    vi.mocked(appendAuditLog).mockRejectedValueOnce(new Error("DB down"));

    await expect(
      logHostBlocked({
        method: "POST",
        pathname: "/api/internal/channel-messages",
        host: "pinchy:7777",
        lockedDomain: "pinchy.example.com",
        remoteAddress: "172.18.0.4",
      })
    ).resolves.toBeUndefined();
  });
});

// Every audit row takes `pg_advisory_xact_lock` on one constant key, so audit
// writes are serialized instance-wide (lib/audit.ts). Without a bound, an
// anonymous `GET http://<raw-ip>/api/x` loop against a domain-locked install
// both grows the immutable table and stalls every genuine audit write behind
// the flood — and buries the one row this event exists to surface.
describe("logHostBlocked throttling", () => {
  const block = (host: string) =>
    logHostBlocked({
      method: "GET",
      pathname: "/api/anything",
      host,
      lockedDomain: "pinchy.example.com",
      remoteAddress: "203.0.113.42",
    });

  beforeEach(() => {
    vi.mocked(appendAuditLog).mockClear();
    resetHostBlockWindow();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes one row per window no matter how many requests are blocked", async () => {
    for (let i = 0; i < 500; i++) await block("evil.example.com");

    expect(appendAuditLog).toHaveBeenCalledTimes(1);
  });

  it("reports the volume it collapsed on the next window's row", async () => {
    // The count is the whole point: a bounded row that silently drops the
    // scale of what it stood in for is worse than no row, because it reads
    // like a single stray request.
    await block("evil.example.com");
    for (let i = 0; i < 9; i++) await block("evil.example.com");

    vi.advanceTimersByTime(60_000);
    await block("evil.example.com");

    expect(appendAuditLog).toHaveBeenCalledTimes(2);
    expect(vi.mocked(appendAuditLog).mock.calls[1][0].detail).toMatchObject({
      suppressedSinceLastEntry: 9,
    });
  });

  it("omits the count when nothing was suppressed", async () => {
    await block("evil.example.com");

    expect(vi.mocked(appendAuditLog).mock.calls[0][0].detail).not.toHaveProperty(
      "suppressedSinceLastEntry"
    );
  });

  it("keeps the window global rather than keyed by anything the caller sends", async () => {
    // A window keyed by host, path or remote address makes the key map itself
    // the flood target — attacker-supplied dimensions are unbounded, so the
    // Map grows per request and the throttle stops throttling. (`scopeDenialWindows`
    // in lib/api-auth.ts can key by API key only because an admin must mint one.)
    // The cost is deliberate: within a minute, one blocked component can mask
    // another. The first row still names a host and a path, and the count says
    // how much more there was.
    for (let i = 0; i < 100; i++) await block(`host-${i}.example.com`);

    expect(appendAuditLog).toHaveBeenCalledTimes(1);
  });
});
