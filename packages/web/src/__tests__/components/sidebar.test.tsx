import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AppSidebar } from "@/components/sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";

describe("AppSidebar", () => {
  it("should render Pinchy branding", () => {
    render(
      <SidebarProvider>
        <AppSidebar agents={[]} />
      </SidebarProvider>
    );
    expect(screen.getByText("Pinchy")).toBeInTheDocument();
  });

  it("should render agent names", () => {
    const agents = [
      { id: "1", name: "Smithers", model: "anthropic/claude-sonnet-4-20250514" },
    ];
    render(
      <SidebarProvider>
        <AppSidebar agents={agents} />
      </SidebarProvider>
    );
    expect(screen.getByText("Smithers")).toBeInTheDocument();
  });

  it("should render settings link", () => {
    render(
      <SidebarProvider>
        <AppSidebar agents={[]} />
      </SidebarProvider>
    );
    expect(screen.getByRole("link", { name: /settings|einstellungen/i })).toBeInTheDocument();
  });
});
