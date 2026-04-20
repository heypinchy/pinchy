import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock("@/db/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/schema")>();
  return { ...actual };
});

import { db } from "@/db";
import { agents } from "@/db/schema";
import { getAgentsUsingOpenAiProvider } from "@/lib/agents";

function mockSelectChain(resolvedValue: unknown) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(resolvedValue),
    }),
  } as never);
}

describe("getAgentsUsingOpenAiProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns agents whose model starts with openai/ or openai-codex/", async () => {
    mockSelectChain([
      { id: "a1", name: "GPT Agent" },
      { id: "a2", name: "Codex Agent" },
    ]);

    const result = await getAgentsUsingOpenAiProvider();

    expect(result).toEqual([
      { id: "a1", name: "GPT Agent" },
      { id: "a2", name: "Codex Agent" },
    ]);
  });

  it("returns empty array when no agents use OpenAI provider", async () => {
    mockSelectChain([]);

    const result = await getAgentsUsingOpenAiProvider();

    expect(result).toEqual([]);
  });

  it("selects only id and name columns", async () => {
    const mockWhere = vi.fn().mockResolvedValue([]);
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    vi.mocked(db.select).mockReturnValueOnce({ from: mockFrom } as never);

    await getAgentsUsingOpenAiProvider();

    expect(db.select).toHaveBeenCalledWith({
      id: expect.anything(),
      name: expect.anything(),
    });
  });

  it("queries from the agents table", async () => {
    const mockWhere = vi.fn().mockResolvedValue([]);
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    vi.mocked(db.select).mockReturnValueOnce({ from: mockFrom } as never);

    await getAgentsUsingOpenAiProvider();

    expect(mockFrom).toHaveBeenCalledWith(agents);
  });
});
