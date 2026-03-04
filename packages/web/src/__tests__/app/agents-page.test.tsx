import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(() => "/agents"),
}));

vi.mock("@/lib/avatar", () => ({
  getAgentAvatarSvg: vi.fn(() => "data:image/svg+xml,mock"),
}));

import { AgentsPageContent } from "@/app/(app)/agents/agents-page-content";

describe("AgentsPageContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the Agents heading", () => {
    render(<AgentsPageContent agents={[]} />);
    expect(screen.getByRole("heading", { name: "Agents" })).toBeInTheDocument();
  });

  it("renders the agent list with agents", () => {
    const agents = [
      {
        id: "agent-1",
        name: "Smithers",
        model: "gpt-4",
        isPersonal: false,
        tagline: "Your helpful butler",
        avatarSeed: null,
      },
      {
        id: "agent-2",
        name: "My Agent",
        model: "claude-3",
        isPersonal: true,
        tagline: null,
        avatarSeed: "seed-123",
      },
    ];

    render(<AgentsPageContent agents={agents} />);

    expect(screen.getByText("Smithers")).toBeInTheDocument();
    expect(screen.getByText("My Agent")).toBeInTheDocument();
    expect(screen.getByText("Your helpful butler")).toBeInTheDocument();
  });

  it("renders agent links pointing to chat pages", () => {
    const agents = [
      {
        id: "agent-1",
        name: "Smithers",
        model: "gpt-4",
        isPersonal: false,
        tagline: null,
        avatarSeed: null,
      },
    ];

    render(<AgentsPageContent agents={agents} />);

    const link = screen.getByRole("link", { name: /Smithers/ });
    expect(link).toHaveAttribute("href", "/chat/agent-1");
  });

  it("has proper padding classes", () => {
    const { container } = render(<AgentsPageContent agents={[]} />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("p-4");
    expect(wrapper.className).toContain("md:p-8");
  });
});
