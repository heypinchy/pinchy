import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom";
import { RecoveryPanel } from "@/components/recovery-panel";
import type { ModelCapabilities } from "@/lib/model-capabilities/cache";

const baseProps = {
  filename: "screenshot.png",
  capability: "vision" as const,
  agentName: "Smithers",
  agentModel: "ollama-cloud/deepseek-v4-pro",
  canEditAgent: true,
  isAdmin: false,
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      models: [
        {
          id: "anthropic/claude-opus-4-7",
          name: "Claude Opus 4.7",
          capabilities: {
            vision: true,
            documents: true,
            audio: false,
            video: false,
          } as ModelCapabilities,
        },
      ],
    },
  ],
  otherCompatibleAgents: [],
  onUpdateAgent: vi.fn(),
  onRemoveAttachment: vi.fn(),
  onDismiss: vi.fn(),
};

describe("RecoveryPanel", () => {
  it("shows headline and diagnostic when canEditAgent", () => {
    render(<RecoveryPanel {...baseProps} />);
    expect(screen.getByRole("heading")).toBeInTheDocument();
    expect(screen.getByText(/screenshot.png/)).toBeInTheDocument();
  });

  it("shows ModelPicker for users with edit rights", () => {
    render(<RecoveryPanel {...baseProps} />);
    // The ModelPicker renders a combobox
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("hides ModelPicker for users without edit rights", () => {
    render(
      <RecoveryPanel
        {...baseProps}
        canEditAgent={false}
        otherCompatibleAgents={[{ id: "a2", name: "Vision Agent" }]}
      />
    );
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText(/Vision Agent/)).toBeInTheDocument();
  });

  it("shows dismiss button", () => {
    render(<RecoveryPanel {...baseProps} />);
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeInTheDocument();
  });
});
