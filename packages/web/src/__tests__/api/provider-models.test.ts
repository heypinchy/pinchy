import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => {
  const mockGetSession = vi.fn().mockResolvedValue({ user: { id: "1", email: "admin@test.com" } });
  return {
    getSession: mockGetSession,
    auth: {
      api: {
        getSession: mockGetSession,
      },
    },
  };
});

vi.mock("@/lib/provider-models", () => ({
  fetchProviderModels: vi.fn().mockResolvedValue([]),
}));

import { GET } from "@/app/api/providers/models/route";
import { auth } from "@/lib/auth";
import { fetchProviderModels } from "@/lib/provider-models";

describe("GET /api/providers/models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue({
      user: { id: "1", email: "admin@test.com" },
      expires: "",
    });
    vi.mocked(fetchProviderModels).mockResolvedValue([]);
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const response = await GET();

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("returns providers from fetchProviderModels", async () => {
    vi.mocked(fetchProviderModels).mockResolvedValue([
      {
        id: "anthropic",
        name: "Anthropic",
        models: [{ id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6" }],
      },
    ]);

    const response = await GET();

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      providers: [
        {
          id: "anthropic",
          name: "Anthropic",
          models: [{ id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6" }],
        },
      ],
    });
  });
});
