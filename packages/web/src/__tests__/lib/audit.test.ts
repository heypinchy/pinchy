import { describe, it, expect } from "vitest";
import { computeRowHmac, truncateDetail } from "@/lib/audit";

describe("computeRowHmac", () => {
  const secret = Buffer.from("a".repeat(64), "hex");

  it("should return a 64-char hex string", () => {
    const hmac = computeRowHmac(secret, {
      timestamp: new Date("2026-02-21T10:00:00Z"),
      eventType: "agent.created",
      actorType: "user",
      actorId: "user-1",
      resource: "agent:abc",
      detail: { name: "Smithers" },
    });
    expect(hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should be deterministic — same input produces same HMAC", () => {
    const fields = {
      timestamp: new Date("2026-02-21T10:00:00Z"),
      eventType: "agent.created",
      actorType: "user" as const,
      actorId: "user-1",
      resource: "agent:abc",
      detail: { name: "Smithers" },
    };
    expect(computeRowHmac(secret, fields)).toBe(computeRowHmac(secret, fields));
  });

  it("should produce different HMAC for different input", () => {
    const base = {
      timestamp: new Date("2026-02-21T10:00:00Z"),
      eventType: "agent.created",
      actorType: "user" as const,
      actorId: "user-1",
      resource: "agent:abc",
      detail: { name: "Smithers" },
    };
    const hmac1 = computeRowHmac(secret, base);
    const hmac2 = computeRowHmac(secret, { ...base, actorId: "user-2" });
    expect(hmac1).not.toBe(hmac2);
  });

  it("should produce different HMAC for different secret", () => {
    const fields = {
      timestamp: new Date("2026-02-21T10:00:00Z"),
      eventType: "agent.created",
      actorType: "user" as const,
      actorId: "user-1",
      resource: null,
      detail: null,
    };
    const secret2 = Buffer.from("b".repeat(64), "hex");
    expect(computeRowHmac(secret, fields)).not.toBe(computeRowHmac(secret2, fields));
  });

  it("should produce the same HMAC regardless of detail key order (JSONB roundtrip)", () => {
    const base = {
      timestamp: new Date("2026-02-21T10:00:00Z"),
      eventType: "user.invited",
      actorType: "user" as const,
      actorId: "user-1",
      resource: null,
    };

    // Original JS insertion order
    const hmacOriginal = computeRowHmac(secret, {
      ...base,
      detail: { email: "test@example.com", role: "user" },
    });

    // After PostgreSQL JSONB roundtrip (keys sorted by length, then alphabetically)
    const hmacFromDb = computeRowHmac(secret, {
      ...base,
      detail: { role: "user", email: "test@example.com" },
    });

    expect(hmacOriginal).toBe(hmacFromDb);
  });

  it("should produce the same HMAC for nested objects with reordered keys", () => {
    const base = {
      timestamp: new Date("2026-02-21T10:00:00Z"),
      eventType: "tool.pinchy_ls" as const,
      actorType: "user" as const,
      actorId: "user-1",
      resource: "agent:abc",
    };

    // Original JS order: toolName, phase, source, params, result
    const hmacOriginal = computeRowHmac(secret, {
      ...base,
      detail: {
        toolName: "pinchy_ls",
        phase: "end",
        source: "openclaw_hook",
        params: { path: "/data" },
        result: { content: [{ text: "ok", type: "text" }] },
      },
    });

    // JSONB reordered: sorted by key length then alphabetically
    const hmacFromDb = computeRowHmac(secret, {
      ...base,
      detail: {
        phase: "end",
        params: { path: "/data" },
        result: { content: [{ type: "text", text: "ok" }] },
        source: "openclaw_hook",
        toolName: "pinchy_ls",
      },
    });

    expect(hmacOriginal).toBe(hmacFromDb);
  });

  it("should handle null resource and detail", () => {
    const hmac = computeRowHmac(secret, {
      timestamp: new Date("2026-02-21T10:00:00Z"),
      eventType: "auth.login",
      actorType: "user",
      actorId: "user-1",
      resource: null,
      detail: null,
    });
    expect(hmac).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("truncateDetail", () => {
  it("should return small objects unchanged", () => {
    const detail = { tool: "shell", success: true };
    expect(truncateDetail(detail)).toEqual(detail);
  });

  it("should return null for null input", () => {
    expect(truncateDetail(null)).toBeNull();
  });

  it("should truncate objects larger than 2KB", () => {
    const large = { data: "x".repeat(3000) };
    const result = truncateDetail(large);
    const serialized = JSON.stringify(result);
    expect(serialized.length).toBeLessThanOrEqual(2048);
  });

  it("should indicate truncation in the result", () => {
    const large = { data: "x".repeat(3000) };
    const result = truncateDetail(large) as Record<string, unknown>;
    expect(result._truncated).toBe(true);
  });
});
