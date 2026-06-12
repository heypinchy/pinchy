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
            capabilities: { vision: true, longContext: false, tools: true },
          },
        ],
      },
    ];
    render(<ModelPicker value="" onChange={() => {}} providers={providersWithCaps} />);

    await userEvent.click(screen.getByRole("combobox"));

    expect(screen.getByLabelText("Supports image input")).toBeInTheDocument();
    // documents/audio/video badges were removed with the dead capabilities —
    // they showed wrong information (PDFs work via the pdf tool regardless).
    expect(screen.queryByLabelText("Supports document input")).not.toBeInTheDocument();
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
            capabilities: { vision: false, longContext: false, tools: true },
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

  it("filters out models with UNKNOWN capabilities when filterToCompatible is set — undefined must not pass as compatible", async () => {
    // Covers the join-drift window: a model can appear in /api/providers/models
    // before the 60s-cached capability map knows it. Letting it through could
    // route an image to a text-only model — exactly what the filter prevents.
    const providers = [
      {
        id: "ollama-cloud",
        name: "Ollama Cloud",
        models: [
          { id: "ollama-cloud/brand-new", name: "brand-new" },
          {
            id: "ollama-cloud/qwen3-vl:235b",
            name: "qwen3-vl:235b",
            capabilities: { vision: true, longContext: true, tools: true },
          },
        ],
      },
    ];
    render(
      <ModelPicker
        value=""
        onChange={() => {}}
        providers={providers}
        requiredCapabilities={["vision"]}
        filterToCompatible
      />
    );

    await userEvent.click(screen.getByRole("combobox"));

    expect(screen.getByText("qwen3-vl:235b")).toBeInTheDocument();
    expect(screen.queryByText("brand-new")).not.toBeInTheDocument();
  });

  it("shows a deprecated fallback entry when the current model is no longer in the allowlist", async () => {
    render(
      <ModelPicker
        value="anthropic/removed-model"
        onChange={() => {}}
        providers={providers}
        deprecatedModelId="anthropic/removed-model"
      />
    );

    await userEvent.click(screen.getByRole("combobox"));

    // The text appears in the trigger (selected value) and in the dropdown option.
    const matches = screen.getAllByText(/anthropic\/removed-model \(no longer available\)/i);
    expect(matches.length).toBeGreaterThanOrEqual(1);
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
            capabilities: { vision: false, longContext: false, tools: true },
          },
          {
            id: "anthropic/claude-opus-4-7",
            name: "Claude Opus 4.7",
            capabilities: { vision: true, longContext: false, tools: true },
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
