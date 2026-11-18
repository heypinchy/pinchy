// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AppShell } from "@/components/app-shell";

let mockPathname = "/agents";

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

describe("AppShell", () => {
  beforeEach(() => {
    mockPathname = "/agents";
  });

  it("should always render children", () => {
    render(
      <AppShell isAdmin={false}>
        <div data-testid="child">Hello</div>
      </AppShell>
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  describe("BottomTabBar visibility", () => {
    it("should show BottomTabBar on /agents", () => {
      mockPathname = "/agents";
      render(
        <AppShell isAdmin={false}>
          <div>content</div>
        </AppShell>
      );
      expect(screen.getByRole("navigation")).toBeInTheDocument();
    });

    it("should show BottomTabBar on /settings", () => {
      mockPathname = "/settings";
      render(
        <AppShell isAdmin={false}>
          <div>content</div>
        </AppShell>
      );
      expect(screen.getByRole("navigation")).toBeInTheDocument();
    });

    it("should show BottomTabBar on /audit for admins", () => {
      mockPathname = "/audit";
      render(
        <AppShell isAdmin={true}>
          <div>content</div>
        </AppShell>
      );
      expect(screen.getByRole("navigation")).toBeInTheDocument();
    });

    it("should hide BottomTabBar on /chat/agent-1", () => {
      mockPathname = "/chat/agent-1";
      render(
        <AppShell isAdmin={false}>
          <div>content</div>
        </AppShell>
      );
      expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    });

    it("should hide BottomTabBar on /chat/agent-1/settings", () => {
      mockPathname = "/chat/agent-1/settings";
      render(
        <AppShell isAdmin={false}>
          <div>content</div>
        </AppShell>
      );
      expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    });
  });

  describe("bottom padding", () => {
    it("should add pb-14 md:pb-0 when tab bar is visible", () => {
      mockPathname = "/agents";
      const { container } = render(
        <AppShell isAdmin={false}>
          <div>content</div>
        </AppShell>
      );
      const wrapper = container.firstElementChild;
      expect(wrapper?.className).toContain("pb-14");
      expect(wrapper?.className).toContain("md:pb-0");
    });

    it("should NOT add pb-14 when on a chat view", () => {
      mockPathname = "/chat/agent-1";
      const { container } = render(
        <AppShell isAdmin={false}>
          <div>content</div>
        </AppShell>
      );
      const wrapper = container.firstElementChild;
      expect(wrapper?.className).not.toContain("pb-14");
    });
  });
});
