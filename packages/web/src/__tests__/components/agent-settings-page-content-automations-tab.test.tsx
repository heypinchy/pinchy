// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";

// The Automations tab (#139) is the review-and-activate surface for an agent's
// email workflows. Automations are email-only, and an agent's email access is
// granted on the Permissions tab — which exists only for SHARED agents, and
// only for admins (`showPermissions = isAdmin && !isPersonal`).
//
// This tab used to be gated the other way round (`isAdmin || isPersonal`,
// mirroring Telegram), which put an Automations tab on every personal agent —
// including Smithers — where there is no way to grant email access at all. The
// tab could therefore only ever show an empty mailbox picker and a create form
// that cannot be completed: pure confusion, zero capability.
//
// So the gate is now the SAME condition under which the agent can hold an email
// connection in the first place. These tests pin both halves of that: where it
// must not appear, and that it appears exactly alongside Permissions.
//
// (A non-admin on a shared agent never reaches this page at all — canEdit is
// false and the page redirects to chat — so there is no "visible page without
// the tab" case to assert for them.)

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

  // The Smithers case, and the reason this gate changed: the very first user is
  // an admin, and their own personal agent is the one they open first. Being an
  // admin does not conjure a Permissions tab for a personal agent, so it must
  // not conjure an Automations tab either.
  it("hides the Automations tab on a personal agent, even from an admin", async () => {
    mockSession.mockReturnValue({
      data: { user: { id: "admin-1", role: "admin" } },
      isPending: false,
    });
    mockFetchReturning({ ...baseAgent, isPersonal: true });

    render(<AgentSettingsPageContent />);

    // Wait for the page to actually render its tabs before asserting absence —
    // otherwise this passes on the loading state and proves nothing.
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /general/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole("tab", { name: /automations/i })).not.toBeInTheDocument();
  });

  it("hides the Automations tab from a non-admin owner of a personal agent", async () => {
    mockSession.mockReturnValue({
      data: { user: { id: "u1", role: "member" } },
      isPending: false,
    });
    mockFetchReturning({ ...baseAgent, isPersonal: true });

    render(<AgentSettingsPageContent />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /general/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole("tab", { name: /automations/i })).not.toBeInTheDocument();
  });

  // Pins the coupling itself, not just the outcome: Automations is offered
  // exactly where the email access it depends on can be granted. If someone
  // moves one gate later, this fails rather than silently re-opening the split.
  it("shows the Automations tab to an admin on a shared agent, alongside Permissions", async () => {
    mockSession.mockReturnValue({
      data: { user: { id: "admin-1", role: "admin" } },
      isPending: false,
    });
    mockFetchReturning({ ...baseAgent, isPersonal: false });

    render(<AgentSettingsPageContent />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /automations/i })).toBeInTheDocument();
    });
    expect(screen.getByRole("tab", { name: /permissions/i })).toBeInTheDocument();
  });
});
