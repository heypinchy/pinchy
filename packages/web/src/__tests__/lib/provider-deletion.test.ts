import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/settings", () => ({
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/provider-count", () => ({
  listConfiguredBuiltIns: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/openai-compatible-providers", () => ({
  listOpenAiCompatibleProviders: vi.fn().mockResolvedValue([]),
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
  buildRemainingCandidates,
  migrateAgentsOffDeletedProvider,
  repointAgentsOffRemovedModels,
  capMigratedAgents,
  MAX_INLINE_MIGRATED,
} from "@/lib/provider-deletion";
import { setSetting } from "@/lib/settings";
import { listConfiguredBuiltIns } from "@/lib/provider-count";
import { listOpenAiCompatibleProviders } from "@/lib/openai-compatible-providers";
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
        { name: "openai", label: "OpenAI", defaultModel: "openai/gpt-5.4-mini" },
        { name: "other", label: "Other", defaultModel: "other/x" },
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
      remainingCandidates: [
        { name: "openai", label: "OpenAI", defaultModel: "openai/gpt-5.4-mini" },
      ],
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

describe("buildRemainingCandidates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listConfiguredBuiltIns).mockResolvedValue([]);
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([]);
  });

  it("lists built-ins first, then custom instances namespaced <slug>/<models[0].id>", async () => {
    vi.mocked(listConfiguredBuiltIns).mockResolvedValue([
      { name: "anthropic", config: { name: "Anthropic", defaultModel: "anthropic/claude-haiku" } },
      { name: "openai", config: { name: "OpenAI", defaultModel: "openai/gpt-5.4-mini" } },
    ] as any);
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([
      {
        slug: "acme",
        displayName: "Acme LLM",
        models: [{ id: "acme-large" }, { id: "acme-small" }],
      },
    ] as any);

    const candidates = await buildRemainingCandidates();

    // `label` is what the removal dialog prints (#949) — carried here so the
    // display name comes from the same place the target itself does.
    expect(candidates).toEqual([
      { name: "anthropic", label: "Anthropic", defaultModel: "anthropic/claude-haiku" },
      { name: "openai", label: "OpenAI", defaultModel: "openai/gpt-5.4-mini" },
      // Custom instance uses the FIRST persisted model, namespaced by slug.
      { name: "acme", label: "Acme LLM", defaultModel: "acme/acme-large" },
    ]);
  });

  it("excludes the named built-in when excludeBuiltInName is set", async () => {
    vi.mocked(listConfiguredBuiltIns).mockResolvedValue([
      { name: "anthropic", config: { name: "Anthropic", defaultModel: "anthropic/claude-haiku" } },
      { name: "openai", config: { name: "OpenAI", defaultModel: "openai/gpt-5.4-mini" } },
    ] as any);

    const candidates = await buildRemainingCandidates({ excludeBuiltInName: "anthropic" });

    expect(candidates).toEqual([
      { name: "openai", label: "OpenAI", defaultModel: "openai/gpt-5.4-mini" },
    ]);
  });

  it("excludes no built-in when excludeBuiltInName is absent (custom-delete path)", async () => {
    vi.mocked(listConfiguredBuiltIns).mockResolvedValue([
      { name: "anthropic", config: { name: "Anthropic", defaultModel: "anthropic/claude-haiku" } },
    ] as any);
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([
      { slug: "acme", displayName: "Acme LLM", models: [{ id: "acme-large" }] },
    ] as any);

    const candidates = await buildRemainingCandidates();

    expect(candidates).toEqual([
      { name: "anthropic", label: "Anthropic", defaultModel: "anthropic/claude-haiku" },
      { name: "acme", label: "Acme LLM", defaultModel: "acme/acme-large" },
    ]);
  });
});

describe("repointAgentsOffRemovedModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.query.agents.findMany).mockResolvedValue([]);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);
  });

  it("repoints only agents on a REMOVED model of the slug onto the first kept model", async () => {
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "a1", name: "One", model: "acme/dropped" }, // removed → migrate
      { id: "a2", name: "Two", model: "acme/acme-large" }, // still present → keep
      { id: "a3", name: "Three", model: "openai/gpt" }, // other provider → ignore
      { id: "a4", name: "Four", model: "acme/also-dropped" }, // removed → migrate
    ] as any);
    const setSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update).mockReturnValue({ set: setSpy } as any);

    const migrated = await repointAgentsOffRemovedModels({
      slug: "acme",
      keptModelIds: ["acme-large", "acme-small"],
    });

    // Only the two agents on removed models are repointed, onto acme/acme-large.
    expect(db.update).toHaveBeenCalledTimes(2);
    expect(setSpy).toHaveBeenCalledWith({ model: "acme/acme-large" });
    expect(migrated).toEqual([
      { id: "a1", name: "One", fromModel: "acme/dropped", toModel: "acme/acme-large" },
      { id: "a4", name: "Four", fromModel: "acme/also-dropped", toModel: "acme/acme-large" },
    ]);
  });

  it("does not touch an agent whose pinned model is still present", async () => {
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "a1", name: "One", model: "acme/acme-large" },
    ] as any);

    const migrated = await repointAgentsOffRemovedModels({
      slug: "acme",
      keptModelIds: ["acme-large"],
    });

    expect(db.update).not.toHaveBeenCalled();
    expect(migrated).toEqual([]);
  });

  it("returns [] without querying when the kept-model set is empty (defensive)", async () => {
    const migrated = await repointAgentsOffRemovedModels({ slug: "acme", keptModelIds: [] });
    expect(db.query.agents.findMany).not.toHaveBeenCalled();
    expect(migrated).toEqual([]);
  });

  it("does not match a different slug that shares a prefix substring", async () => {
    // `acme-2/x` must not be treated as belonging to `acme` (prefix is `acme/`).
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "a1", name: "One", model: "acme-2/x" },
    ] as any);

    const migrated = await repointAgentsOffRemovedModels({
      slug: "acme",
      keptModelIds: ["acme-large"],
    });

    expect(db.update).not.toHaveBeenCalled();
    expect(migrated).toEqual([]);
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
