import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";

const mockNotFound = vi.fn(() => {
  throw new Error("NOT_FOUND");
});

const mockRedirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});

vi.mock("next/navigation", () => ({
  notFound: () => mockNotFound(),
  redirect: (url: string) => mockRedirect(url),
}));

const mockSessionsList = vi.fn();

vi.mock("@/server/openclaw-client", () => ({
  getOpenClawClient: () => ({ sessions: { list: mockSessionsList } }),
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
        {props.agentName as string} ({props.agentId as string})
      </div>
    );
  },
}));

import { requireAuth } from "@/lib/require-auth";
import { assertAgentAccess } from "@/lib/agent-access";
import { getUserGroupIds, getAgentGroupIds } from "@/lib/groups";
import ChatPage from "@/app/(app)/chat/[agentId]/page";
import { render, screen } from "@testing-library/react";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockAssertAgentAccess = assertAgentAccess as ReturnType<typeof vi.fn>;
const mockGetUserGroupIds = getUserGroupIds as ReturnType<typeof vi.fn>;
const mockGetAgentGroupIds = getAgentGroupIds as ReturnType<typeof vi.fn>;

describe("ChatPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedChatProps = {};
    dbSelectMock.from.mockReturnValue({ where: dbSelectMock.where });
    mockGetUserGroupIds.mockResolvedValue([]);
    mockGetAgentGroupIds.mockResolvedValue([]);
    // Default: no other sessions → no redirect, render the default chat.
    mockSessionsList.mockResolvedValue({ sessions: [] });
  });

  it("calls notFound when a non-admin user tries to access another user's personal agent", async () => {
    const personalAgent = {
      id: "agent-1",
      name: "Personal Agent",
      ownerId: "owner-user",
      isPersonal: true,
    };

    mockRequireAuth.mockResolvedValue({
      user: { id: "other-user", role: "member" },
    });

    dbSelectMock.where.mockResolvedValue([personalAgent]);

    mockAssertAgentAccess.mockImplementation(() => {
      throw new Error("Access denied");
    });

    await expect(ChatPage({ params: Promise.resolve({ agentId: "agent-1" }) })).rejects.toThrow(
      "NOT_FOUND"
    );

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

  it("passes user and agent group IDs to assertAgentAccess for restricted agents", async () => {
    const restrictedAgent = {
      id: "agent-restricted",
      name: "Restricted Agent",
      ownerId: null,
      isPersonal: false,
      visibility: "restricted",
    };

    mockRequireAuth.mockResolvedValue({
      user: { id: "user-1", role: "member" },
    });

    dbSelectMock.where.mockResolvedValue([restrictedAgent]);
    mockGetUserGroupIds.mockResolvedValue(["g1", "g2"]);
    mockGetAgentGroupIds.mockResolvedValue(["g2", "g3"]);
    mockAssertAgentAccess.mockImplementation(() => {});

    const result = await ChatPage({ params: Promise.resolve({ agentId: "agent-restricted" }) });
    render(result);

    expect(mockAssertAgentAccess).toHaveBeenCalledWith(
      restrictedAgent,
      "user-1",
      "member",
      ["g1", "g2"],
      ["g2", "g3"],
      "paid"
    );
  });

  it("renders the chat when a non-admin user accesses a shared agent", async () => {
    const sharedAgent = {
      id: "agent-2",
      name: "Shared Agent",
      ownerId: null,
      isPersonal: false,
    };

    mockRequireAuth.mockResolvedValue({
      user: { id: "user-1", role: "member" },
    });

    dbSelectMock.where.mockResolvedValue([sharedAgent]);

    mockAssertAgentAccess.mockImplementation(() => {
      // No throw = access granted
    });

    const result = await ChatPage({ params: Promise.resolve({ agentId: "agent-2" }) });

    render(result);

    expect(screen.getByTestId("mock-chat")).toBeInTheDocument();
    expect(screen.getByText("Shared Agent (agent-2)")).toBeInTheDocument();
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(mockAssertAgentAccess).toHaveBeenCalledWith(
      sharedAgent,
      "user-1",
      "member",
      [],
      [],
      "paid"
    );
  });

  it("renders the chat when an admin accesses another user's personal agent", async () => {
    const personalAgent = {
      id: "agent-3",
      name: "Someone's Agent",
      ownerId: "other-user",
      isPersonal: true,
    };

    mockRequireAuth.mockResolvedValue({
      user: { id: "admin-user", role: "admin" },
    });

    dbSelectMock.where.mockResolvedValue([personalAgent]);

    mockAssertAgentAccess.mockImplementation(() => {
      // No throw = admin access granted
    });

    const result = await ChatPage({ params: Promise.resolve({ agentId: "agent-3" }) });

    render(result);

    expect(screen.getByTestId("mock-chat")).toBeInTheDocument();
    expect(screen.getByText("Someone's Agent (agent-3)")).toBeInTheDocument();
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(mockAssertAgentAccess).toHaveBeenCalledWith(
      personalAgent,
      "admin-user",
      "admin",
      [],
      [],
      "paid"
    );
  });

  it("passes isPersonal=false to Chat for a shared agent", async () => {
    const sharedAgent = {
      id: "agent-shared",
      name: "Shared Agent",
      ownerId: null,
      isPersonal: false,
    };

    mockRequireAuth.mockResolvedValue({
      user: { id: "user-1", role: "member" },
    });

    dbSelectMock.where.mockResolvedValue([sharedAgent]);
    mockAssertAgentAccess.mockImplementation(() => {});

    const result = await ChatPage({ params: Promise.resolve({ agentId: "agent-shared" }) });
    render(result);

    expect(capturedChatProps.isPersonal).toBe(false);
  });

  it("passes isPersonal=true to Chat for a personal agent", async () => {
    const personalAgent = {
      id: "agent-personal",
      name: "My Agent",
      ownerId: "user-1",
      isPersonal: true,
    };

    mockRequireAuth.mockResolvedValue({
      user: { id: "user-1", role: "member" },
    });

    dbSelectMock.where.mockResolvedValue([personalAgent]);
    mockAssertAgentAccess.mockImplementation(() => {});

    const result = await ChatPage({ params: Promise.resolve({ agentId: "agent-personal" }) });
    render(result);

    expect(capturedChatProps.isPersonal).toBe(true);
  });

  it("passes avatarUrl to Chat computed from agent fields", async () => {
    const agentWithAvatar = {
      id: "agent-avatar",
      name: "Avatar Agent",
      ownerId: null,
      isPersonal: false,
      avatarSeed: "my-seed",
    };

    mockRequireAuth.mockResolvedValue({
      user: { id: "user-1", role: "member" },
    });

    dbSelectMock.where.mockResolvedValue([agentWithAvatar]);
    mockAssertAgentAccess.mockImplementation(() => {});

    const result = await ChatPage({ params: Promise.resolve({ agentId: "agent-avatar" }) });
    render(result);

    expect(capturedChatProps.avatarUrl).toBe("data:image/svg+xml;utf8,mock-my-seed");
  });

  it("redirects to the most-recently-interacted named chat (#508)", async () => {
    const sharedAgent = { id: "agent-2", name: "Shared Agent", ownerId: null, isPersonal: false };
    mockRequireAuth.mockResolvedValue({ user: { id: "user-1", role: "member" } });
    dbSelectMock.where.mockResolvedValue([sharedAgent]);
    mockAssertAgentAccess.mockImplementation(() => {});
    mockSessionsList.mockResolvedValue({
      sessions: [
        { key: "agent:agent-2:direct:user-1", sessionId: "s-default", lastInteractionAt: 100 },
        { key: "agent:agent-2:direct:user-1:chat-x", sessionId: "s-x", lastInteractionAt: 200 },
      ],
    });

    await expect(
      ChatPage({
        params: Promise.resolve({ agentId: "agent-2" }),
        searchParams: Promise.resolve({}),
      })
    ).rejects.toThrow("REDIRECT:/chat/agent-2/chat-x");

    expect(mockRedirect).toHaveBeenCalledWith("/chat/agent-2/chat-x");
  });

  it("does NOT redirect when ?keep is set (explicit default chat)", async () => {
    const sharedAgent = { id: "agent-2", name: "Shared Agent", ownerId: null, isPersonal: false };
    mockRequireAuth.mockResolvedValue({ user: { id: "user-1", role: "member" } });
    dbSelectMock.where.mockResolvedValue([sharedAgent]);
    mockAssertAgentAccess.mockImplementation(() => {});
    mockSessionsList.mockResolvedValue({
      sessions: [
        { key: "agent:agent-2:direct:user-1:chat-x", sessionId: "s-x", lastInteractionAt: 200 },
      ],
    });

    const result = await ChatPage({
      params: Promise.resolve({ agentId: "agent-2" }),
      searchParams: Promise.resolve({ keep: "1" }),
    });
    render(result);

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(screen.getByTestId("mock-chat")).toBeInTheDocument();
  });

  it("renders the default chat when OpenClaw is unreachable", async () => {
    const sharedAgent = { id: "agent-2", name: "Shared Agent", ownerId: null, isPersonal: false };
    mockRequireAuth.mockResolvedValue({ user: { id: "user-1", role: "member" } });
    dbSelectMock.where.mockResolvedValue([sharedAgent]);
    mockAssertAgentAccess.mockImplementation(() => {});
    mockSessionsList.mockRejectedValue(new Error("openclaw down"));

    const result = await ChatPage({
      params: Promise.resolve({ agentId: "agent-2" }),
      searchParams: Promise.resolve({}),
    });
    render(result);

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(screen.getByTestId("mock-chat")).toBeInTheDocument();
  });
});
