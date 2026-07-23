import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";

// The Automations tab (#139) is the review-and-activate surface for an agent's
// email workflows. It carries the same scope as managing the agent itself: a
// personal agent's owner (a non-admin) may manage it, and an admin may manage a
// shared agent's — mirroring the Telegram tab's gate. (A non-admin on a shared
// agent never reaches this page at all — canEdit is false and the page
// redirects to chat — so there is no "visible page without the tab" case to
// assert for them.)

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
  AgentTelegramSettings: () => <div />,
}));
vi.mock("@/components/agent-settings-automations", () => ({
  AgentSettingsAutomations: () => <div data-testid="agent-settings-automations" />,
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

describe("AgentSettingsPageContent — Automations tab visibility (#139)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the Automations tab to a non-admin owner of a personal agent", async () => {
    mockSession.mockReturnValue({
      data: { user: { id: "u1", role: "member" } },
      isPending: false,
    });
    mockFetchReturning({ ...baseAgent, isPersonal: true });

    render(<AgentSettingsPageContent />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /automations/i })).toBeInTheDocument();
    });
  });

  it("shows the Automations tab to an admin on a shared agent", async () => {
    mockSession.mockReturnValue({
      data: { user: { id: "admin-1", role: "admin" } },
      isPending: false,
    });
    mockFetchReturning({ ...baseAgent, isPersonal: false });

    render(<AgentSettingsPageContent />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /automations/i })).toBeInTheDocument();
    });
  });
});
