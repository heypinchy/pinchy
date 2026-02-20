import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AppSidebar } from "@/components/sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";

vi.mock("next/image", () => ({
  default: ({
    priority,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }) => {
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    return <img {...props} />;
  },
}));

describe("AppSidebar", () => {
  it("should render Pinchy branding", () => {
    render(
      <SidebarProvider>
        <AppSidebar agents={[]} />
      </SidebarProvider>
    );
    expect(screen.getByText("Pinchy")).toBeInTheDocument();
  });

  it("should render the Pinchy logo in the header", () => {
    render(
      <SidebarProvider>
        <AppSidebar agents={[]} />
      </SidebarProvider>
    );
    const logo = screen.getByAltText("Pinchy");
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute("src", "/pinchy-logo.png");
  });

  it("should render agent names", () => {
    const agents = [{ id: "1", name: "Smithers", model: "anthropic/claude-sonnet-4-20250514" }];
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
    expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
  });

  it("should render a New Agent link that points to /agents/new", () => {
    render(
      <SidebarProvider>
        <AppSidebar agents={[]} />
      </SidebarProvider>
    );
    const newAgentLink = screen.getByRole("link", { name: /new agent/i });
    expect(newAgentLink).toBeInTheDocument();
    expect(newAgentLink).toHaveAttribute("href", "/agents/new");
  });
});
