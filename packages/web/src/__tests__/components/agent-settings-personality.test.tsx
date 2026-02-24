import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { AgentSettingsPersonality } from "@/components/agent-settings-personality";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/avatar", () => ({
  getAgentAvatarSvg: vi.fn(
    (agent: { avatarSeed: string | null; name: string }) =>
      `data:image/svg+xml;utf8,mock-${agent.avatarSeed ?? agent.name}`
  ),
  generateAvatarSeed: vi.fn().mockReturnValue("new-random-seed"),
}));

vi.mock("@/lib/personality-presets", () => ({
  PERSONALITY_PRESETS: {
    "the-butler": {
      id: "the-butler",
      name: "The Butler",
      description: "Formal, competent, dry humor.",
      soulMd: "Butler soul content",
    },
    "the-professor": {
      id: "the-professor",
      name: "The Professor",
      description: "Patient, thorough.",
      soulMd: "Professor soul content",
    },
    "the-pilot": {
      id: "the-pilot",
      name: "The Pilot",
      description: "Brief, decisive.",
      soulMd: "Pilot soul content",
    },
    "the-coach": {
      id: "the-coach",
      name: "The Coach",
      description: "Warm, encouraging.",
      soulMd: "Coach soul content",
    },
  },
  getPersonalityPreset: vi.fn((id: string) => {
    const presets: Record<string, { id: string; soulMd: string }> = {
      "the-butler": { id: "the-butler", soulMd: "Butler soul content" },
      "the-professor": {
        id: "the-professor",
        soulMd: "Professor soul content",
      },
      "the-pilot": { id: "the-pilot", soulMd: "Pilot soul content" },
      "the-coach": { id: "the-coach", soulMd: "Coach soul content" },
    };
    return presets[id];
  }),
}));

describe("AgentSettingsPersonality", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const defaultProps = {
    agentId: "agent-1",
    agent: {
      avatarSeed: "test-seed",
      name: "Test Agent",
      personalityPresetId: "the-butler" as string | null,
    },
    soulContent: "Butler soul content",
  };

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("renders the current avatar", () => {
    const { container } = render(<AgentSettingsPersonality {...defaultProps} />);
    const avatar = container.querySelector('img[src="data:image/svg+xml;utf8,mock-test-seed"]');
    expect(avatar).toBeInTheDocument();
  });

  it("renders a re-roll button", () => {
    render(<AgentSettingsPersonality {...defaultProps} />);
    expect(screen.getByRole("button", { name: /re-roll/i })).toBeInTheDocument();
  });

  it("clicking re-roll changes avatar without calling API", async () => {
    const { container } = render(<AgentSettingsPersonality {...defaultProps} />);

    await userEvent.click(screen.getByRole("button", { name: /re-roll/i }));

    const newAvatar = container.querySelector(
      'img[src="data:image/svg+xml;utf8,mock-new-random-seed"]'
    );
    expect(newAvatar).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("hides re-roll button when avatarSeed is __smithers__", () => {
    render(
      <AgentSettingsPersonality
        {...defaultProps}
        agent={{ ...defaultProps.agent, avatarSeed: "__smithers__" }}
      />
    );

    expect(screen.queryByRole("button", { name: /re-roll/i })).not.toBeInTheDocument();
  });

  it("renders all 4 personality preset cards", () => {
    render(<AgentSettingsPersonality {...defaultProps} />);

    expect(screen.getByText("The Butler")).toBeInTheDocument();
    expect(screen.getByText("The Professor")).toBeInTheDocument();
    expect(screen.getByText("The Pilot")).toBeInTheDocument();
    expect(screen.getByText("The Coach")).toBeInTheDocument();
  });

  it("shows Customized badge when personalityPresetId is null", () => {
    render(
      <AgentSettingsPersonality
        {...defaultProps}
        agent={{ ...defaultProps.agent, personalityPresetId: null }}
        soulContent="Custom content"
      />
    );

    expect(screen.getByText("Customized")).toBeInTheDocument();
  });

  it("clicking a different preset shows confirmation dialog", async () => {
    render(<AgentSettingsPersonality {...defaultProps} />);

    await userEvent.click(screen.getByText("The Professor"));

    expect(screen.getByText(/this will replace your current soul\.md/i)).toBeInTheDocument();
  });

  it("confirming preset switch updates SOUL.md textarea", async () => {
    render(<AgentSettingsPersonality {...defaultProps} />);

    await userEvent.click(screen.getByText("The Professor"));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(screen.getByRole("textbox")).toHaveValue("Professor soul content");
  });

  it("cancelling preset switch keeps original content", async () => {
    render(<AgentSettingsPersonality {...defaultProps} />);

    await userEvent.click(screen.getByText("The Professor"));
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(screen.getByRole("textbox")).toHaveValue("Butler soul content");
  });

  it("editing SOUL.md clears preset selection when content differs", async () => {
    render(<AgentSettingsPersonality {...defaultProps} />);

    const textarea = screen.getByRole("textbox");
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "Modified content");

    expect(screen.getByText("Customized")).toBeInTheDocument();
  });

  it("renders SOUL.md textarea with current content", () => {
    render(<AgentSettingsPersonality {...defaultProps} />);

    expect(screen.getByRole("textbox")).toHaveValue("Butler soul content");
  });

  it("save sends PATCH and PUT requests", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    render(<AgentSettingsPersonality {...defaultProps} />);

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/agents/agent-1",
        expect.objectContaining({
          method: "PATCH",
        })
      );
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/agents/agent-1/files/SOUL.md",
        expect.objectContaining({
          method: "PUT",
        })
      );
    });
  });

  it("shows success toast after save", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    render(<AgentSettingsPersonality {...defaultProps} />);

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Personality settings saved");
    });
  });

  it("calls onSaved callback after successful save", async () => {
    const onSaved = vi.fn();
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    render(<AgentSettingsPersonality {...defaultProps} onSaved={onSaved} />);

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });
  });
});
