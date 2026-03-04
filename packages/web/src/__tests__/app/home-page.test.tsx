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

import { isSetupComplete, isProviderConfigured } from "@/lib/setup";
import { requireAuth } from "@/lib/require-auth";
import Home from "@/app/page";

const mockIsSetupComplete = isSetupComplete as ReturnType<typeof vi.fn>;
const mockIsProviderConfigured = isProviderConfigured as ReturnType<typeof vi.fn>;
const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;

describe("Home page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSetupComplete.mockResolvedValue(true);
    mockIsProviderConfigured.mockResolvedValue(true);
    mockRequireAuth.mockResolvedValue({
      user: { id: "user-1", role: "user" },
    });
  });

  it("redirects to /setup when setup is incomplete", async () => {
    mockIsSetupComplete.mockResolvedValue(false);

    await expect(Home()).rejects.toThrow("REDIRECT:/setup");
  });

  it("redirects to /setup/provider when provider is not configured", async () => {
    mockIsProviderConfigured.mockResolvedValue(false);

    await expect(Home()).rejects.toThrow("REDIRECT:/setup/provider");
  });

  it("redirects to /agents when setup and provider are configured", async () => {
    await expect(Home()).rejects.toThrow("REDIRECT:/agents");
  });
});
