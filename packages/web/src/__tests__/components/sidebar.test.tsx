import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { AppSidebar } from "@/components/sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";

const mockSignOut = vi.fn();
const mockUsePathname = vi.fn().mockReturnValue("/chat/1");

vi.mock("next-auth/react", () => ({
  signOut: (...args: unknown[]) => mockSignOut(...args),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
}));

vi.mock("next/image", () => ({
  default: ({
    priority,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }) => {
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    return <img {...props} />;
  },
}));

vi.mock("@/lib/avatar", () => ({
  getAgentAvatarSvg: vi.fn((agent: { avatarSeed: string | null; name: string }) => {
    if (agent.avatarSeed === "__smithers__") return "/images/smithers-avatar.png";
    return `data:image/svg+xml;utf8,mock-${agent.avatarSeed ?? agent.name}`;
  }),
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
      {
        id: "1",
        name: "Smithers",
        model: "anthropic/claude-sonnet-4-20250514",
        isPersonal: false,
        tagline: null,
        avatarSeed: null,
      },
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

  describe("avatar rendering", () => {
    it("should render avatar image for agents", () => {
      const agents = [
        {
          id: "1",
          name: "Test Agent",
          model: "anthropic/claude-sonnet-4-20250514",
          isPersonal: false,
          tagline: null,
          avatarSeed: "my-seed",
        },
      ];
      const { container } = render(
        <SidebarProvider>
          <AppSidebar agents={agents} isAdmin={false} />
        </SidebarProvider>
      );
      const avatar = container.querySelector('img[src="data:image/svg+xml;utf8,mock-my-seed"]');
      expect(avatar).toBeInTheDocument();
    });

    it("should render Smithers avatar for __smithers__ seed", () => {
      const agents = [
        {
          id: "1",
          name: "Smithers",
          model: "anthropic/claude-sonnet-4-20250514",
          isPersonal: true,
          tagline: null,
          avatarSeed: "__smithers__",
        },
      ];
      const { container } = render(
        <SidebarProvider>
          <AppSidebar agents={agents} isAdmin={false} />
        </SidebarProvider>
      );
      const avatar = container.querySelector('img[src="/images/smithers-avatar.png"]');
      expect(avatar).toBeInTheDocument();
    });
  });

  describe("tagline rendering", () => {
    it("should render tagline when present", () => {
      const agents = [
        {
          id: "1",
          name: "HR Bot",
          model: "anthropic/claude-sonnet-4-20250514",
          isPersonal: false,
          tagline: "Answers HR questions",
          avatarSeed: null,
        },
      ];
      render(
        <SidebarProvider>
          <AppSidebar agents={agents} isAdmin={false} />
        </SidebarProvider>
      );
      expect(screen.getByText("Answers HR questions")).toBeInTheDocument();
    });

    it("should show title tooltip on tagline for hover", () => {
      const agents = [
        {
          id: "1",
          name: "HR Bot",
          model: "anthropic/claude-sonnet-4-20250514",
          isPersonal: false,
          tagline: "Answers HR questions from your documents",
          avatarSeed: null,
        },
      ];
      render(
        <SidebarProvider>
          <AppSidebar agents={agents} isAdmin={false} />
        </SidebarProvider>
      );
      const tagline = screen.getByText("Answers HR questions from your documents");
      expect(tagline).toHaveAttribute("title", "Answers HR questions from your documents");
    });

    it("should show title tooltip on agent name for hover", () => {
      const agents = [
        {
          id: "1",
          name: "A Very Long Agent Name That Gets Truncated",
          model: "anthropic/claude-sonnet-4-20250514",
          isPersonal: false,
          tagline: null,
          avatarSeed: null,
        },
      ];
      render(
        <SidebarProvider>
          <AppSidebar agents={agents} isAdmin={false} />
        </SidebarProvider>
      );
      const name = screen.getByText("A Very Long Agent Name That Gets Truncated");
      expect(name).toHaveAttribute("title", "A Very Long Agent Name That Gets Truncated");
    });

    it("should not render tagline when null", () => {
      const agents = [
        {
          id: "1",
          name: "HR Bot",
          model: "anthropic/claude-sonnet-4-20250514",
          isPersonal: false,
          tagline: null,
          avatarSeed: null,
        },
      ];
      render(
        <SidebarProvider>
          <AppSidebar agents={agents} isAdmin={false} />
        </SidebarProvider>
      );
      // Only the agent name should be rendered, no additional text
      const link = screen.getByRole("link", { name: /hr bot/i });
      expect(link).toBeInTheDocument();
      expect(link.textContent).toBe("HR Bot");
    });
  });

  describe("logout button", () => {
    it("should render a logout button in the sidebar footer", () => {
      render(
        <SidebarProvider>
          <AppSidebar agents={[]} isAdmin={false} />
        </SidebarProvider>
      );
      expect(screen.getByRole("button", { name: /log out/i })).toBeInTheDocument();
    });

    it("should call signOut when clicked", async () => {
      const user = userEvent.setup();
      render(
        <SidebarProvider>
          <AppSidebar agents={[]} isAdmin={false} />
        </SidebarProvider>
      );
      await user.click(screen.getByRole("button", { name: /log out/i }));
      expect(mockSignOut).toHaveBeenCalledWith({ callbackUrl: "/login" });
    });
  });

  describe("active agent highlighting", () => {
    const agents = [
      {
        id: "agent-1",
        name: "Alpha",
        model: "anthropic/claude-sonnet-4-20250514",
        isPersonal: false,
        tagline: null,
        avatarSeed: null,
      },
      {
        id: "agent-2",
        name: "Beta",
        model: "anthropic/claude-sonnet-4-20250514",
        isPersonal: false,
        tagline: null,
        avatarSeed: null,
      },
    ];

    it("should mark the current agent's menu button as active", () => {
      mockUsePathname.mockReturnValue("/chat/agent-1");
      render(
        <SidebarProvider>
          <AppSidebar agents={agents} isAdmin={false} />
        </SidebarProvider>
      );
      const activeButton = screen.getByRole("link", { name: /alpha/i }).closest("[data-active]");
      expect(activeButton).toHaveAttribute("data-active", "true");
    });

    it("should not mark other agents as active", () => {
      mockUsePathname.mockReturnValue("/chat/agent-1");
      render(
        <SidebarProvider>
          <AppSidebar agents={agents} isAdmin={false} />
        </SidebarProvider>
      );
      const betaLink = screen.getByRole("link", { name: /beta/i });
      const betaButton = betaLink.closest("[data-active]");
      // Either no data-active attribute or data-active="false"
      expect(betaButton === null || betaButton.getAttribute("data-active") === "false").toBe(true);
    });

    it("should apply custom active background on the active agent", () => {
      mockUsePathname.mockReturnValue("/chat/agent-1");
      render(
        <SidebarProvider>
          <AppSidebar agents={agents} isAdmin={false} />
        </SidebarProvider>
      );
      const activeLink = screen.getByRole("link", { name: /alpha/i });
      expect(activeLink.className).toContain("data-[active=true]:bg-[oklch");
    });

    it("should not apply custom active background on inactive agents", () => {
      mockUsePathname.mockReturnValue("/chat/agent-1");
      render(
        <SidebarProvider>
          <AppSidebar agents={agents} isAdmin={false} />
        </SidebarProvider>
      );
      const inactiveLink = screen.getByRole("link", { name: /beta/i });
      expect(inactiveLink.className).not.toContain("data-[active=true]:bg-[oklch");
    });

    it("should update active state for settings subpages", () => {
      mockUsePathname.mockReturnValue("/chat/agent-2/settings");
      render(
        <SidebarProvider>
          <AppSidebar agents={agents} isAdmin={false} />
        </SidebarProvider>
      );
      const activeButton = screen.getByRole("link", { name: /beta/i }).closest("[data-active]");
      expect(activeButton).toHaveAttribute("data-active", "true");
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
          tagline: null,
          avatarSeed: null,
        },
        {
          id: "2",
          name: "My Personal Agent",
          model: "anthropic/claude-sonnet-4-20250514",
          isPersonal: true,
          tagline: null,
          avatarSeed: null,
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

    it("should sort non-personal agents alphabetically by name", () => {
      const agents = [
        {
          id: "1",
          name: "Smithers",
          model: "anthropic/claude-sonnet-4-20250514",
          isPersonal: true,
          tagline: null,
          avatarSeed: "__smithers__",
        },
        {
          id: "2",
          name: "Zara",
          model: "anthropic/claude-sonnet-4-20250514",
          isPersonal: false,
          tagline: null,
          avatarSeed: null,
        },
        {
          id: "3",
          name: "Ada",
          model: "anthropic/claude-sonnet-4-20250514",
          isPersonal: false,
          tagline: null,
          avatarSeed: null,
        },
        {
          id: "4",
          name: "Maya",
          model: "anthropic/claude-sonnet-4-20250514",
          isPersonal: false,
          tagline: null,
          avatarSeed: null,
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
      expect(links).toHaveLength(4);
      expect(links[0]).toHaveTextContent("Smithers");
      expect(links[1]).toHaveTextContent("Ada");
      expect(links[2]).toHaveTextContent("Maya");
      expect(links[3]).toHaveTextContent("Zara");
    });
  });
});
