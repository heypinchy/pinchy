import { describe, it, expect, vi, beforeEach } from "vitest";

class RedirectError extends Error {
  constructor(public url: string) {
    super(`NEXT_REDIRECT: ${url}`);
  }
}

const { mockRedirect, mockIsSetupComplete } = vi.hoisted(() => ({
  mockRedirect: vi.fn().mockImplementation((url: string) => {
    throw new RedirectError(url);
  }),
  mockIsSetupComplete: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

vi.mock("@/lib/setup", () => ({
  isSetupComplete: mockIsSetupComplete,
}));

import SetupLayout from "@/app/setup/layout";
import React from "react";

describe("Setup Layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should redirect to / when setup is already complete", async () => {
    mockIsSetupComplete.mockResolvedValue(true);

    const mockChildren = React.createElement("div", null, "Setup");

    await expect(SetupLayout({ children: mockChildren })).rejects.toThrow("NEXT_REDIRECT: /");

    expect(mockRedirect).toHaveBeenCalledWith("/");
  });

  it("should render children when setup is not complete", async () => {
    mockIsSetupComplete.mockResolvedValue(false);

    const mockChildren = React.createElement("div", null, "Setup Form");
    const result = await SetupLayout({ children: mockChildren });

    expect(result).toBeTruthy();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("should not redirect when admin user does not exist", async () => {
    mockIsSetupComplete.mockResolvedValue(false);

    const mockChildren = React.createElement("div", null, "Setup");
    await SetupLayout({ children: mockChildren });

    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
