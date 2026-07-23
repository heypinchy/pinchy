import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/settings", () => ({
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      agents: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), eq: vi.fn() };
});

import {
  migrateAgentsOffDeletedProvider,
  capMigratedAgents,
  MAX_INLINE_MIGRATED,
} from "@/lib/provider-deletion";
import { setSetting } from "@/lib/settings";
import { db } from "@/db";

describe("migrateAgentsOffDeletedProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.query.agents.findMany).mockResolvedValue([]);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);
  });

  it("migrates only agents on the deleted prefix onto the first candidate's model", async () => {
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "a1", name: "One", model: "acme/big" },
      { id: "a2", name: "Two", model: "openai/gpt" },
      { id: "a3", name: "Three", model: "acme/small" },
    ] as any);
    const setSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update).mockReturnValue({ set: setSpy } as any);

    const result = await migrateAgentsOffDeletedProvider({
      deletedPrefix: "acme/",
      remainingCandidates: [
        { name: "openai", defaultModel: "openai/gpt-5.4-mini" },
        { name: "other", defaultModel: "other/x" },
      ],
      wasDefault: false,
    });

    expect(db.update).toHaveBeenCalledTimes(2);
    expect(setSpy).toHaveBeenCalledWith({ model: "openai/gpt-5.4-mini" });
    expect(result.migratedAgents).toEqual([
      { id: "a1", name: "One", fromModel: "acme/big", toModel: "openai/gpt-5.4-mini" },
      { id: "a3", name: "Three", fromModel: "acme/small", toModel: "openai/gpt-5.4-mini" },
    ]);
    expect(result.newDefault).toBeUndefined();
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("reassigns default_provider to the first candidate when wasDefault", async () => {
    const result = await migrateAgentsOffDeletedProvider({
      deletedPrefix: "acme/",
      remainingCandidates: [{ name: "openai", defaultModel: "openai/gpt-5.4-mini" }],
      wasDefault: true,
    });

    expect(setSetting).toHaveBeenCalledWith("default_provider", "openai", false);
    expect(result.newDefault).toBe("openai");
  });

  it("does nothing when there is no remaining candidate", async () => {
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "a1", name: "One", model: "acme/big" },
    ] as any);

    const result = await migrateAgentsOffDeletedProvider({
      deletedPrefix: "acme/",
      remainingCandidates: [],
      wasDefault: true,
    });

    expect(db.query.agents.findMany).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(setSetting).not.toHaveBeenCalled();
    expect(result).toEqual({ migratedAgents: [], newDefault: undefined });
  });
});

describe("capMigratedAgents", () => {
  it("passes a short list through untruncated", () => {
    const list = Array.from({ length: 3 }, (_, i) => ({ id: `a${i}` }));
    const { inlineMigrated, truncated } = capMigratedAgents(list);
    expect(truncated).toBe(false);
    expect(inlineMigrated).toHaveLength(3);
  });

  it("caps at MAX_INLINE_MIGRATED and flags truncation", () => {
    const list = Array.from({ length: MAX_INLINE_MIGRATED + 5 }, (_, i) => ({ id: `a${i}` }));
    const { inlineMigrated, truncated } = capMigratedAgents(list);
    expect(truncated).toBe(true);
    expect(inlineMigrated).toHaveLength(MAX_INLINE_MIGRATED);
  });
});
