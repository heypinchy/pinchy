// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// #1216: when the integrations GET fails, the Odoo/email sections never report
// the agent's grants. The permissions draft then carries an empty integration
// list that means "unknown", not "none" — and a save must not answer it with
// DELETE /api/agents/:id/integrations, which wipes every grant the agent has.

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

vi.mock("@/components/agent-settings-general", () => ({ AgentSettingsGeneral: () => <div /> }));
vi.mock("@/components/agent-settings-file", () => ({ AgentSettingsFile: () => <div /> }));
vi.mock("@/components/agent-settings-personality", () => ({
  AgentSettingsPersonality: () => <div />,
}));
// The Permissions tab is stubbed down to a control that emits a dirty draft
// whose `integrationsLoaded` is set by the test.
let integrationsLoaded = true;
vi.mock("@/components/agent-settings-permissions", () => ({
  AgentSettingsPermissions: ({
    onChange,
  }: {
    onChange: (v: Record<string, unknown>, dirty: boolean) => void;
  }) => (
    <button
      onClick={() =>
        onChange(
          {
            allowedTools: ["pinchy_write", "odoo_read"],
            allowedPaths: [],
            integrations: [],
            integrationsLoaded,
            webSearchConfig: {},
            confirm: {},
          },
          true
        )
      }
    >
      change permissions
    </button>
  ),
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
  allowedTools: ["odoo_read"],
  pluginConfig: null,
  tagline: null,
  avatarSeed: null,
  personalityPresetId: null,
  visibility: "restricted",
  groupIds: [],
  isPersonal: false,
};

const fetchMock = vi.fn();

function mockFetch() {
  fetchMock.mockImplementation((url: unknown, init?: { method?: string }) => {
    const path = String(url);
    if (init?.method && init.method !== "GET") {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }
    if (path.endsWith("/api/agents/agent-1")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(agent) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
  });
  global.fetch = fetchMock;
}

async function save() {
  // keepMounted tabs stay in the DOM but hidden, hence fireEvent and hidden queries.
  fireEvent.click(await screen.findByRole("button", { name: "change permissions", hidden: true }));
  fireEvent.click(await screen.findByRole("button", { name: /Save & Restart/i }));
  const dialogButtons = await screen.findAllByRole("button", { name: /Save & Restart/i });
  fireEvent.click(dialogButtons[dialogButtons.length - 1]);
}

function integrationDeletes() {
  return fetchMock.mock.calls.filter(
    ([url, init]) =>
      String(url).endsWith("/api/agents/agent-1/integrations") &&
      (init as { method?: string } | undefined)?.method === "DELETE"
  );
}

function agentPatchBody(): Record<string, unknown> | undefined {
  const call = fetchMock.mock.calls.find(
    ([url, init]) =>
      String(url).endsWith("/api/agents/agent-1") &&
      (init as { method?: string } | undefined)?.method === "PATCH"
  );
  return call ? JSON.parse(String((call[1] as { body: string }).body)) : undefined;
}

const realFetch = global.fetch;

describe("agent settings save — integration grants that were never loaded (#1216)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    integrationsLoaded = true;
    mockFetch();
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it("does not delete the agent's integration grants while a section has not loaded", async () => {
    integrationsLoaded = false;
    render(<AgentSettingsPageContent />);

    await save();

    await waitFor(() => expect(agentPatchBody()).toBeDefined());
    expect(integrationDeletes()).toHaveLength(0);
    expect(agentPatchBody()?.allowedTools).toEqual(["pinchy_write", "odoo_read"]);
  });

  it("still clears integration grants once every section has loaded and reports none", async () => {
    render(<AgentSettingsPageContent />);

    await save();

    await waitFor(() => expect(integrationDeletes()).toHaveLength(1));
  });
});
