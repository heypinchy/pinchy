import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { AgentSettingsPersonality } from "@/components/agent-settings-personality";

vi.mock("@/components/markdown-editor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    className,
  }: {
    value: string;
    onChange: (v: string) => void;
    className?: string;
  }) => (
    <textarea
      className={`font-mono ${className ?? ""}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
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
  const defaultProps = {
    agentId: "agent-1",
    agent: {
      avatarSeed: "test-seed",
      name: "Test Agent",
      personalityPresetId: "the-butler" as string | null,
    },
    soulContent: "Butler soul content",
    onChange: vi.fn(),
  };

  it("renders the current avatar", () => {
    const { container } = render(<AgentSettingsPersonality {...defaultProps} />);
    const avatar = container.querySelector('img[src="data:image/svg+xml;utf8,mock-test-seed"]');
    expect(avatar).toBeInTheDocument();
  });

  it("renders a re-roll button", () => {
    render(<AgentSettingsPersonality {...defaultProps} />);
    expect(screen.getByRole("button", { name: /re-roll/i })).toBeInTheDocument();
  });

  it("clicking re-roll changes the avatar seed", async () => {
    const { container } = render(<AgentSettingsPersonality {...defaultProps} />);

    await userEvent.click(screen.getByRole("button", { name: /re-roll/i }));

    const newAvatar = container.querySelector(
      'img[src="data:image/svg+xml;utf8,mock-new-random-seed"]'
    );
    expect(newAvatar).toBeInTheDocument();
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

    expect(
      screen.getByText(/this will replace your current personality text/i)
    ).toBeInTheDocument();
  });

  it("confirming preset switch updates SOUL.md textarea", async () => {
    render(<AgentSettingsPersonality {...defaultProps} />);

    await userEvent.click(screen.getByText("The Professor"));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    await userEvent.click(screen.getByRole("button", { name: /customize/i }));
    expect(screen.getByRole("textbox")).toHaveValue("Professor soul content");
  });

  it("cancelling preset switch keeps original content", async () => {
    render(<AgentSettingsPersonality {...defaultProps} />);

    await userEvent.click(screen.getByText("The Professor"));
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await userEvent.click(screen.getByRole("button", { name: /customize/i }));
    expect(screen.getByRole("textbox")).toHaveValue("Butler soul content");
  });

  it("editing SOUL.md clears preset selection when content differs", async () => {
    render(<AgentSettingsPersonality {...defaultProps} />);

    await userEvent.click(screen.getByRole("button", { name: /customize/i }));
    const textarea = screen.getByRole("textbox");
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "Modified content");

    expect(screen.getByText("Customized")).toBeInTheDocument();
  });

  it("does not show SOUL.md textarea by default", () => {
    render(<AgentSettingsPersonality {...defaultProps} />);

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows SOUL.md textarea after clicking Customize button", async () => {
    render(<AgentSettingsPersonality {...defaultProps} />);

    await userEvent.click(screen.getByRole("button", { name: /customize/i }));

    expect(screen.getByRole("textbox")).toHaveValue("Butler soul content");
  });

  it("shows explanation text when SOUL.md editor is revealed", async () => {
    render(<AgentSettingsPersonality {...defaultProps} />);

    await userEvent.click(screen.getByRole("button", { name: /customize/i }));

    expect(screen.getByText(/defines your agent's personality/i)).toBeInTheDocument();
  });

  describe("onChange behavior", () => {
    it("should NOT render a Save button", () => {
      const onChange = vi.fn();
      render(
        <AgentSettingsPersonality
          agentId="agent-1"
          agent={{ avatarSeed: "seed-1", name: "Smithers", personalityPresetId: "the-butler" }}
          soulContent="Butler soul content"
          onChange={onChange}
        />
      );

      expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
    });

    it("should call onChange with current values on mount", () => {
      const onChange = vi.fn();
      render(
        <AgentSettingsPersonality
          agentId="agent-1"
          agent={{ avatarSeed: "seed-1", name: "Smithers", personalityPresetId: "the-butler" }}
          soulContent="Butler soul content"
          onChange={onChange}
        />
      );

      expect(onChange).toHaveBeenCalledWith(
        { avatarSeed: "seed-1", presetId: "the-butler", soulContent: "Butler soul content" },
        false
      );
    });

    it("should call onChange with isDirty=true when avatar is re-rolled", async () => {
      const onChange = vi.fn();
      render(
        <AgentSettingsPersonality
          agentId="agent-1"
          agent={{ avatarSeed: "seed-1", name: "Smithers", personalityPresetId: "the-butler" }}
          soulContent="Butler soul content"
          onChange={onChange}
        />
      );

      await userEvent.click(screen.getByRole("button", { name: /re-roll/i }));

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith(
          expect.objectContaining({ avatarSeed: "new-random-seed" }),
          true
        );
      });
    });
  });
});
