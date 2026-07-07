import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";

// #476 gap 2: a personal agent's owner may disconnect its own Telegram bot
// without an admin. The permission change on the route is only useful if the
// owner can actually reach the Disconnect button — i.e. the Telegram tab must
// be visible to a non-admin owner, not only to admins.

const mockSession = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => mockSession() },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ agentId: "agent-1" }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/chat/agent-1/settings",
}));

vi.mock("@/components/restart-provider", () => ({
  useRestart: () => ({ triggerRestart: vi.fn() }),
}));

// Stub the tab bodies — this test only exercises the page's tab wiring.
vi.mock("@/components/agent-settings-general", () => ({ AgentSettingsGeneral: () => <div /> }));
vi.mock("@/components/agent-settings-file", () => ({ AgentSettingsFile: () => <div /> }));
vi.mock("@/components/agent-settings-personality", () => ({
  AgentSettingsPersonality: () => <div />,
}));
vi.mock("@/components/agent-settings-permissions", () => ({
  AgentSettingsPermissions: () => <div />,
}));
vi.mock("@/components/agent-settings-access", () => ({ AgentSettingsAccess: () => <div /> }));
vi.mock("@/components/agent-settings-diagnostics", () => ({
  AgentSettingsDiagnostics: () => <div />,
}));
vi.mock("@/components/agent-telegram-settings", () => ({
  AgentTelegramSettings: () => <div data-testid="agent-telegram-settings" />,
}));

import { AgentSettingsPageContent } from "@/components/agent-settings-page-content";

const baseAgent = {
  id: "agent-1",
  name: "Smithers",
  model: "anthropic/claude-haiku-4-5-20251001",
  allowedTools: [],
  pluginConfig: null,
  tagline: null,
  avatarSeed: null,
  personalityPresetId: null,
  visibility: "restricted",
  groupIds: [],
};

function mockFetchReturning(agent: object) {
  global.fetch = vi.fn().mockImplementation((url: unknown) => {
    if (url === "/api/agents/agent-1") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(agent) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  }) as unknown as typeof fetch;
}

describe("AgentSettingsPageContent — Telegram tab visibility (#476 gap 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the Telegram tab to a non-admin owner of a personal agent", async () => {
    mockSession.mockReturnValue({
      data: { user: { id: "u1", role: "member" } },
      isPending: false,
    });
    mockFetchReturning({ ...baseAgent, isPersonal: true });

    render(<AgentSettingsPageContent />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /telegram/i })).toBeInTheDocument();
    });
  });

  it("shows the Telegram tab to an admin on a shared agent", async () => {
    mockSession.mockReturnValue({
      data: { user: { id: "admin-1", role: "admin" } },
      isPending: false,
    });
    mockFetchReturning({ ...baseAgent, isPersonal: false });

    render(<AgentSettingsPageContent />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /telegram/i })).toBeInTheDocument();
    });
  });
});
