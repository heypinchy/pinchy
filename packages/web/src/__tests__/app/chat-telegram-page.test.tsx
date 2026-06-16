import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";

// Mirrors chat-chatid-page.test.tsx but targets the static `telegram` segment
// (#508): the page must apply the SAME agent DB load + assertAgentAccess auth
// gate as the base chat/[agentId]/page.tsx, and render the read-only
// <TelegramChatView> with the agent props instead of <Chat>.

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

let capturedViewProps: Record<string, unknown> = {};

vi.mock("@/components/telegram-chat-view", () => ({
  TelegramChatView: (props: Record<string, unknown>) => {
    capturedViewProps = props;
    return (
      <div data-testid="mock-telegram-view">
        {props.agentName as string} ({props.agentId as string})
      </div>
    );
  },
}));

import { requireAuth } from "@/lib/require-auth";
import { assertAgentAccess } from "@/lib/agent-access";
import TelegramChatPage from "@/app/(app)/chat/[agentId]/telegram/page";
import { render, screen } from "@testing-library/react";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockAssertAgentAccess = assertAgentAccess as ReturnType<typeof vi.fn>;

describe("ChatPage telegram segment (#508)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedViewProps = {};
    dbSelectMock.from.mockReturnValue({ where: dbSelectMock.where });
  });

  it("renders the read-only TelegramChatView with the agent props", async () => {
    const personalAgent = {
      id: "agent-1",
      name: "Smithers",
      ownerId: "user-1",
      isPersonal: true,
      avatarSeed: "seed-x",
    };

    mockRequireAuth.mockResolvedValue({ user: { id: "user-1", role: "member" } });
    dbSelectMock.where.mockResolvedValue([personalAgent]);
    mockAssertAgentAccess.mockImplementation(() => {});

    const result = await TelegramChatPage({
      params: Promise.resolve({ agentId: "agent-1" }),
    });
    render(result);

    expect(screen.getByTestId("mock-telegram-view")).toBeInTheDocument();
    expect(capturedViewProps.agentId).toBe("agent-1");
    expect(capturedViewProps.agentName).toBe("Smithers");
    expect(capturedViewProps.isPersonal).toBe(true);
    expect(capturedViewProps.avatarUrl).toBe("data:image/svg+xml;utf8,mock-seed-x");
    // Owner viewing their own personal agent can edit.
    expect(capturedViewProps.canEdit).toBe(true);
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
      TelegramChatPage({ params: Promise.resolve({ agentId: "agent-1" }) })
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
      TelegramChatPage({ params: Promise.resolve({ agentId: "missing" }) })
    ).rejects.toThrow("NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalled();
  });
});
