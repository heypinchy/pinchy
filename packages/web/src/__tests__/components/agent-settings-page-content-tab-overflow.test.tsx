// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

// #1400: the agent settings tab bar is wider than a phone screen. It must
// scroll on its own instead of pushing the whole settings column sideways,
// and the active tab must be scrolled into view so a deep link to a late
// tab (Diagnostics, Automations) does not land on an invisible selection.

const mockSession = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => mockSession() },
}));

let search = "";
vi.mock("next/navigation", () => ({
  useParams: () => ({ agentId: "agent-1" }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => "/chat/agent-1/settings",
}));

vi.mock("@/components/restart-provider", () => ({
  useRestart: () => ({ triggerRestart: vi.fn() }),
}));

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
vi.mock("@/components/agent-telegram-settings", () => ({ AgentTelegramSettings: () => <div /> }));
vi.mock("@/components/agent-settings-automations", () => ({
  AgentSettingsAutomations: () => <div />,
}));

import { AgentSettingsPageContent } from "@/components/agent-settings-page-content";

const agent = {
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
  isPersonal: false,
};

describe("AgentSettingsPageContent — tab bar overflow (#1400)", () => {
  const scrollIntoView = vi.fn();
  const original = HTMLElement.prototype.scrollIntoView;

  beforeEach(() => {
    vi.clearAllMocks();
    search = "";
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    mockSession.mockReturnValue({
      data: { user: { id: "admin-1", role: "admin" } },
      isPending: false,
    });
    global.fetch = vi.fn().mockImplementation((url: unknown) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(url === "/api/agents/agent-1" ? agent : {}),
      })
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    HTMLElement.prototype.scrollIntoView = original;
  });

  it("lets the tab list own its horizontal overflow instead of the page", async () => {
    render(<AgentSettingsPageContent />);
    const tablist = await screen.findByRole("tablist");

    // Clamped to the column and scrolling on its own.
    expect(tablist).toHaveClass("max-w-full", "overflow-x-auto");
    // A centred row that overflows clips its first tabs out of reach.
    expect(tablist).toHaveClass("justify-start");
    expect(tablist).not.toHaveClass("justify-center");
  });

  it("scrolls the active tab into view without moving the page vertically", async () => {
    search = "tab=diagnostics";
    render(<AgentSettingsPageContent />);
    const diagnostics = await screen.findByRole("tab", { name: "Diagnostics" });

    expect(diagnostics).toHaveAttribute("data-state", "active");
    const calls = scrollIntoView.mock.contexts as Element[];
    expect(calls).toContain(diagnostics);
    const [options] = scrollIntoView.mock.calls.at(calls.indexOf(diagnostics)) ?? [];
    expect(options).toEqual({ block: "nearest", inline: "nearest" });
  });
});
