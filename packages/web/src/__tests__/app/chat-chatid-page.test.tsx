import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";

// Mirrors chat-page.test.tsx but targets the [chatId] dynamic segment (#508):
// the page must apply the SAME agent DB load + assertAgentAccess auth gate as
// the base chat/[agentId]/page.tsx, and additionally thread the chatId param
// down to <Chat chatId={...} />.

const mockNotFound = vi.fn(() => {
  throw new Error("NOT_FOUND");
});

vi.mock("next/navigation", () => ({
  notFound: () => mockNotFound(),
}));

const dbSelectMock = {
  where: vi.fn(),
  from: vi.fn(),
};

vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: (...args: unknown[]) => dbSelectMock.from(...args),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  activeAgents: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
}));

vi.mock("@/lib/require-auth", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/agent-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-access")>();
  return {
    ...actual,
    assertAgentAccess: vi.fn(),
  };
});

vi.mock("@/lib/groups", () => ({
  getUserGroupIds: vi.fn().mockResolvedValue([]),
  getAgentGroupIds: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/enterprise", () => ({
  isEnterprise: vi.fn().mockResolvedValue(true),
  getLicenseState: vi.fn().mockResolvedValue("paid"),
}));

vi.mock("@/lib/avatar", () => ({
  getAgentAvatarSvg: vi.fn(
    (agent: { avatarSeed: string | null; name: string }) =>
      `data:image/svg+xml;utf8,mock-${agent.avatarSeed ?? agent.name}`
  ),
}));

let capturedChatProps: Record<string, unknown> = {};

vi.mock("@/components/chat", () => ({
  Chat: (props: Record<string, unknown>) => {
    capturedChatProps = props;
    return (
      <div data-testid="mock-chat">
        {props.agentName as string} ({props.agentId as string}/{props.chatId as string})
      </div>
    );
  },
}));

import { requireAuth } from "@/lib/require-auth";
import { assertAgentAccess } from "@/lib/agent-access";
import ChatChatIdPage from "@/app/(app)/chat/[agentId]/[chatId]/page";
import { render, screen } from "@testing-library/react";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockAssertAgentAccess = assertAgentAccess as ReturnType<typeof vi.fn>;

describe("ChatPage [chatId] segment (#508)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedChatProps = {};
    dbSelectMock.from.mockReturnValue({ where: dbSelectMock.where });
  });

  it("passes the chatId param through to Chat", async () => {
    const sharedAgent = {
      id: "agent-2",
      name: "Shared Agent",
      ownerId: null,
      isPersonal: false,
    };

    mockRequireAuth.mockResolvedValue({ user: { id: "user-1", role: "member" } });
    dbSelectMock.where.mockResolvedValue([sharedAgent]);
    mockAssertAgentAccess.mockImplementation(() => {});

    const result = await ChatChatIdPage({
      params: Promise.resolve({ agentId: "agent-2", chatId: "chat-x" }),
    });
    render(result);

    expect(screen.getByTestId("mock-chat")).toBeInTheDocument();
    expect(capturedChatProps.agentId).toBe("agent-2");
    expect(capturedChatProps.chatId).toBe("chat-x");
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("enforces the same auth gate as the base chat page (notFound on access denial)", async () => {
    const personalAgent = {
      id: "agent-1",
      name: "Personal Agent",
      ownerId: "owner-user",
      isPersonal: true,
    };

    mockRequireAuth.mockResolvedValue({ user: { id: "other-user", role: "member" } });
    dbSelectMock.where.mockResolvedValue([personalAgent]);
    mockAssertAgentAccess.mockImplementation(() => {
      throw new Error("Access denied");
    });

    await expect(
      ChatChatIdPage({ params: Promise.resolve({ agentId: "agent-1", chatId: "chat-x" }) })
    ).rejects.toThrow("NOT_FOUND");

    expect(mockAssertAgentAccess).toHaveBeenCalledWith(
      personalAgent,
      "other-user",
      "member",
      [],
      [],
      "paid"
    );
    expect(mockNotFound).toHaveBeenCalled();
  });

  it("calls notFound when the agent does not exist", async () => {
    mockRequireAuth.mockResolvedValue({ user: { id: "user-1", role: "member" } });
    dbSelectMock.where.mockResolvedValue([]);

    await expect(
      ChatChatIdPage({ params: Promise.resolve({ agentId: "missing", chatId: "chat-x" }) })
    ).rejects.toThrow("NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalled();
  });
});
