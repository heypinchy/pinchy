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

  it("uses AA-contrast dark text on amber, not white (white-on-amber-500 is ~2.1:1)", async () => {
    vi.mocked(isInsecureMode).mockResolvedValue(true);
    const Component = await InsecureBanner({ isAdmin: true });
    render(Component);
    const banner = screen.getByRole("alert");
    expect(banner.className).not.toContain("text-white");
    expect(banner.className).toContain("text-amber-950");
  });

  it("exposes a stable data-testid so screenshot tooling can hide it", async () => {
    // The screenshot capture pipeline hides this banner via a CSS selector on
    // [data-testid="insecure-banner"]. Keep the hook stable so a refactor can't
    // silently re-expose the "not secured" warning in marketing screenshots.
    vi.mocked(isInsecureMode).mockResolvedValue(true);
    const Component = await InsecureBanner({ isAdmin: true });
    render(Component);
    expect(screen.getByRole("alert").getAttribute("data-testid")).toBe("insecure-banner");
  });

  it("should show 'contact administrator' for non-admins", async () => {
    vi.mocked(isInsecureMode).mockResolvedValue(true);
    const Component = await InsecureBanner({ isAdmin: false });
    render(Component);
    expect(screen.getByText(/contact your administrator/i)).toBeDefined();
    expect(screen.queryByText(/secure your instance/i)).toBeNull();
  });
});
