import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { AppSidebar } from "@/components/sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";

const mockSignOut = vi.fn();
vi.mock("next-auth/react", () => ({
  signOut: (...args: unknown[]) => mockSignOut(...args),
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
  });
});
