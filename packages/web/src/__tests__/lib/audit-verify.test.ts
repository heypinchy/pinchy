import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockOrderBy, mockWhere, mockFrom, mockSelect, mockInsert, mockValues } = vi.hoisted(() => {
  const mockOrderBy = vi.fn();
  const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
  const mockValues = vi.fn();
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
  return { mockOrderBy, mockWhere, mockFrom, mockSelect, mockInsert, mockValues };
});

vi.mock("@/lib/encryption", () => ({
  getOrCreateSecret: vi.fn(() => Buffer.from("a".repeat(64), "hex")),
}));

vi.mock("@/db", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
  },
}));

import { computeRowHmacV1, computeRowHmacV2, verifyIntegrity } from "@/lib/audit";

const secret = Buffer.from("a".repeat(64), "hex");

function makeEntry(id: number, overrides?: { tampered?: boolean }) {
  const fields = {
    timestamp: new Date("2026-02-21T10:00:00Z"),
    eventType: "agent.created",
    actorType: "user" as const,
    actorId: `user-${id}`,
    resource: `agent:abc-${id}`,
    detail: { name: "Smithers" },
  };

  const rowHmac = overrides?.tampered
    ? "0000000000000000000000000000000000000000000000000000000000000000"
    : computeRowHmacV1(secret, fields);

  return { id, version: 1, outcome: null, error: null, ...fields, rowHmac };
}

function makeV2Entry(id: number, opts?: { tamperOutcome?: boolean; version?: number }) {
  const fields = {
    timestamp: new Date("2026-02-21T10:00:00Z"),
    eventType: "tool.web_search",
    actorType: "user" as const,
    actorId: `user-${id}`,
    resource: `agent:abc-${id}`,
    detail: { toolName: "web_search" },
    outcome: "failure" as "success" | "failure",
    error: { message: "Brave API key missing" } as { message: string } | null,
  };

  const rowHmac = computeRowHmacV2(secret, fields);

  // Simulate tampering: stored outcome was flipped from "failure" to "success"
  // but the rowHmac was computed against "failure" — verifier recomputes with
  // the stored (tampered) outcome and mismatch follows.
  const storedOutcome = opts?.tamperOutcome ? "success" : fields.outcome;

  return {
    id,
    version: opts?.version ?? 2,
    ...fields,
    outcome: storedOutcome,
    rowHmac,
  };
}

describe("verifyIntegrity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish the chain after clearAllMocks
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
  });

  it("should return valid: true for entries with correct HMACs", async () => {
    const entries = [makeEntry(1), makeEntry(2), makeEntry(3)];
    mockOrderBy.mockResolvedValue(entries);

    const result = await verifyIntegrity();

    expect(result).toEqual({
      valid: true,
      totalChecked: 3,
      invalidIds: [],
    });
  });

  it("should return valid: false for tampered entries", async () => {
    const entries = [makeEntry(1), makeEntry(2, { tampered: true }), makeEntry(3)];
    mockOrderBy.mockResolvedValue(entries);

    const result = await verifyIntegrity();

    expect(result).toEqual({
      valid: false,
      totalChecked: 3,
      invalidIds: [2],
    });
  });

  it("should handle fromId and toId range parameters", async () => {
    const entries = [makeEntry(5), makeEntry(6)];
    mockOrderBy.mockResolvedValue(entries);

    const result = await verifyIntegrity(5, 6);

    expect(result).toEqual({
      valid: true,
      totalChecked: 2,
      invalidIds: [],
    });
    // Verify that where() was called (meaning conditions were applied)
    expect(mockWhere).toHaveBeenCalled();
  });

  it("should return valid: true with totalChecked: 0 for empty result set", async () => {
    mockOrderBy.mockResolvedValue([]);

    const result = await verifyIntegrity();

    expect(result).toEqual({
      valid: true,
      totalChecked: 0,
      invalidIds: [],
    });
  });

  it("verifies a v1 row hashed with v1 as valid", async () => {
    mockOrderBy.mockResolvedValue([makeEntry(1)]);
    const result = await verifyIntegrity();
    expect(result.valid).toBe(true);
    expect(result.invalidIds).toEqual([]);
  });

  it("verifies a v2 row hashed with v2 as valid", async () => {
    mockOrderBy.mockResolvedValue([makeV2Entry(1)]);
    const result = await verifyIntegrity();
    expect(result.valid).toBe(true);
    expect(result.invalidIds).toEqual([]);
  });

  it("flags a v2 row with tampered outcome as invalid", async () => {
    mockOrderBy.mockResolvedValue([makeV2Entry(7, { tamperOutcome: true })]);
    const result = await verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.invalidIds).toEqual([7]);
  });

  it("flags a row with an unknown version as invalid", async () => {
    mockOrderBy.mockResolvedValue([makeV2Entry(9, { version: 99 })]);
    const result = await verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.invalidIds).toEqual([9]);
  });

  it("should detect multiple tampered entries", async () => {
    const entries = [
      makeEntry(1, { tampered: true }),
      makeEntry(2),
      makeEntry(3, { tampered: true }),
    ];
    mockOrderBy.mockResolvedValue(entries);

    const result = await verifyIntegrity();

    expect(result).toEqual({
      valid: false,
      totalChecked: 3,
      invalidIds: [1, 3],
    });
  });
});
