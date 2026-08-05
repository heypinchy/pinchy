// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";

// #1144: the seam between "Save as instruction" in chat and the Instructions
// editor. Each half has its own unit tests; this is the only place that checks
// they meet — a stashed draft actually reaching the textarea, appended to the
// saved instructions rather than replacing them, and consumed on the way so it
// cannot reappear during an unrelated edit later.

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

// Every tab body except the one under test — AgentSettingsFile stays real,
// because "the draft lands in the editor" is the claim.
vi.mock("@/components/agent-settings-general", () => ({ AgentSettingsGeneral: () => <div /> }));
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
import { stashInstructionDraft } from "@/lib/instruction-handoff";

const SAVED = "Answer in English.";

function mockFetch() {
  global.fetch = vi.fn().mockImplementation((url: unknown) => {
    if (url === "/api/agents/agent-1") {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
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
            isPersonal: true,
          }),
      });
    }
    if (url === "/api/agents/agent-1/files/AGENTS.md") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ content: SAVED }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  }) as unknown as typeof fetch;
}

async function renderSettings() {
  render(<AgentSettingsPageContent initialTab="instructions" />);
  return waitFor(() => screen.getByRole("textbox"));
}

describe("AgentSettingsPageContent — a draft carried over from chat (#1144)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    mockSession.mockReturnValue({ data: { user: { id: "u1", role: "admin" } }, isPending: false });
    mockFetch();
  });

  it("appends the stashed draft to the saved instructions in the editor", async () => {
    stashInstructionDraft("agent-1", "Score leads by VUE.");

    const editor = (await renderSettings()) as HTMLTextAreaElement;

    expect(editor.value).toBe("Answer in English.\n\nScore leads by VUE.\n");
  });

  it("consumes the draft, so re-opening the tab shows only what is saved", async () => {
    stashInstructionDraft("agent-1", "Score leads by VUE.");

    const { unmount } = render(<AgentSettingsPageContent initialTab="instructions" />);
    await waitFor(() => screen.getByRole("textbox"));
    expect(window.sessionStorage.getItem("pinchy:instruction-draft:agent-1")).toBeNull();
    unmount();

    const editor = (await renderSettings()) as HTMLTextAreaElement;
    expect(editor.value).toBe(SAVED);
  });

  it("leaves the editor untouched when nothing was carried over", async () => {
    const editor = (await renderSettings()) as HTMLTextAreaElement;

    expect(editor.value).toBe(SAVED);
  });

  it("ignores a draft stashed for a different agent", async () => {
    stashInstructionDraft("agent-2", "meant for someone else");

    const editor = (await renderSettings()) as HTMLTextAreaElement;

    expect(editor.value).toBe(SAVED);
    // and it is still waiting for the agent it was meant for
    expect(window.sessionStorage.getItem("pinchy:instruction-draft:agent-2")).toBe(
      "meant for someone else"
    );
  });
});
