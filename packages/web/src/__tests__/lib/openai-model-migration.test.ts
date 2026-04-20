import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db", () => {
  const returning = vi.fn().mockResolvedValue([]);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  const mockWhere = vi.fn().mockResolvedValue([]);
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  const select = vi.fn().mockReturnValue({ from: mockFrom });
  return { db: { select, update } };
});

vi.mock("@/db/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/schema")>();
  return { ...actual };
});

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { db } from "@/db";
import { agents } from "@/db/schema";
import { appendAuditLog } from "@/lib/audit";
import { migrateAgentsToCodex, migrateAgentsToApiKey } from "@/lib/openai-model-migration";

function mockSelectChain(resolvedValue: unknown) {
  const mockWhere = vi.fn().mockResolvedValue(resolvedValue);
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  vi.mocked(db.select).mockReturnValueOnce({ from: mockFrom } as never);
}

function mockUpdateChain(resolvedValue: unknown[]) {
  const returning = vi.fn().mockResolvedValue(resolvedValue);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  vi.mocked(db.update).mockReturnValueOnce({ set } as never);
}

describe("migrateAgentsToCodex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("migrates a mapped openai/ agent to openai-codex/", async () => {
    mockSelectChain([{ id: "a1", name: "GPT Agent", model: "openai/gpt-4o" }]);
    mockUpdateChain([{ id: "a1", name: "GPT Agent", model: "openai-codex/gpt-4o" }]);

    const result = await migrateAgentsToCodex();

    expect(result).toEqual([
      { id: "a1", name: "GPT Agent", from: "openai/gpt-4o", to: "openai-codex/gpt-4o" },
    ]);
  });

  it("falls back to openai-codex/gpt-4o-mini for unmapped openai/ agent", async () => {
    mockSelectChain([{ id: "a2", name: "Custom Agent", model: "openai/some-unknown-model" }]);
    mockUpdateChain([{ id: "a2", name: "Custom Agent", model: "openai-codex/gpt-4o-mini" }]);

    const result = await migrateAgentsToCodex();

    expect(result).toEqual([
      {
        id: "a2",
        name: "Custom Agent",
        from: "openai/some-unknown-model",
        to: "openai-codex/gpt-4o-mini",
      },
    ]);
  });

  it("does not touch non-openai agents", async () => {
    mockSelectChain([
      { id: "a1", name: "GPT Agent", model: "openai/gpt-4o" },
      { id: "a3", name: "Claude Agent", model: "anthropic/claude-3-haiku" },
    ]);
    mockUpdateChain([{ id: "a1", name: "GPT Agent", model: "openai-codex/gpt-4o" }]);

    const result = await migrateAgentsToCodex();

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a1");
  });

  it("returns correct MigratedAgent shape", async () => {
    mockSelectChain([{ id: "a1", name: "GPT Agent", model: "openai/gpt-4o-mini" }]);
    mockUpdateChain([{ id: "a1", name: "GPT Agent", model: "openai-codex/gpt-4o-mini" }]);

    const result = await migrateAgentsToCodex();

    expect(result[0]).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      from: expect.any(String),
      to: expect.any(String),
    });
  });

  it("emits audit log per migrated agent with correct detail", async () => {
    mockSelectChain([{ id: "a1", name: "GPT Agent", model: "openai/gpt-4o" }]);
    mockUpdateChain([{ id: "a1", name: "GPT Agent", model: "openai-codex/gpt-4o" }]);

    await migrateAgentsToCodex();

    expect(appendAuditLog).toHaveBeenCalledWith({
      eventType: "agent.updated",
      actorType: "system",
      actorId: "system",
      resource: "a1",
      outcome: "success",
      detail: {
        changes: {
          model: { from: "openai/gpt-4o", to: "openai-codex/gpt-4o" },
        },
        reason: "auth_method_switch",
      },
    });
  });
});

describe("migrateAgentsToApiKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("migrates a mapped openai-codex/ agent to openai/", async () => {
    mockSelectChain([{ id: "a1", name: "Codex Agent", model: "openai-codex/gpt-4o" }]);
    mockUpdateChain([{ id: "a1", name: "Codex Agent", model: "openai/gpt-4o" }]);

    const result = await migrateAgentsToApiKey();

    expect(result).toEqual([
      { id: "a1", name: "Codex Agent", from: "openai-codex/gpt-4o", to: "openai/gpt-4o" },
    ]);
  });

  it("falls back to openai/gpt-4o-mini for unmapped openai-codex/ agent", async () => {
    mockSelectChain([{ id: "a2", name: "Custom Agent", model: "openai-codex/some-unknown-model" }]);
    mockUpdateChain([{ id: "a2", name: "Custom Agent", model: "openai/gpt-4o-mini" }]);

    const result = await migrateAgentsToApiKey();

    expect(result).toEqual([
      {
        id: "a2",
        name: "Custom Agent",
        from: "openai-codex/some-unknown-model",
        to: "openai/gpt-4o-mini",
      },
    ]);
  });
});
