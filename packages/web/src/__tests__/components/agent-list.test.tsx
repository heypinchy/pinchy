import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { AgentList } from "@/components/agent-list";

vi.mock("@/lib/avatar", () => ({
  getAgentAvatarSvg: vi.fn((agent: { avatarSeed: string | null; name: string }) => {
    if (agent.avatarSeed === "__smithers__") return "/images/smithers-avatar.png";
    return `data:image/svg+xml;utf8,mock-${agent.avatarSeed ?? agent.name}`;
  }),
}));

const agents = [
  {
    id: "agent-1",
    name: "Smithers",
    model: "anthropic/claude-sonnet-4-20250514",
    isPersonal: true,
    tagline: "Your personal assistant",
    avatarSeed: "__smithers__",
  },
  {
    id: "agent-2",
    name: "Zara",
    model: "anthropic/claude-sonnet-4-20250514",
    isPersonal: false,
    tagline: null,
    avatarSeed: "zara-seed",
  },
  {
    id: "agent-3",
    name: "Ada",
    model: "anthropic/claude-sonnet-4-20250514",
    isPersonal: false,
    tagline: "Code review expert",
    avatarSeed: null,
  },
];

describe("AgentList", () => {
  it("should render all agents as links to their chat pages", () => {
    render(<AgentList agents={agents} currentPath="/chat/agent-1" />);

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(3);
    expect(links[0]).toHaveAttribute("href", "/chat/agent-1");
  });

  it("should render agent names", () => {
    render(<AgentList agents={agents} currentPath="/" />);

    expect(screen.getByText("Smithers")).toBeInTheDocument();
    expect(screen.getByText("Zara")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
  });

  it("should render agent avatars", () => {
    const { container } = render(<AgentList agents={agents} currentPath="/" />);

    const smithersAvatar = container.querySelector('img[src="/images/smithers-avatar.png"]');
    expect(smithersAvatar).toBeInTheDocument();

    const zaraAvatar = container.querySelector('img[src="data:image/svg+xml;utf8,mock-zara-seed"]');
    expect(zaraAvatar).toBeInTheDocument();
  });

  it("should render taglines when present", () => {
    render(<AgentList agents={agents} currentPath="/" />);

    expect(screen.getByText("Your personal assistant")).toBeInTheDocument();
    expect(screen.getByText("Code review expert")).toBeInTheDocument();
  });

  it("should not render tagline for agents without one", () => {
    render(<AgentList agents={agents} currentPath="/" />);

    const zaraLink = screen.getByRole("link", { name: /zara/i });
    expect(zaraLink.textContent).toBe("Zara");
  });

  describe("sorting", () => {
    it("should render personal agents before shared agents", () => {
      render(<AgentList agents={agents} currentPath="/" />);

      const links = screen.getAllByRole("link");
      expect(links[0]).toHaveTextContent("Smithers");
    });

    it("should sort agents alphabetically within groups", () => {
      render(<AgentList agents={agents} currentPath="/" />);

      const links = screen.getAllByRole("link");
      // Personal first (Smithers), then alphabetical (Ada, Zara)
      expect(links[0]).toHaveTextContent("Smithers");
      expect(links[1]).toHaveTextContent("Ada");
      expect(links[2]).toHaveTextContent("Zara");
    });
  });

  describe("active agent highlighting", () => {
    it("should highlight the active agent based on currentPath", () => {
      render(<AgentList agents={agents} currentPath="/chat/agent-1" />);

      const activeLink = screen.getByRole("link", { name: /smithers/i });
      expect(activeLink.getAttribute("data-active")).toBe("true");
    });

    it("should not highlight inactive agents", () => {
      render(<AgentList agents={agents} currentPath="/chat/agent-1" />);

      const inactiveLink = screen.getByRole("link", { name: /zara/i });
      expect(
        inactiveLink.getAttribute("data-active") === null ||
          inactiveLink.getAttribute("data-active") === "false"
      ).toBe(true);
    });

    it("should highlight agent on subpages like settings", () => {
      render(<AgentList agents={agents} currentPath="/chat/agent-2/settings" />);

      const activeLink = screen.getByRole("link", { name: /zara/i });
      expect(activeLink.getAttribute("data-active")).toBe("true");
    });
  });

  describe("onAgentClick callback", () => {
    it("should call onAgentClick when an agent is clicked", async () => {
      const user = userEvent.setup();
      const onAgentClick = vi.fn();

      render(<AgentList agents={agents} currentPath="/" onAgentClick={onAgentClick} />);

      await user.click(screen.getByRole("link", { name: /ada/i }));
      expect(onAgentClick).toHaveBeenCalledTimes(1);
    });

    it("should not fail when onAgentClick is not provided", async () => {
      const user = userEvent.setup();

      render(<AgentList agents={agents} currentPath="/" />);

      // Should not throw
      await user.click(screen.getByRole("link", { name: /ada/i }));
    });
  });

  it("should render an empty list when no agents provided", () => {
    const { container } = render(<AgentList agents={[]} currentPath="/" />);
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });
});
