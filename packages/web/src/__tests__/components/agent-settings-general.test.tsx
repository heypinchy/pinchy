import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { AgentSettingsGeneral } from "@/components/agent-settings-general";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

describe("AgentSettingsGeneral", () => {
  const defaultAgent = {
    id: "agent-1",
    name: "Smithers",
    model: "anthropic/claude-sonnet-4-6",
    isPersonal: false,
    tagline: "Your reliable assistant",
  };
  const defaultProviders = [
    {
      id: "anthropic",
      name: "Anthropic",
      models: [
        { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4" },
        { id: "anthropic/claude-opus-4-20250514", name: "Claude Opus 4" },
      ],
    },
    {
      id: "openai",
      name: "OpenAI",
      models: [{ id: "openai/gpt-5.4", name: "GPT-4o" }],
    },
  ];

  it("should render a Name label and input pre-filled with agent name", () => {
    render(
      <AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} onChange={vi.fn()} />
    );

    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/name/i)).toHaveValue("Smithers");
  });

  it("should render tagline input pre-filled with agent tagline", () => {
    render(
      <AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} onChange={vi.fn()} />
    );

    expect(screen.getByLabelText(/tagline/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/tagline/i)).toHaveValue("Your reliable assistant");
  });

  it("should render a Model label and a select trigger", () => {
    render(
      <AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} onChange={vi.fn()} />
    );

    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("should show the currently selected model in the select trigger", () => {
    render(
      <AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} onChange={vi.fn()} />
    );

    expect(screen.getByRole("combobox")).toHaveTextContent("Claude Sonnet 4");
  });

  it("should only show providers that have models", () => {
    const providersWithEmpty = [...defaultProviders, { id: "google", name: "Google", models: [] }];

    render(
      <AgentSettingsGeneral
        agent={defaultAgent}
        providers={providersWithEmpty}
        onChange={vi.fn()}
      />
    );

    // Google should not appear because it has no models
    // The trigger should still show only the selected model
    expect(screen.getByRole("combobox")).toHaveTextContent("Claude Sonnet 4");
  });

  it("should have maxLength attribute on name input", () => {
    render(
      <AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} onChange={vi.fn()} />
    );

    expect(screen.getByLabelText(/name/i)).toHaveAttribute("maxLength", "30");
  });

  describe("canDelete prop", () => {
    it("should render Delete Agent button when canDelete is true", () => {
      render(
        <AgentSettingsGeneral
          agent={defaultAgent}
          providers={defaultProviders}
          canDelete={true}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByRole("button", { name: /delete agent/i })).toBeInTheDocument();
    });

    it("should render Danger Zone heading when canDelete is true", () => {
      render(
        <AgentSettingsGeneral
          agent={defaultAgent}
          providers={defaultProviders}
          canDelete={true}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByText("Danger Zone")).toBeInTheDocument();
    });

    it("should NOT render Delete Agent button when canDelete is false", () => {
      render(
        <AgentSettingsGeneral
          agent={defaultAgent}
          providers={defaultProviders}
          canDelete={false}
          onChange={vi.fn()}
        />
      );

      expect(screen.queryByRole("button", { name: /delete agent/i })).not.toBeInTheDocument();
    });

    it("should NOT render Delete Agent button when canDelete is undefined", () => {
      render(
        <AgentSettingsGeneral
          agent={defaultAgent}
          providers={defaultProviders}
          onChange={vi.fn()}
        />
      );

      expect(screen.queryByRole("button", { name: /delete agent/i })).not.toBeInTheDocument();
    });
  });

  describe("agent type display", () => {
    it("should show 'Shared agent' for non-personal agents", () => {
      render(
        <AgentSettingsGeneral
          agent={{ ...defaultAgent, isPersonal: false }}
          providers={defaultProviders}
          onChange={vi.fn()}
        />
      );
      expect(screen.getByText("Shared agent")).toBeInTheDocument();
      expect(screen.getByText(/memory from all user conversations is shared/i)).toBeInTheDocument();
    });

    it("should show 'Personal agent' for personal agents", () => {
      render(
        <AgentSettingsGeneral
          agent={{ ...defaultAgent, isPersonal: true }}
          providers={defaultProviders}
          onChange={vi.fn()}
        />
      );
      expect(screen.getByText("Personal agent")).toBeInTheDocument();
      expect(screen.getByText(/this agent is private to its owner/i)).toBeInTheDocument();
    });
  });

  describe("model compatibility", () => {
    it("should render incompatible Ollama models as disabled in dropdown", async () => {
      const providersWithIncompat = [
        {
          id: "ollama-local",
          name: "Ollama (Local)",
          models: [
            { id: "ollama/qwen2.5:7b", name: "qwen2.5:7b (7B)", compatible: true as const },
            {
              id: "ollama/phi3:mini",
              name: "phi3:mini (3.8B)",
              compatible: false as const,
              incompatibleReason: "Not compatible — does not support agent tools",
            },
          ],
        },
      ];

      render(
        <AgentSettingsGeneral
          agent={{ ...defaultAgent, model: "ollama/qwen2.5:7b" }}
          providers={providersWithIncompat}
          onChange={vi.fn()}
        />
      );

      // Open the dropdown
      await userEvent.click(screen.getByRole("combobox"));

      // Find all option roles — incompatible model should be aria-disabled
      const options = screen.getAllByRole("option");
      const disabledOption = options.find((o) => o.textContent?.includes("phi3:mini"));
      expect(disabledOption).toBeDefined();
      expect(disabledOption).toHaveAttribute("aria-disabled", "true");
    });

    it("should show incompatibility reason for disabled models", async () => {
      const providersWithIncompat = [
        {
          id: "ollama-local",
          name: "Ollama (Local)",
          models: [
            { id: "ollama/qwen2.5:7b", name: "qwen2.5:7b (7B)", compatible: true as const },
            {
              id: "ollama/phi3:mini",
              name: "phi3:mini (3.8B)",
              compatible: false as const,
              incompatibleReason: "Not compatible — does not support agent tools",
            },
          ],
        },
      ];

      render(
        <AgentSettingsGeneral
          agent={{ ...defaultAgent, model: "ollama/qwen2.5:7b" }}
          providers={providersWithIncompat}
          onChange={vi.fn()}
        />
      );

      await userEvent.click(screen.getByRole("combobox"));
      expect(screen.getByText("Not compatible — does not support agent tools")).toBeInTheDocument();
    });

    it("should not disable cloud provider models without compatible field", async () => {
      render(
        <AgentSettingsGeneral
          agent={defaultAgent}
          providers={defaultProviders}
          onChange={vi.fn()}
        />
      );

      await userEvent.click(screen.getByRole("combobox"));

      // Cloud provider models should not be disabled
      const options = screen.getAllByRole("option");
      const sonnetOption = options.find((o) => o.textContent?.includes("Claude Sonnet 4"));
      expect(sonnetOption).toBeDefined();
      expect(sonnetOption).not.toHaveAttribute("aria-disabled", "true");
    });
  });

  describe("onChange behavior", () => {
    it("should NOT render a Save button", () => {
      const onChange = vi.fn();
      render(
        <AgentSettingsGeneral
          agent={defaultAgent}
          providers={defaultProviders}
          onChange={onChange}
        />
      );

      expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
    });

    it("should call onChange when name field changes", async () => {
      const onChange = vi.fn();
      render(
        <AgentSettingsGeneral
          agent={defaultAgent}
          providers={defaultProviders}
          onChange={onChange}
        />
      );

      await userEvent.clear(screen.getByLabelText(/name/i));
      await userEvent.type(screen.getByLabelText(/name/i), "Jeeves");

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith(
          expect.objectContaining({ name: "Jeeves" }),
          true // isDirty
        );
      });
    });

    it("should call onChange with isDirty=false when values match defaults", () => {
      const onChange = vi.fn();
      render(
        <AgentSettingsGeneral
          agent={defaultAgent}
          providers={defaultProviders}
          onChange={onChange}
        />
      );

      // onChange is called on initial render with isDirty=false
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Smithers",
          tagline: "Your reliable assistant",
          model: "anthropic/claude-sonnet-4-6",
        }),
        false
      );
    });
  });
});
