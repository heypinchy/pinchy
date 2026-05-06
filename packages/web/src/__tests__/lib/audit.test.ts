import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "crypto";
import {
  computeRowHmacV1,
  computeRowHmacV2,
  ROW_HMAC_VERIFIERS,
  truncateDetail,
  redactEmail,
} from "@/lib/audit";

describe("computeRowHmac", () => {
  const secret = Buffer.from("a".repeat(64), "hex");

  it("should return a 64-char hex string", () => {
    const hmac = computeRowHmacV1(secret, {
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
    expect(computeRowHmacV1(secret, fields)).toBe(computeRowHmacV1(secret, fields));
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
    const hmac1 = computeRowHmacV1(secret, base);
    const hmac2 = computeRowHmacV1(secret, { ...base, actorId: "user-2" });
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
    expect(computeRowHmacV1(secret, fields)).not.toBe(computeRowHmacV1(secret2, fields));
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
    const hmacOriginal = computeRowHmacV1(secret, {
      ...base,
      detail: { email: "test@example.com", role: "member" },
    });

    // After PostgreSQL JSONB roundtrip (keys sorted by length, then alphabetically)
    const hmacFromDb = computeRowHmacV1(secret, {
      ...base,
      detail: { role: "member", email: "test@example.com" },
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
    const hmacOriginal = computeRowHmacV1(secret, {
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
    const hmacFromDb = computeRowHmacV1(secret, {
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
    const hmac = computeRowHmacV1(secret, {
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

describe("computeRowHmac version dispatch", () => {
  const secret = Buffer.from("a".repeat(64), "hex");
  const baseFields = {
    timestamp: new Date("2026-01-01T00:00:00Z"),
    eventType: "tool.web_search",
    actorType: "user",
    actorId: "user-1",
    resource: "agent:abc",
    detail: { toolName: "web_search" },
  };

  it("v1 hash is stable and does not include version/outcome/error", () => {
    const hash = computeRowHmacV1(secret, baseFields);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toEqual(computeRowHmacV1(secret, baseFields));
  });

  it("v1 hash matches the known-good regression fixture", () => {
    // Captured 2026-04-07. NEVER change without reading VERSIONING.md.
    const fixture = computeRowHmacV1(secret, baseFields);
    expect(fixture).toEqual("bd87553fb579d4d219e901303ea9a2908b9dc641db799ab20cae7693bf53233f");
  });

  it("v2 hash matches the known-good regression fixture", () => {
    // Captured 2026-04-07. NEVER change without reading VERSIONING.md.
    const fixture = computeRowHmacV2(secret, { ...baseFields, outcome: "success", error: null });
    expect(fixture).toEqual("793d4cfb759f62f8e09b8fe40bd18fa6fdad40ebe3f37d3cbb2052e54ee36b98");
  });

  it("ROW_HMAC_VERIFIERS[1] matches computeRowHmacV1 directly", () => {
    expect(ROW_HMAC_VERIFIERS[1](secret, baseFields)).toEqual(computeRowHmacV1(secret, baseFields));
  });

  it("ROW_HMAC_VERIFIERS[2] matches computeRowHmacV2 directly", () => {
    const v2Fields = { ...baseFields, outcome: "success" as const, error: null };
    expect(ROW_HMAC_VERIFIERS[2](secret, v2Fields)).toEqual(computeRowHmacV2(secret, v2Fields));
  });

  it("ROW_HMAC_VERIFIERS returns undefined for unknown versions (verifier callers must handle this)", () => {
    expect(ROW_HMAC_VERIFIERS[99]).toBeUndefined();
  });

  it("v2 hash differs from v1 given identical base fields", () => {
    const v1 = computeRowHmacV1(secret, baseFields);
    const v2 = computeRowHmacV2(secret, { ...baseFields, outcome: "success", error: null });
    expect(v2).not.toEqual(v1);
  });

  it("v2 hash differs when outcome changes", () => {
    const success = computeRowHmacV2(secret, { ...baseFields, outcome: "success", error: null });
    const failure = computeRowHmacV2(secret, {
      ...baseFields,
      outcome: "failure",
      error: { message: "boom" },
    });
    expect(success).not.toEqual(failure);
  });

  it("v2 hash differs when error message changes", () => {
    const a = computeRowHmacV2(secret, {
      ...baseFields,
      outcome: "failure",
      error: { message: "boom" },
    });
    const b = computeRowHmacV2(secret, {
      ...baseFields,
      outcome: "failure",
      error: { message: "kaboom" },
    });
    expect(a).not.toEqual(b);
  });
});

describe("truncateDetail", () => {
  it("should return small objects unchanged", () => {
    const detail = { tool: "odoo_read", success: true };
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

describe("redactEmail", () => {
  const SECRET_HEX = "f".repeat(64);
  const expectedHash = (email: string) =>
    createHmac("sha256", Buffer.from(SECRET_HEX, "hex"))
      .update(email.trim().toLowerCase())
      .digest("hex");

  beforeEach(() => {
    vi.stubEnv("AUDIT_HMAC_SECRET", SECRET_HEX);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns emailHash and emailPreview, but never the raw email", () => {
    const result = redactEmail("clemens.helm@devcraft.academy");
    expect(result).toEqual({
      emailHash: expectedHash("clemens.helm@devcraft.academy"),
      emailPreview: "cl…lm@devcraft.academy",
    });
    expect(JSON.stringify(result)).not.toContain("clemens.helm@devcraft.academy");
  });

  it("normalises email to lowercase + trimmed before hashing (so case variations collide)", () => {
    const a = redactEmail("Foo.Bar@Example.com");
    const b = redactEmail("  foo.bar@example.com  ");
    expect(a.emailHash).toBe(b.emailHash);
    expect(a.emailHash).toBe(expectedHash("foo.bar@example.com"));
  });

  it("produces different hashes for different emails", () => {
    const a = redactEmail("alice@example.com");
    const b = redactEmail("bob@example.com");
    expect(a.emailHash).not.toBe(b.emailHash);
  });

  it("preview format uses first-2 + ellipsis + last-2 of local part for long locals", () => {
    expect(redactEmail("clemens.helm@devcraft.academy").emailPreview).toBe(
      "cl…lm@devcraft.academy"
    );
    expect(redactEmail("alexander@x.io").emailPreview).toBe("al…er@x.io");
  });

  it("preview keeps short local parts intact (no ellipsis below 5 chars)", () => {
    // Truncating "ab@x.com" to "ab…ab" reveals nothing — leave it as-is.
    expect(redactEmail("ab@x.com").emailPreview).toBe("ab@x.com");
    expect(redactEmail("john@test.io").emailPreview).toBe("john@test.io");
  });

  it("handles invalid email shape (no @) without throwing", () => {
    const result = redactEmail("unknown");
    expect(result.emailHash).toBe(expectedHash("unknown"));
    expect(result.emailPreview).toBe("unknown");
  });

  it("preview uses lowercased domain (mirrors hashing input)", () => {
    expect(redactEmail("Alice@EXAMPLE.com").emailPreview).toBe("al…ce@example.com");
  });
});
