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
        <AppSidebar agents={[]} isAdmin={false} />
      </SidebarProvider>
    );
    expect(screen.getByText("Pinchy")).toBeInTheDocument();
  });

  it("should render the Pinchy logo in the header", () => {
    render(
      <SidebarProvider>
        <AppSidebar agents={[]} isAdmin={false} />
      </SidebarProvider>
    );
    const logo = screen.getByAltText("Pinchy");
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute("src", "/pinchy-logo.png");
  });

  it("should render agent names", () => {
    const agents = [
      { id: "1", name: "Smithers", model: "anthropic/claude-sonnet-4-20250514", isPersonal: false },
    ];
    render(
      <SidebarProvider>
        <AppSidebar agents={agents} isAdmin={false} />
      </SidebarProvider>
    );
    expect(screen.getByText("Smithers")).toBeInTheDocument();
  });

  it("should render settings link", () => {
    render(
      <SidebarProvider>
        <AppSidebar agents={[]} isAdmin={false} />
      </SidebarProvider>
    );
    expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
  });

  describe("New Agent link visibility", () => {
    it("should render New Agent link when isAdmin is true", () => {
      render(
        <SidebarProvider>
          <AppSidebar agents={[]} isAdmin={true} />
        </SidebarProvider>
      );
      const newAgentLink = screen.getByRole("link", { name: /new agent/i });
      expect(newAgentLink).toBeInTheDocument();
      expect(newAgentLink).toHaveAttribute("href", "/agents/new");
    });

    it("should NOT render New Agent link when isAdmin is false", () => {
      render(
        <SidebarProvider>
          <AppSidebar agents={[]} isAdmin={false} />
        </SidebarProvider>
      );
      expect(screen.queryByRole("link", { name: /new agent/i })).not.toBeInTheDocument();
    });
  });

  describe("personal agent styling", () => {
    it("should render a User icon for personal agents", () => {
      const agents = [
        {
          id: "1",
          name: "My Agent",
          model: "anthropic/claude-sonnet-4-20250514",
          isPersonal: true,
        },
      ];
      render(
        <SidebarProvider>
          <AppSidebar agents={agents} isAdmin={false} />
        </SidebarProvider>
      );
      const agentLink = screen.getByRole("link", { name: /my agent/i });
      const userIcon = agentLink.querySelector("svg.lucide-user");
      expect(userIcon).toBeInTheDocument();
    });

    it("should render a Bot icon for non-personal agents", () => {
      const agents = [
        {
          id: "1",
          name: "Smithers",
          model: "anthropic/claude-sonnet-4-20250514",
          isPersonal: false,
        },
      ];
      render(
        <SidebarProvider>
          <AppSidebar agents={agents} isAdmin={false} />
        </SidebarProvider>
      );
      const agentLink = screen.getByRole("link", { name: /smithers/i });
      const botIcon = agentLink.querySelector("svg.lucide-bot");
      expect(botIcon).toBeInTheDocument();
    });
  });

  describe("agent ordering", () => {
    it("should render personal agents before non-personal agents", () => {
      const agents = [
        {
          id: "1",
          name: "Shared Agent",
          model: "anthropic/claude-sonnet-4-20250514",
          isPersonal: false,
        },
        {
          id: "2",
          name: "My Personal Agent",
          model: "anthropic/claude-sonnet-4-20250514",
          isPersonal: true,
        },
      ];
      render(
        <SidebarProvider>
          <AppSidebar agents={agents} isAdmin={false} />
        </SidebarProvider>
      );
      const links = screen.getAllByRole("link").filter((link) => {
        const href = link.getAttribute("href");
        return href?.startsWith("/chat/");
      });
      expect(links).toHaveLength(2);
      expect(links[0]).toHaveTextContent("My Personal Agent");
      expect(links[1]).toHaveTextContent("Shared Agent");
    });
  });
});
