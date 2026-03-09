import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/setup", () => ({
  isSetupComplete: vi.fn(),
  isProviderConfigured: vi.fn(),
}));

vi.mock("@/lib/require-auth", () => ({
  requireAuth: vi.fn(),
}));

const mockHeadersGet = vi.fn();
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue({
    get: (...args: unknown[]) => mockHeadersGet(...args),
  }),
}));

const mockDbSelect = vi.fn();
vi.mock("@/db", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
}));

vi.mock("@/db/schema", () => ({
  agents: "agents-table",
  activeAgents: "active-agents-view",
}));

import { isSetupComplete, isProviderConfigured } from "@/lib/setup";
import { requireAuth } from "@/lib/require-auth";
import Home from "@/app/page";

const mockIsSetupComplete = isSetupComplete as ReturnType<typeof vi.fn>;
const mockIsProviderConfigured = isProviderConfigured as ReturnType<typeof vi.fn>;
const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;

function setupAgentsQuery(agents: Array<{ id: string }>) {
  const limitMock = vi.fn().mockResolvedValue(agents);
  const fromMock = vi.fn().mockReturnValue({ limit: limitMock });
  mockDbSelect.mockReturnValue({ from: fromMock });
}

describe("Home page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSetupComplete.mockResolvedValue(true);
    mockIsProviderConfigured.mockResolvedValue(true);
    mockRequireAuth.mockResolvedValue({
      user: { id: "user-1", role: "member" },
    });
    mockHeadersGet.mockReturnValue(null);
    setupAgentsQuery([{ id: "agent-1" }]);
  });

  it("redirects to /setup when setup is incomplete", async () => {
    mockIsSetupComplete.mockResolvedValue(false);

    await expect(Home()).rejects.toThrow("REDIRECT:/setup");
  });

  it("redirects to /setup/provider when provider is not configured", async () => {
    mockIsProviderConfigured.mockResolvedValue(false);

    await expect(Home()).rejects.toThrow("REDIRECT:/setup/provider");
  });

  it("redirects to first agent chat on desktop", async () => {
    mockHeadersGet.mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    );

    await expect(Home()).rejects.toThrow("REDIRECT:/chat/agent-1");
  });

  it("redirects to /agents on mobile", async () => {
    mockHeadersGet.mockReturnValue(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
    );

    await expect(Home()).rejects.toThrow("REDIRECT:/agents");
  });

  it("redirects to /agents when no agents exist", async () => {
    setupAgentsQuery([]);

    await expect(Home()).rejects.toThrow("REDIRECT:/agents");
  });

  it("redirects to first agent chat when user-agent header is missing (desktop fallback)", async () => {
    mockHeadersGet.mockReturnValue(null);

    await expect(Home()).rejects.toThrow("REDIRECT:/chat/agent-1");
  });
});
