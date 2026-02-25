import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { AgentSettingsGeneral } from "@/components/agent-settings-general";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

describe("AgentSettingsGeneral", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const defaultAgent = {
    id: "agent-1",
    name: "Smithers",
    model: "anthropic/claude-sonnet-4-20250514",
    isPersonal: false,
    tagline: "Your reliable assistant",
  };
  const defaultProviders = [
    {
      id: "anthropic",
      name: "Anthropic",
      models: [
        { id: "anthropic/claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
        { id: "anthropic/claude-opus-4-20250514", name: "Claude Opus 4" },
      ],
    },
    {
      id: "openai",
      name: "OpenAI",
      models: [{ id: "openai/gpt-4o", name: "GPT-4o" }],
    },
  ];

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch").mockImplementation(vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("should render a Name label and input pre-filled with agent name", () => {
    render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/name/i)).toHaveValue("Smithers");
  });

  it("should render tagline input pre-filled with agent tagline", () => {
    render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

    expect(screen.getByLabelText(/tagline/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/tagline/i)).toHaveValue("Your reliable assistant");
  });

  it("should render a Model label and a select trigger", () => {
    render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("should show the currently selected model in the select trigger", () => {
    render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

    expect(screen.getByRole("combobox")).toHaveTextContent("Claude Sonnet 4");
  });

  it("should only show providers that have models", () => {
    const providersWithEmpty = [...defaultProviders, { id: "google", name: "Google", models: [] }];

    render(<AgentSettingsGeneral agent={defaultAgent} providers={providersWithEmpty} />);

    // Google should not appear because it has no models
    // The trigger should still show only the selected model
    expect(screen.getByRole("combobox")).toHaveTextContent("Claude Sonnet 4");
  });

  it("should render a Save button", () => {
    render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
  });

  it("should show the restart warning text", () => {
    render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

    expect(
      screen.getByText(
        /saving will briefly disconnect all active chats while the agent runtime restarts/i
      )
    ).toBeInTheDocument();
  });

  it("should PATCH the agent API with name and model on save", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "agent-1",
        name: "Smithers",
        model: "anthropic/claude-sonnet-4-20250514",
      }),
    } as Response);

    render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/agents/agent-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Smithers",
          tagline: "Your reliable assistant",
          model: "anthropic/claude-sonnet-4-20250514",
        }),
      });
    });
  });

  it("should send updated name on save", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "agent-1",
        name: "Jeeves",
        model: "anthropic/claude-sonnet-4-20250514",
      }),
    } as Response);

    render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

    const nameInput = screen.getByLabelText(/name/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Jeeves");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/agents/agent-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Jeeves",
          tagline: "Your reliable assistant",
          model: "anthropic/claude-sonnet-4-20250514",
        }),
      });
    });
  });

  it("should show success toast after successful save", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "agent-1",
        name: "Smithers",
        model: "anthropic/claude-sonnet-4-20250514",
      }),
    } as Response);

    render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Agent settings saved");
    });
  });

  it("should show error toast after failed save", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Something went wrong" }),
    } as Response);

    render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Failed to save settings");
    });
  });

  it("should call onSaved callback after successful save", async () => {
    const onSaved = vi.fn();
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "agent-1",
        name: "Smithers",
        model: "anthropic/claude-sonnet-4-20250514",
      }),
    } as Response);

    render(
      <AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} onSaved={onSaved} />
    );

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });
  });

  it("should have maxLength attribute on name input", () => {
    render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

    expect(screen.getByLabelText(/name/i)).toHaveAttribute("maxLength", "30");
  });

  describe("canDelete prop", () => {
    it("should render Delete Agent button when canDelete is true", () => {
      render(
        <AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} canDelete={true} />
      );

      expect(screen.getByRole("button", { name: /delete agent/i })).toBeInTheDocument();
    });

    it("should render Danger Zone heading when canDelete is true", () => {
      render(
        <AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} canDelete={true} />
      );

      expect(screen.getByText("Danger Zone")).toBeInTheDocument();
    });

    it("should NOT render Delete Agent button when canDelete is false", () => {
      render(
        <AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} canDelete={false} />
      );

      expect(screen.queryByRole("button", { name: /delete agent/i })).not.toBeInTheDocument();
    });

    it("should NOT render Delete Agent button when canDelete is undefined", () => {
      render(<AgentSettingsGeneral agent={defaultAgent} providers={defaultProviders} />);

      expect(screen.queryByRole("button", { name: /delete agent/i })).not.toBeInTheDocument();
    });
  });

  describe("agent type display", () => {
    it("should show 'Shared agent' for non-personal agents", () => {
      render(
        <AgentSettingsGeneral
          agent={{ ...defaultAgent, isPersonal: false }}
          providers={defaultProviders}
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
        />
      );
      expect(screen.getByText("Personal agent")).toBeInTheDocument();
      expect(screen.getByText(/this agent is private to its owner/i)).toBeInTheDocument();
    });
  });
});
