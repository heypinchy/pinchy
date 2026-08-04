// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// executeSave() checked `results.some((r) => !r.ok)` and threw the responses
// away, so every failure — 400 validation, 403 permission, 500 EACCES — reached
// the user as the same sentence: "Failed to save some settings".
//
// #1095 is what that costs. Production rejected every agent save for two days
// because a root-owned TOOLS.md denied uid 999 the write; the response said so
// and the client discarded it. The user retried four times, then asked us to
// SSH into the box. AGENTS.md already states the rule this violates: "When a
// client gives up on a response, it must say why. Quote the body."

const mockToastError = vi.fn();
const mockToastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "u1", role: "admin" } } }) },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ agentId: "agent-1" }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/chat/agent-1/settings",
}));

vi.mock("@/components/restart-provider", () => ({
  useRestart: () => ({ triggerRestart: vi.fn() }),
}));

// The General tab is stubbed down to the one thing this test needs: a control
// that marks the tab dirty, which is what enables the Save button.
vi.mock("@/components/agent-settings-general", () => ({
  AgentSettingsGeneral: ({
    onChange,
  }: {
    onChange: (v: Record<string, unknown>, dirty: boolean) => void;
  }) => (
    <button
      onClick={() =>
        onChange(
          {
            name: "Penny",
            tagline: null,
            model: "ollama-cloud/deepseek-v4-pro",
            starterPrompts: [],
          },
          true
        )
      }
    >
      change model
    </button>
  ),
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
vi.mock("@/components/agent-telegram-settings", () => ({ AgentTelegramSettings: () => <div /> }));

import { AgentSettingsPageContent } from "@/components/agent-settings-page-content";

const agent = {
  id: "agent-1",
  name: "Penny",
  model: "ollama-cloud/deepseek-v4-pro",
  allowedTools: [],
  pluginConfig: null,
  tagline: null,
  avatarSeed: null,
  personalityPresetId: null,
  visibility: "restricted",
  groupIds: [],
  isPersonal: false,
};

/** GET everything, and answer the agent PATCH with `patchResponse`. */
function mockFetch(patchResponse: { status: number; body: unknown }) {
  global.fetch = vi.fn().mockImplementation((url: unknown, init?: { method?: string }) => {
    if (init?.method === "PATCH") {
      return Promise.resolve({
        ok: false,
        status: patchResponse.status,
        json: () => Promise.resolve(patchResponse.body),
        text: () => Promise.resolve(JSON.stringify(patchResponse.body)),
      });
    }
    const path = String(url);
    if (path.includes("/api/agents/agent-1")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(agent) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
  });
}

/** Dirty the General tab, then drive the Save + restart-confirm flow. */
async function save(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "change model" }));
  await user.click(await screen.findByRole("button", { name: /Save & Restart/i }));
  // A dirty General tab always needs a restart, so the confirm dialog opens.
  const dialogButtons = await screen.findAllByRole("button", { name: /Save & Restart/i });
  await user.click(dialogButtons[dialogButtons.length - 1]);
}

describe("agent settings save — surfacing why a save failed (#1095)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the server's error message instead of a flat 'Failed to save'", async () => {
    const user = userEvent.setup();
    mockFetch({
      status: 500,
      body: {
        error:
          "Settings were saved, but the agent runtime was not updated: EACCES: permission denied, open '/openclaw-config/workspaces/agent-1/TOOLS.md'",
      },
    });

    render(<AgentSettingsPageContent />);
    await save(user);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled();
    });
    expect(String(mockToastError.mock.calls[0][0])).toContain("EACCES");
  });

  it("surfaces a validation message the same way", async () => {
    // Not an EACCES special case: any refusal the server explains must reach
    // the user, or the next unfamiliar failure costs another debugging session.
    const user = userEvent.setup();
    mockFetch({ status: 400, body: { error: "Greeting message cannot be empty" } });

    render(<AgentSettingsPageContent />);
    await save(user);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled();
    });
    expect(String(mockToastError.mock.calls[0][0])).toContain("Greeting message cannot be empty");
  });

  it("still reports a failure when the response carries no readable body", async () => {
    // A crashed process or a proxy 502 answers with no JSON at all. The
    // fallback must stay a failure — never a silent success.
    const user = userEvent.setup();
    global.fetch = vi.fn().mockImplementation((url: unknown, init?: { method?: string }) => {
      if (init?.method === "PATCH") {
        return Promise.resolve({
          ok: false,
          status: 502,
          json: () => Promise.reject(new Error("Unexpected token < in JSON")),
          text: () => Promise.resolve("<html>Bad Gateway</html>"),
        });
      }
      const path = String(url);
      if (path.includes("/api/agents/agent-1")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(agent) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    });

    render(<AgentSettingsPageContent />);
    await save(user);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled();
    });
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });
});
