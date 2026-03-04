import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BottomTabBar } from "@/components/bottom-tab-bar";

describe("BottomTabBar", () => {
  it("should render a nav element with role navigation", () => {
    render(<BottomTabBar currentPath="/agents" isAdmin={false} />);
    expect(screen.getByRole("navigation")).toBeInTheDocument();
  });

  it("should render Agents and Settings tabs for non-admin users", () => {
    render(<BottomTabBar currentPath="/agents" isAdmin={false} />);
    expect(screen.getByRole("link", { name: /agents/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
  });

  it("should NOT render Audit tab for non-admin users", () => {
    render(<BottomTabBar currentPath="/agents" isAdmin={false} />);
    expect(screen.queryByRole("link", { name: /audit/i })).not.toBeInTheDocument();
  });

  it("should render Audit tab for admin users", () => {
    render(<BottomTabBar currentPath="/agents" isAdmin={true} />);
    expect(screen.getByRole("link", { name: /audit/i })).toBeInTheDocument();
  });

  it("should render 3 tabs for admin users", () => {
    render(<BottomTabBar currentPath="/agents" isAdmin={true} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(3);
  });

  it("should render 2 tabs for non-admin users", () => {
    render(<BottomTabBar currentPath="/agents" isAdmin={false} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
  });

  describe("tab hrefs", () => {
    it("should link Agents tab to /agents", () => {
      render(<BottomTabBar currentPath="/agents" isAdmin={false} />);
      expect(screen.getByRole("link", { name: /agents/i })).toHaveAttribute("href", "/agents");
    });

    it("should link Settings tab to /settings", () => {
      render(<BottomTabBar currentPath="/agents" isAdmin={false} />);
      expect(screen.getByRole("link", { name: /settings/i })).toHaveAttribute("href", "/settings");
    });

    it("should link Audit tab to /audit", () => {
      render(<BottomTabBar currentPath="/agents" isAdmin={true} />);
      expect(screen.getByRole("link", { name: /audit/i })).toHaveAttribute("href", "/audit");
    });
  });

  describe("active tab highlighting", () => {
    it("should highlight Agents tab when path is /agents", () => {
      render(<BottomTabBar currentPath="/agents" isAdmin={false} />);
      const agentsLink = screen.getByRole("link", { name: /agents/i });
      expect(agentsLink.className).toContain("text-foreground");
      expect(agentsLink.className).not.toContain("text-muted-foreground");
    });

    it("should highlight Agents tab when path is /", () => {
      render(<BottomTabBar currentPath="/" isAdmin={false} />);
      const agentsLink = screen.getByRole("link", { name: /agents/i });
      expect(agentsLink.className).toContain("text-foreground");
    });

    it("should highlight Settings tab when path starts with /settings", () => {
      render(<BottomTabBar currentPath="/settings/profile" isAdmin={false} />);
      const settingsLink = screen.getByRole("link", { name: /settings/i });
      expect(settingsLink.className).toContain("text-foreground");
      expect(settingsLink.className).not.toContain("text-muted-foreground");
    });

    it("should highlight Audit tab when path starts with /audit", () => {
      render(<BottomTabBar currentPath="/audit" isAdmin={true} />);
      const auditLink = screen.getByRole("link", { name: /audit/i });
      expect(auditLink.className).toContain("text-foreground");
      expect(auditLink.className).not.toContain("text-muted-foreground");
    });

    it("should not highlight inactive tabs", () => {
      render(<BottomTabBar currentPath="/agents" isAdmin={true} />);
      const settingsLink = screen.getByRole("link", { name: /settings/i });
      const auditLink = screen.getByRole("link", { name: /audit/i });
      expect(settingsLink.className).toContain("text-muted-foreground");
      expect(auditLink.className).toContain("text-muted-foreground");
    });
  });

  describe("CSS classes", () => {
    it("should be hidden on desktop with md:hidden", () => {
      render(<BottomTabBar currentPath="/agents" isAdmin={false} />);
      const nav = screen.getByRole("navigation");
      expect(nav.className).toContain("md:hidden");
    });

    it("should be fixed at the bottom", () => {
      render(<BottomTabBar currentPath="/agents" isAdmin={false} />);
      const nav = screen.getByRole("navigation");
      expect(nav.className).toContain("fixed");
      expect(nav.className).toContain("bottom-0");
    });

    it("should have safe area padding for iPhones", () => {
      render(<BottomTabBar currentPath="/agents" isAdmin={false} />);
      const nav = screen.getByRole("navigation");
      expect(nav.className).toContain("pb-[env(safe-area-inset-bottom)]");
    });

    it("should have h-14 height on the tab container", () => {
      const { container } = render(<BottomTabBar currentPath="/agents" isAdmin={false} />);
      const tabContainer = container.querySelector(".h-14");
      expect(tabContainer).toBeInTheDocument();
    });
  });
});
