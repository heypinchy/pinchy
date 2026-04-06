import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/domain", () => ({
  isInsecureMode: vi.fn(),
}));

import { InsecureBanner } from "@/components/insecure-banner";
import { isInsecureMode } from "@/lib/domain";

describe("InsecureBanner", () => {
  beforeEach(() => {
    vi.mocked(isInsecureMode).mockReset();
  });

  it("should render nothing when not in insecure mode", async () => {
    vi.mocked(isInsecureMode).mockResolvedValue(false);
    const Component = await InsecureBanner({ isAdmin: true });
    const { container } = render(Component);
    expect(container.innerHTML).toBe("");
  });

  it("should render warning banner when in insecure mode", async () => {
    vi.mocked(isInsecureMode).mockResolvedValue(true);
    const Component = await InsecureBanner({ isAdmin: true });
    render(Component);
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText(/not secured/i)).toBeDefined();
  });

  it("should show settings link for admins", async () => {
    vi.mocked(isInsecureMode).mockResolvedValue(true);
    const Component = await InsecureBanner({ isAdmin: true });
    render(Component);
    const link = screen.getByText(/secure your instance/i);
    expect(link.closest("a")?.getAttribute("href")).toBe("/settings?tab=security");
  });

  it("should show 'contact administrator' for non-admins", async () => {
    vi.mocked(isInsecureMode).mockResolvedValue(true);
    const Component = await InsecureBanner({ isAdmin: false });
    render(Component);
    expect(screen.getByText(/contact your administrator/i)).toBeDefined();
    expect(screen.queryByText(/secure your instance/i)).toBeNull();
  });
});
