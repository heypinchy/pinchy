import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import AgentSettingsPage from "@/app/(app)/chat/[agentId]/settings/page";

// Capture onChange callbacks from tab components
let capturedOnChangeGeneral: ((v: unknown, isDirty: boolean) => void) | undefined;
let capturedOnChangePersonality: ((v: unknown, isDirty: boolean) => void) | undefined;
let capturedOnChangeInstructions: ((v: string, isDirty: boolean) => void) | undefined;
let capturedOnChangePermissions: ((v: unknown, isDirty: boolean) => void) | undefined;

vi.mock("@/components/agent-settings-general", () => ({
  AgentSettingsGeneral: (props: { onChange: (v: unknown, isDirty: boolean) => void }) => {
    capturedOnChangeGeneral = props.onChange;
    return <div data-testid="general-tab">General</div>;
  },
}));

vi.mock("@/components/agent-settings-personality", () => ({
  AgentSettingsPersonality: (props: { onChange: (v: unknown, isDirty: boolean) => void }) => {
    capturedOnChangePersonality = props.onChange;
    return <div data-testid="personality-tab">Personality</div>;
  },
}));

vi.mock("@/components/agent-settings-file", () => ({
  AgentSettingsFile: (props: { onChange: (v: string, isDirty: boolean) => void }) => {
    capturedOnChangeInstructions = props.onChange;
    return <div data-testid="instructions-tab">Instructions</div>;
  },
}));

vi.mock("@/components/agent-settings-permissions", () => ({
  AgentSettingsPermissions: (props: { onChange: (v: unknown, isDirty: boolean) => void }) => {
    capturedOnChangePermissions = props.onChange;
    return <div data-testid="permissions-tab">Permissions</div>;
  },
}));

const mockTriggerRestart = vi.fn();
vi.mock("@/components/restart-provider", () => ({
  useRestart: () => ({ triggerRestart: mockTriggerRestart }),
}));

