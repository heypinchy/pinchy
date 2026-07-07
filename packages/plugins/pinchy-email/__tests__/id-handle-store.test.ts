// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  putHandle,
  resolveHandle,
  handleFor,
  MSG_PREFIX,
  ATT_PREFIX,
} from "../id-handle-store";

describe("handleFor", () => {
  it("is deterministic: same realId + prefix always produces the same handle", () => {
    const realId = "AAMkAGI2THVLUAAA=really-long-graph-id-blob-1234567890";
    const a = handleFor(realId, MSG_PREFIX);
    const b = handleFor(realId, MSG_PREFIX);
    expect(a).toBe(b);
  });

  it("produces different handles for different realIds", () => {
    const a = handleFor("real-id-one", MSG_PREFIX);
    const b = handleFor("real-id-two", MSG_PREFIX);
    expect(a).not.toBe(b);
  });

  it("prefixes the handle with the caller-chosen prefix", () => {
    const msgHandle = handleFor("some-id", MSG_PREFIX);
    const attHandle = handleFor("some-id", ATT_PREFIX);
    expect(msgHandle.startsWith(`${MSG_PREFIX}_`)).toBe(true);
    expect(attHandle.startsWith(`${ATT_PREFIX}_`)).toBe(true);
    // Same realId, different prefix => different handle namespace
    expect(msgHandle).not.toBe(attHandle);
  });

  it("produces a short handle, much shorter than a typical Graph id", () => {
    const graphLikeId =
      "AAMkAGI2AAAAAAA-".repeat(10) + "some-more-base64-padding==";
    const handle = handleFor(graphLikeId, MSG_PREFIX);
    expect(handle.length).toBeLessThan(30);
  });

  // Finding 2 (2026-07-07 review): with only 32 bits of entropy two distinct
  // realIds could collide within an agent's cap and silently overwrite each
  // other, so a handle would resolve to the WRONG email. The handle carries 64
  // bits (16 hex chars) so that a collision is genuinely negligible, not merely
  // unlikely. This guards against silently shrinking the entropy back.
  it("carries 64 bits (16 hex chars) of the realId digest", () => {
    const hex = handleFor("some-real-id", MSG_PREFIX).slice(
      `${MSG_PREFIX}_`.length,
    );
    expect(hex).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("putHandle / resolveHandle", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("putHandle returns a handle that resolveHandle can turn back into the realId for the same agent", () => {
    const realId = "real-message-id-abc";
    const handle = putHandle("agent-1", realId);
    expect(resolveHandle("agent-1", handle)).toBe(realId);
  });

  it("is idempotent: putting the same realId twice returns the same handle", () => {
    const realId = "real-message-id-xyz";
    const first = putHandle("agent-2", realId);
    const second = putHandle("agent-2", realId);
    expect(first).toBe(second);
  });

  it("enforces tenant isolation: agent B cannot resolve agent A's handle", () => {
    const realId = "tenant-isolated-real-id";
    const handle = putHandle("agent-a", realId);
    expect(resolveHandle("agent-a", handle)).toBe(realId);
    expect(resolveHandle("agent-b", handle)).toBeNull();
  });

  it("returns null for an unknown handle", () => {
    expect(resolveHandle("agent-1", "msg_doesnotexist")).toBeNull();
  });

  it("returns null after the handle has expired (TTL)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const realId = "expiring-real-id";
      const handle = putHandle("agent-ttl", realId);
      expect(resolveHandle("agent-ttl", handle)).toBe(realId);

      // Advance past the 30-minute TTL.
      vi.setSystemTime(31 * 60 * 1000);
      expect(resolveHandle("agent-ttl", handle)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes expiry when the same realId is put again (idempotent refresh)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const realId = "refreshed-real-id";
      const handle = putHandle("agent-refresh", realId);

      // Advance close to expiry, then refresh.
      vi.setSystemTime(25 * 60 * 1000);
      const refreshed = putHandle("agent-refresh", realId);
      expect(refreshed).toBe(handle);

      // Advance to a point that would have expired the ORIGINAL ttl window
      // (0 + 30min = 30min) but is still within the REFRESHED window
      // (25min + 30min = 55min).
      vi.setSystemTime(40 * 60 * 1000);
      expect(resolveHandle("agent-refresh", handle)).toBe(realId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps entries per agent (bounded store, oldest evicted on overflow)", () => {
    const agentId = "agent-cap";
    const handles: string[] = [];
    // Push well past the 500-entry cap.
    for (let i = 0; i < 600; i++) {
      handles.push(putHandle(agentId, `real-id-${i}`));
    }

    // The earliest entries should have been evicted; the most recent must
    // still resolve.
    const lastHandle = handles[handles.length - 1];
    expect(resolveHandle(agentId, lastHandle)).toBe("real-id-599");

    const firstHandle = handles[0];
    expect(resolveHandle(agentId, firstHandle)).toBeNull();
  });

  it("does not leak handles across different realIds resolving to the wrong id", () => {
    const agentId = "agent-multi";
    const h1 = putHandle(agentId, "real-1");
    const h2 = putHandle(agentId, "real-2");
    expect(resolveHandle(agentId, h1)).toBe("real-1");
    expect(resolveHandle(agentId, h2)).toBe("real-2");
  });
});
