import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { AgentList, type Agent } from "@/components/agent-list";

vi.mock("@/lib/chat-list-cache", () => ({
  prefetchChatList: vi.fn(),
}));
import { prefetchChatList } from "@/lib/chat-list-cache";

const agents: Agent[] = [
  { id: "a1", name: "Smithers", model: "m", isPersonal: false, tagline: null, avatarSeed: null },
  {
    id: "a2",
    name: "Odoo Operator",
    model: "m",
    isPersonal: false,
    tagline: null,
    avatarSeed: null,
  },
];

beforeEach(() => vi.clearAllMocks());

describe("AgentList prefetch (#610)", () => {
  it("prefetches an agent's chat list on hover", async () => {
    const user = userEvent.setup();
    render(<AgentList agents={agents} currentPath="/chat/a1" />);
    await user.hover(screen.getByText("Odoo Operator"));
    expect(prefetchChatList).toHaveBeenCalledWith("a2");
  });

  it("prefetches on focus for keyboard/a11y navigation", () => {
    render(<AgentList agents={agents} currentPath="/chat/a1" />);
    const link = screen.getByText("Odoo Operator").closest("a")!;
    link.focus();
    expect(prefetchChatList).toHaveBeenCalledWith("a2");
  });
});