vi.mock("next/navigation", () => ({
  useParams: vi.fn().mockReturnValue({ agentId: "agent-1" }),
  useRouter: vi.fn().mockReturnValue({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: vi.fn().mockReturnValue({
      data: { user: { id: "1", email: "admin@test.com", role: "admin" } },
      isPending: false,
    }),
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const agentData = {
  id: "agent-1",
  name: "Test Agent",
  model: "anthropic/claude-sonnet-4-20250514",
  isPersonal: false,
  allowedTools: [],
  pluginConfig: null,
  tagline: "A test agent",
  avatarSeed: "seed-1",
  personalityPresetId: "the-butler",
};

function mockFetchResponses() {
  return vi.spyOn(global, "fetch").mockImplementation(async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("/api/agents/agent-1/files/SOUL.md")) {
      return { ok: true, json: async () => ({ content: "# Soul" }) } as Response;
    }
    if (urlStr.includes("/api/agents/agent-1/files/AGENTS.md")) {
      return { ok: true, json: async () => ({ content: "# Agents" }) } as Response;
    }
    if (urlStr.includes("/api/agents/agent-1") && !urlStr.includes("/files/")) {
      return { ok: true, json: async () => agentData } as Response;
    }
    if (urlStr.includes("/api/providers/models")) {
      return { ok: true, json: async () => ({ providers: [] }) } as Response;
    }
    if (urlStr.includes("/api/data-directories")) {
      return { ok: true, json: async () => ({ directories: [] }) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
}

describe("AgentSettingsPage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capturedOnChangeGeneral = undefined;
    capturedOnChangePersonality = undefined;
    capturedOnChangeInstructions = undefined;
    capturedOnChangePermissions = undefined;
    mockTriggerRestart.mockClear();
    fetchSpy = mockFetchResponses();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("should render all tab labels", async () => {
    render(<AgentSettingsPage />);
    await waitFor(() => screen.getByText("Agent Settings"));

    expect(screen.getByRole("tab", { name: /general/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /personality/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /instructions/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /permissions/i })).toBeInTheDocument();
  });

  it("should show a disabled save button when nothing is dirty", async () => {
    render(<AgentSettingsPage />);
    await waitFor(() => screen.getByText("Agent Settings"));

    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
    expect(screen.getByText("All changes saved")).toBeInTheDocument();
  });

  it("should show 'Save' button (not restart) when only non-restart tab is dirty", async () => {
    render(<AgentSettingsPage />);
    await waitFor(() => screen.getByText("Agent Settings"));

    // Simulate personality tab reporting dirty
    act(() => {
      capturedOnChangePersonality?.(
        { avatarSeed: "new-seed", presetId: null, soulContent: "New soul" },
        true
      );
    });

    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /save/i });
      expect(btn).toBeInTheDocument();
      expect(btn).not.toHaveTextContent(/restart/i);
    });
  });

  it("should show 'Save & Restart' button when a restart-requiring tab is dirty", async () => {
    render(<AgentSettingsPage />);
    await waitFor(() => screen.getByText("Agent Settings"));

    // Simulate general tab reporting dirty
    act(() => {
      capturedOnChangeGeneral?.(
        { name: "New Name", tagline: "tagline", model: "anthropic/claude-sonnet-4-20250514" },
        true
      );
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /save & restart/i })).toBeInTheDocument();
    });
  });

  it("should show dot indicator on dirty tab", async () => {
    render(<AgentSettingsPage />);
    await waitFor(() => screen.getByText("Agent Settings"));

    act(() => {
      capturedOnChangePersonality?.(
        { avatarSeed: "new-seed", presetId: null, soulContent: "changed" },
        true
      );
    });

    await waitFor(() => {
      // The personality tab trigger should have a dirty indicator
      const personalityTab = screen.getByRole("tab", { name: /personality/i });
      expect(personalityTab.querySelector("[aria-label='unsaved changes']")).toBeInTheDocument();
    });
  });

  it("should call PATCH and file PUT APIs on Save", async () => {
    render(<AgentSettingsPage />);
    await waitFor(() => screen.getByText("Agent Settings"));

    // Mark personality and instructions dirty
    act(() => {
      capturedOnChangePersonality?.(
        { avatarSeed: "new-seed", presetId: null, soulContent: "New soul" },
        true
      );
      capturedOnChangeInstructions?.("New instructions", true);
    });

    await waitFor(() => screen.getByRole("button", { name: /save/i }));

    fetchSpy.mockClear();
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      const calls = fetchSpy.mock.calls.map(([url, opts]) => ({
        url: typeof url === "string" ? url : url.toString(),
        method: (opts as RequestInit)?.method,
        body: (opts as RequestInit)?.body,
      }));

      expect(calls.some((c) => c.url.includes("SOUL.md") && c.method === "PUT")).toBe(true);
      expect(calls.some((c) => c.url.includes("AGENTS.md") && c.method === "PUT")).toBe(true);
    });
  });

  it("should show confirmation dialog before Save & Restart", async () => {
    render(<AgentSettingsPage />);
    await waitFor(() => screen.getByText("Agent Settings"));

    act(() => {
      capturedOnChangeGeneral?.(
        { name: "New Name", tagline: "", model: "anthropic/claude-sonnet-4-20250514" },
        true
      );
    });

    await waitFor(() => screen.getByRole("button", { name: /save & restart/i }));
    await userEvent.click(screen.getByRole("button", { name: /save & restart/i }));

    await waitFor(() => {
      expect(screen.getByText(/apply changes and restart/i)).toBeInTheDocument();
    });
  });

  it("should call triggerRestart after confirming Save & Restart", async () => {
    render(<AgentSettingsPage />);
    await waitFor(() => screen.getByText("Agent Settings"));

    act(() => {
      capturedOnChangeGeneral?.(
        { name: "New Name", tagline: "", model: "anthropic/claude-sonnet-4-20250514" },
        true
      );
    });

    await waitFor(() => screen.getByRole("button", { name: /save & restart/i }));

    fetchSpy.mockClear();
    await userEvent.click(screen.getByRole("button", { name: /save & restart/i }));

    // Confirm in the dialog — the AlertDialogAction button
    await waitFor(() => screen.getByText(/apply changes and restart/i));
    const confirmButtons = screen.getAllByRole("button", { name: /save & restart/i });
    // The dialog's confirm button is the last one rendered
    await userEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => {
      expect(mockTriggerRestart).toHaveBeenCalled();
    });
  });

  it("should set window.onbeforeunload when there are dirty tabs", async () => {
    render(<AgentSettingsPage />);
    await waitFor(() => screen.getByText("Agent Settings"));

    expect(window.onbeforeunload).toBeNull();

    act(() => {
      capturedOnChangeGeneral?.(
        { name: "Changed", tagline: "", model: "anthropic/claude-sonnet-4-20250514" },
        true
      );
    });

    await waitFor(() => {
      expect(window.onbeforeunload).not.toBeNull();
    });
  });

  it("should clear window.onbeforeunload when dirty tabs are cleared after save", async () => {
    render(<AgentSettingsPage />);
    await waitFor(() => screen.getByText("Agent Settings"));

    act(() => {
      capturedOnChangePersonality?.(
        { avatarSeed: "new", presetId: null, soulContent: "changed" },
        true
      );
    });

    await waitFor(() => screen.getByRole("button", { name: /save/i }));

    fetchSpy.mockClear();
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(window.onbeforeunload).toBeNull();
    });
  });

  it("should show nav warning dialog when clicking Back to Chat with dirty state", async () => {
    render(<AgentSettingsPage />);
    await waitFor(() => screen.getByText("Agent Settings"));

    act(() => {
      capturedOnChangePersonality?.(
        { avatarSeed: "new-seed", presetId: null, soulContent: "changed" },
        true
      );
    });

    await waitFor(() => screen.getByRole("button", { name: /save/i }));

    await userEvent.click(screen.getByRole("button", { name: /← back to chat/i }));

    await waitFor(() => {
      expect(screen.getByText(/leave without saving/i)).toBeInTheDocument();
    });
  });
});
