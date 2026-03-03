import { describe, it, expect, vi, beforeEach } from "vitest";

class RedirectError extends Error {
  constructor(public url: string) {
    super(`NEXT_REDIRECT: ${url}`);
  }
}

const { mockRedirect, mockIsProviderConfigured } = vi.hoisted(() => ({
  mockRedirect: vi.fn().mockImplementation((url: string) => {
    throw new RedirectError(url);
  }),
  mockIsProviderConfigured: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

vi.mock("@/lib/setup", () => ({
  isProviderConfigured: mockIsProviderConfigured,
}));

import SetupProviderLayout from "@/app/setup/provider/layout";
import React from "react";

describe("Setup Provider Layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should redirect to / when provider is already configured", async () => {
    mockIsProviderConfigured.mockResolvedValue(true);

    const mockChildren = React.createElement("div", null, "Provider Setup");

    await expect(SetupProviderLayout({ children: mockChildren })).rejects.toThrow(
      "NEXT_REDIRECT: /"
    );

    expect(mockRedirect).toHaveBeenCalledWith("/");
  });

  it("should render children when provider is not configured", async () => {
    mockIsProviderConfigured.mockResolvedValue(false);

    const mockChildren = React.createElement("div", null, "Provider Form");
    const result = await SetupProviderLayout({ children: mockChildren });

    expect(result).toBeTruthy();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("should not redirect when provider is not set up yet", async () => {
    mockIsProviderConfigured.mockResolvedValue(false);

    const mockChildren = React.createElement("div", null, "Setup");
    await SetupProviderLayout({ children: mockChildren });

    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
