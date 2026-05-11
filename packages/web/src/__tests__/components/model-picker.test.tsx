import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom";
import { ModelPicker } from "@/components/model-picker";

const providers = [
  {
    id: "anthropic",
    name: "Anthropic",
    models: [
      { id: "anthropic/claude-opus-4-7", name: "Claude Opus 4.7" },
      { id: "anthropic/claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
    ],
  },
];

describe("ModelPicker", () => {
  it("renders with the current selected model name visible", () => {
    render(
      <ModelPicker value="anthropic/claude-opus-4-7" onChange={() => {}} providers={providers} />
    );
    expect(screen.getByText("Claude Opus 4.7")).toBeInTheDocument();
  });

  it("renders vision icon when model has vision capability", async () => {
    const providersWithCaps = [
      {
        id: "anthropic",
        name: "Anthropic",
        models: [
          {
            id: "anthropic/claude-opus-4-7",
            name: "Claude Opus 4.7",
            capabilities: { vision: true, documents: true, audio: false, video: false },
          },
        ],
      },
    ];
    render(<ModelPicker value="" onChange={() => {}} providers={providersWithCaps} />);

    await userEvent.click(screen.getByRole("combobox"));

    expect(screen.getByLabelText("Supports image input")).toBeInTheDocument();
    expect(screen.getByLabelText("Supports document input")).toBeInTheDocument();
    expect(screen.queryByLabelText("Supports audio input")).not.toBeInTheDocument();
  });

  it("shows amber warning when row violates requiredCapabilities", async () => {
    const providersNoVision = [
      {
        id: "ollama-cloud",
        name: "Ollama Cloud",
        models: [
          {
            id: "ollama-cloud/deepseek-v4-pro",
            name: "DeepSeek V4 Pro",
            capabilities: { vision: false, documents: false, audio: false, video: false },
          },
        ],
      },
    ];
    render(
      <ModelPicker
        value=""
        onChange={() => {}}
        providers={providersNoVision}
        requiredCapabilities={["vision"]}
      />
    );

    await userEvent.click(screen.getByRole("combobox"));

    expect(
      screen.getByLabelText(/doesn't satisfy required capability: vision/i)
    ).toBeInTheDocument();
  });

  it("hides rows with filterToCompatible when they violate requiredCapabilities", async () => {
    const mixedProviders = [
      {
        id: "ollama-cloud",
        name: "Ollama Cloud",
        models: [
          {
            id: "ollama-cloud/deepseek-v4-pro",
            name: "DeepSeek V4 Pro",
            capabilities: { vision: false, documents: false, audio: false, video: false },
          },
          {
            id: "anthropic/claude-opus-4-7",
            name: "Claude Opus 4.7",
            capabilities: { vision: true, documents: true, audio: false, video: false },
          },
        ],
      },
    ];
    render(
      <ModelPicker
        value=""
        onChange={() => {}}
        providers={mixedProviders}
        requiredCapabilities={["vision"]}
        filterToCompatible
      />
    );

    await userEvent.click(screen.getByRole("combobox"));

    expect(screen.queryByText("DeepSeek V4 Pro")).not.toBeInTheDocument();
    expect(screen.getByText("Claude Opus 4.7")).toBeInTheDocument();
  });
});
