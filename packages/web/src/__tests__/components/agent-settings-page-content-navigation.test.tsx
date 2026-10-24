// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";

// Agent Settings navigates like the global Settings: a vertical, grouped
// sidebar instead of a row of eight horizontal tabs. Eight peers in one row do
// not fit the page (an admin on a shared agent saw "Diagnostics" cut off), and
// the row hid the one distinction that matters to a user here: some sections
// are DRAFTS saved together by the bar at the bottom, others ACT immediately.
// The groups make that visible, and the save bar follows it.

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

// The General body reports itself dirty when `generalStartsDirty` is set — the
// way a user's half-finished edit would — so the save bar can be observed
// from a section that has no draft of its own.
let generalStartsDirty = false;
vi.mock("@/components/agent-settings-general", () => ({
  AgentSettingsGeneral: ({
    onChange,
  }: {
    onChange: (values: unknown, isDirty: boolean) => void;
  }) => {
    useEffect(() => {
      if (generalStartsDirty) onChange({}, true);
    }, [onChange]);
    return <div />;
  },
}));
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
  AgentSettingsAutomations: () => <div />,
}));

import { AgentSettingsPageContent } from "@/components/agent-settings-page-content";

const baseAgent = {
  id: "agent-1",
  name: "Hermes",
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

function asAdminOnSharedAgent() {
  mockSession.mockReturnValue({
    data: { user: { id: "admin-1", role: "admin" } },
    isPending: false,
  });
  mockFetchReturning({ ...baseAgent, isPersonal: false });
}

function asMemberOnSmithers() {
  mockSession.mockReturnValue({ data: { user: { id: "u1", role: "member" } }, isPending: false });
  mockFetchReturning({ ...baseAgent, name: "Smithers", isPersonal: true });
}

async function renderedTablist() {
  return waitFor(() => screen.getByRole("tablist"));
}

describe("AgentSettingsPageContent — navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generalStartsDirty = false;
  });

  it("navigates with a vertical list, like the global Settings", async () => {
    asAdminOnSharedAgent();
    render(<AgentSettingsPageContent />);

    expect(await renderedTablist()).toHaveAttribute("aria-orientation", "vertical");
  });

  it("groups the sections so drafts, governance and live sections read apart", async () => {
    asAdminOnSharedAgent();
    render(<AgentSettingsPageContent />);
    const nav = await renderedTablist();

    for (const heading of ["Agent", "Governance", "Channels & Automation", "Support"]) {
      expect(within(nav).getByText(heading)).toBeInTheDocument();
    }
    // Every section is still a tab — the grouping is visual, not a new widget.
    expect(
      within(nav)
        .getAllByRole("tab")
        .map((t) => t.textContent?.trim())
    ).toEqual([
      "General",
      "Personality",
      "Instructions",
      "Permissions",
      "Access",
      "Telegram",
      "Automations",
      "Diagnostics",
    ]);
  });

  // A heading over nothing is noise. A member on their Smithers has no
  // Permissions or Access, so no Governance heading either.
  it("drops a group whose sections the viewer does not get", async () => {
    asMemberOnSmithers();
    render(<AgentSettingsPageContent />);
    const nav = await renderedTablist();

    expect(within(nav).queryByText("Governance")).not.toBeInTheDocument();
    expect(within(nav).getByText("Agent")).toBeInTheDocument();
    expect(within(nav).getByText("Channels & Automation")).toBeInTheDocument();
  });

  // On a phone the list and the section cannot sit side by side, so — as in the
  // global Settings — an explicitly chosen section shows a way back to the list,
  // and the bare URL shows the list itself. (Which of the two is hidden at which
  // width is CSS; jsdom has no viewport, so this pins the control, not the layout.)
  it("offers a way back to the section list once a section is chosen", async () => {
    asAdminOnSharedAgent();
    const { unmount } = render(<AgentSettingsPageContent />);
    await renderedTablist();
    expect(
      screen.queryByRole("button", { name: "Back to agent settings" })
    ).not.toBeInTheDocument();
    unmount();

    render(<AgentSettingsPageContent initialTab="automations" />);
    await renderedTablist();
    expect(screen.getByRole("button", { name: "Back to agent settings" })).toBeInTheDocument();
  });

  describe("the save bar", () => {
    it("is there on a draft section", async () => {
      asAdminOnSharedAgent();
      render(<AgentSettingsPageContent initialTab="general" />);
      await renderedTablist();

      expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    });

    // Automations, Telegram and Diagnostics act immediately. A bar saying "All
    // changes saved" with a Save button there promised a step that does not
    // exist.
    it("is gone on a live section with nothing unsaved", async () => {
      asAdminOnSharedAgent();
      render(<AgentSettingsPageContent initialTab="automations" />);
      await renderedTablist();

      expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
      expect(screen.queryByText("All changes saved")).not.toBeInTheDocument();
    });

    // The reason it cannot simply disappear on live sections: an unsaved edit
    // in General must not vanish from view because the user looked at
    // Automations next.
    it("stays on a live section while another section has unsaved changes", async () => {
      generalStartsDirty = true;
      asAdminOnSharedAgent();
      render(<AgentSettingsPageContent initialTab="automations" />);
      await renderedTablist();

      expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();
      // "Save & Restart" here: a General change restarts the agent runtime.
      expect(screen.getByRole("button", { name: /^Save/ })).toBeEnabled();
    });
  });
});
